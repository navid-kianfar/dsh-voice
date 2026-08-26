/**
 * Microphone capture and clip preparation. React-free by the client layering rule: this module owns
 * device access, recording lifetime, loudness metering, and encoding, and hands back plain data.
 *
 * Format is negotiated, not assumed. The recorder captures in whatever container the browser
 * supports and re-encodes to 16 kHz mono WAV only when the mounted provider accepts nothing the
 * browser can produce directly — which is how a local whisper.cpp build gets the one format it reads
 * without putting an audio converter on the Host.
 * @module @achasoft/dsh-voice/client/recorder
 */

import {
  WAV_SAMPLE_RATE,
  bareMediaType,
  chooseDirectContainer,
  encodeWav,
  toBase64,
} from './audio.ts'

/** One finished recording, ready for the transcription endpoint. */
export interface RecordedClip {
  /** Standard base64 of the encoded bytes. */
  readonly base64: string
  /** Media type of the decoded bytes, without codec parameters. */
  readonly mimeType: string
  /** Wall-clock length of the recording. */
  readonly durationMs: number
}

/** A live recording the caller can finish or abandon. */
export interface RecordingSession {
  /**
   * Stop capture and produce the clip.
   * @returns the encoded recording.
   */
  stop(): Promise<RecordedClip>
  /** Abandon capture, release the microphone, and produce nothing. */
  cancel(): void
}

/** Why a recording could not start or finish. */
export type RecorderFailureCode =
  | 'permission-denied'
  | 'no-device'
  | 'unsupported-browser'
  | 'no-common-format'
  | 'empty-recording'

/** A recording failure the control renders as its own message. */
export class RecorderError extends Error {
  override readonly name = 'RecorderError'

  /**
   * @param code - stable failure class the control switches on.
   * @param message - operator-facing diagnostic.
   * @param options - standard Error options carrying the browser's own cause.
   */
  constructor(readonly code: RecorderFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/** Why capture ended on its own rather than by a gesture. */
export type AutoStopReason = 'silence' | 'limit'

/** What the caller must tell the recorder before it can pick a format. */
export interface RecordingRequest {
  /** Media types the mounted provider accepts; empty means it narrows nothing. */
  readonly accepted: readonly string[]
  /** Hard stop for the recording, enforced by the recorder itself. */
  readonly maxMs: number
  /** Specific input device, or undefined for the system default. */
  readonly deviceId?: string
  /** End capture after this much continuous near-silence; undefined disables it. */
  readonly silenceStopMs?: number
  /** Emit a provisional cumulative clip this often; undefined disables it. */
  readonly liveIntervalMs?: number
  /**
   * Current input loudness, 0–1, roughly 20 times a second. Purely for display: the caller must not
   * infer speech from it, because the silence decision already lives here.
   */
  readonly onLevel?: (level: number) => void
  /**
   * A cumulative clip covering everything captured so far, for provisional transcription. Fired only
   * when {@link liveIntervalMs} is set.
   */
  readonly onInterim?: (clip: RecordedClip) => void
  /** Capture ended on its own; the caller still calls {@link RecordingSession.stop}. */
  readonly onAutoStop?: (reason: AutoStopReason) => void
}

/**
 * Loudness below which a frame counts as silence. Chosen against normalized RMS of 8-bit
 * time-domain samples: room tone on a laptop mic sits well under this, speech well over.
 */
const SILENCE_LEVEL = 0.02

/** How often loudness is sampled. Fast enough to look live, slow enough to stay off the main thread. */
const METER_INTERVAL_MS = 50

/**
 * Decode a recorded blob and re-encode it as 16 kHz mono WAV. Resampling and downmixing both happen
 * inside one `OfflineAudioContext` render, so no sample-rate maths lives here.
 * @param blob - the browser's recording.
 * @returns the WAV bytes.
 */
async function toWav(blob: Blob): Promise<Uint8Array<ArrayBuffer>> {
  const decodeContext = new AudioContext()
  try {
    const decoded = await decodeContext.decodeAudioData(await blob.arrayBuffer())
    const frames = Math.max(1, Math.ceil(decoded.duration * WAV_SAMPLE_RATE))
    const offline = new OfflineAudioContext(1, frames, WAV_SAMPLE_RATE)
    const source = offline.createBufferSource()
    source.buffer = decoded
    source.connect(offline.destination)
    source.start()
    const rendered = await offline.startRendering()
    return encodeWav(rendered.getChannelData(0), WAV_SAMPLE_RATE)
  } finally {
    void decodeContext.close()
  }
}

/**
 * Open the microphone and begin recording.
 *
 * The returned session owns the media stream: both `stop()` and `cancel()` release it, and the
 * caller must call one of them or the microphone indicator stays lit.
 * @param request - accepted formats, bounds, device, and the display callbacks.
 * @returns the live session.
 */
export async function startRecording(request: RecordingRequest): Promise<RecordingSession> {
  // `mediaDevices` is absent outside a secure context, which lib.dom's non-optional typing does not
  // express — an `in` check is the only honest guard.
  if (typeof MediaRecorder === 'undefined' || !('mediaDevices' in navigator)) {
    throw new RecorderError('unsupported-browser', 'this browser cannot record audio')
  }
  const direct = chooseDirectContainer(request.accepted, type => MediaRecorder.isTypeSupported(type))
  const wantsWav = direct === undefined
  if (wantsWav && request.accepted.length > 0 && !request.accepted.includes('audio/wav')) {
    throw new RecorderError('no-common-format', 'the transcription provider accepts no format this browser can record')
  }
  // Without a direct match the clip is re-encoded, so any supported container will do as the source.
  const container = direct ?? chooseDirectContainer([], type => MediaRecorder.isTypeSupported(type))
  if (container === undefined) {
    throw new RecorderError('unsupported-browser', 'this browser supports no known audio container')
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: request.deviceId === undefined ? true : { deviceId: { exact: request.deviceId } },
    })
  } catch (error) {
    const reason = error instanceof DOMException ? error.name : ''
    if (reason === 'NotAllowedError' || reason === 'SecurityError') {
      throw new RecorderError('permission-denied', 'microphone access was denied', { cause: error })
    }
    throw new RecorderError('no-device', 'no microphone is available', { cause: error })
  }

  const recorder = new MediaRecorder(stream, { mimeType: container })
  const chunks: Blob[] = []
  recorder.addEventListener('dataavailable', (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  })
  const startedAt = performance.now()

  /** Encode whatever has been captured so far into the provider's format. */
  const encode = async (durationMs: number): Promise<RecordedClip> => {
    const blob = new Blob(chunks, { type: container })
    if (blob.size === 0) throw new RecorderError('empty-recording', 'the recording captured no audio')
    const bytes = wantsWav ? await toWav(blob) : new Uint8Array(await blob.arrayBuffer())
    return { base64: toBase64(bytes), mimeType: wantsWav ? 'audio/wav' : bareMediaType(container), durationMs }
  }

  // The meter also owns the silence decision, so loudness is measured once and read twice.
  const audio = new AudioContext()
  const analyser = audio.createAnalyser()
  analyser.fftSize = 1024
  audio.createMediaStreamSource(stream).connect(analyser)
  const frame = new Uint8Array(analyser.fftSize)
  let quietMs = 0
  let heardSpeech = false
  let ended: AutoStopReason | undefined

  const finish = (reason: AutoStopReason): void => {
    if (ended !== undefined) return
    ended = reason
    if (recorder.state === 'recording') recorder.stop()
    request.onAutoStop?.(reason)
  }

  const meter = setInterval(() => {
    analyser.getByteTimeDomainData(frame)
    let sum = 0
    for (const sample of frame) {
      const centred = (sample - 128) / 128
      sum += centred * centred
    }
    const level = Math.sqrt(sum / frame.length)
    request.onLevel?.(Math.min(1, level * 4))
    if (level >= SILENCE_LEVEL) {
      heardSpeech = true
      quietMs = 0
      return
    }
    // Silence only ends a recording that has heard something: otherwise a slow start would cut the
    // person off before their first word.
    if (!heardSpeech || request.silenceStopMs === undefined) return
    quietMs += METER_INTERVAL_MS
    if (quietMs >= request.silenceStopMs) finish('silence')
  }, METER_INTERVAL_MS)

  const cap = setTimeout(() => { finish('limit') }, request.maxMs)

  // A cumulative pass, because a compressed stream's later chunks are not independently decodable.
  // Overlapping passes are skipped rather than queued: a slow provider must not build a backlog.
  let interimBusy = false
  const interim = request.liveIntervalMs === undefined || request.onInterim === undefined
    ? undefined
    : setInterval(() => {
      if (interimBusy || chunks.length === 0 || ended !== undefined) return
      interimBusy = true
      void encode(Math.round(performance.now() - startedAt))
        .then((clip) => { if (ended === undefined) request.onInterim?.(clip) })
        .catch(() => {
          // A provisional pass that cannot encode yet is not a failure the person needs to see; the
          // next tick tries again and the final clip is produced by stop().
        })
        .finally(() => { interimBusy = false })
    }, request.liveIntervalMs)

  // `timeslice` is what makes chunks arrive DURING the recording; without it the whole recording
  // lands in one blob at stop and no interim pass could ever see anything.
  recorder.start(request.liveIntervalMs === undefined ? undefined : Math.min(1000, request.liveIntervalMs))

  const settled = new Promise<void>((resolve) => {
    recorder.addEventListener('stop', () => resolve(), { once: true })
  })

  const release = (): void => {
    clearInterval(meter)
    clearTimeout(cap)
    if (interim !== undefined) clearInterval(interim)
    void audio.close()
    for (const track of stream.getTracks()) track.stop()
  }

  return {
    async stop(): Promise<RecordedClip> {
      if (recorder.state === 'recording') recorder.stop()
      await settled
      release()
      return encode(Math.round(performance.now() - startedAt))
    },
    cancel(): void {
      ended = ended ?? 'limit'
      if (recorder.state === 'recording') recorder.stop()
      release()
    },
  }
}

/**
 * List the input devices the browser will name. Labels are empty until the user has granted
 * microphone access at least once, which is a browser privacy rule rather than a bug.
 * @returns the available audio inputs, or an empty list when enumeration is unavailable.
 */
export async function listMicrophones(): Promise<readonly MediaDeviceInfo[]> {
  if (!('mediaDevices' in navigator)) return []
  const devices = await navigator.mediaDevices.enumerateDevices()
  return devices.filter(device => device.kind === 'audioinput')
}
