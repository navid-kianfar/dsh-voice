/**
 * The invocation half of the local whisper.cpp protocol: the argument vector and how a closed
 * process maps onto the capability's failure classes. Separated from the provider so both are
 * testable without spawning anything.
 * @module @achasoft/dsh-voice/providers/whisper-protocol
 */

import { TranscriptionError } from '../transcription/index.ts'

/** The only media type the binary decodes. */
export const ACCEPTED_MEDIA_TYPES: readonly string[] = Object.freeze(['audio/wav'])

/** The inputs the argument vector varies on. */
export interface WhisperInvocation {
  /** Path to the compiled binary. */
  readonly binaryPath: string
  /** Path to the model file the binary loads. */
  readonly modelPath: string
  /** Path to the scratch WAV written for this call. */
  readonly wavPath: string
  /** Threads the binary may use; absent leaves whisper.cpp's own default. */
  readonly threads?: number
  /** BCP-47 hint; absent asks the binary to detect the language. */
  readonly language?: string
}

/**
 * Build the argument vector for one transcription.
 *
 * Timestamps and progress chatter are suppressed because both would land in the text this provider
 * returns — stdout IS the transcript.
 * @param invocation - binary, model, clip, and the two optional knobs.
 * @returns argv with the executable at index 0.
 */
export function buildWhisperArgv(invocation: WhisperInvocation): readonly string[] {
  return [
    invocation.binaryPath,
    '-m', invocation.modelPath,
    '-f', invocation.wavPath,
    '--no-timestamps',
    '--no-prints',
    ...invocation.threads === undefined ? [] : ['-t', String(invocation.threads)],
    ...invocation.language === undefined ? [] : ['-l', invocation.language],
  ]
}

/** Longest diagnostic carried into a failure message; a runaway stderr must not become the message. */
const MAX_DIAGNOSTIC_CHARS = 512

/**
 * whisper-cli's fatal-diagnostic lines. The binary exits 0 after `failed to read audio` (verified
 * against 1.9.4 on a truncated and on a non-audio WAV), so the exit code alone reports an unreadable
 * clip as a successful transcription of nothing. `error:` is the prefix its `main` prints before
 * every early return; the `failed to …` loader lines precede it and name the stage.
 */
const FAILURE_LINE = /^(?:error: .*|.*failed to (?:read audio|initialize whisper context).*)$/gmu

/**
 * Keep the end of a diagnostic, where the reason for a failure is. whisper-cli prints dozens of ggml
 * backend-initialisation lines before it does anything, so the head of stderr is the same noise on
 * every run and the actual error is the last line.
 * @param text - collected diagnostics.
 * @returns at most {@link MAX_DIAGNOSTIC_CHARS} characters from the end, trimmed.
 */
function diagnosticTail(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= MAX_DIAGNOSTIC_CHARS ? trimmed : trimmed.slice(-MAX_DIAGNOSTIC_CHARS).trimStart()
}

/**
 * Classify one closed process.
 * @param exitCode - the process exit code; null when it died from a signal.
 * @param signal - the terminating signal; null on a normal exit.
 * @param stderr - collected diagnostics (the subprocess seam retains their tail), used to explain a
 *   failure and to detect the failures whisper-cli reports with exit code 0.
 * @returns the classified failure, or undefined when the run succeeded.
 */
export function classifyExit(
  exitCode: number | null,
  signal: string | null,
  stderr: string,
): TranscriptionError | undefined {
  if (exitCode === 0) {
    const failures = stderr.match(FAILURE_LINE)
    if (failures === null) return undefined
    return new TranscriptionError('provider-rejected', `whisper.cpp failed: ${diagnosticTail(failures.join('\n'))}`)
  }
  const how = exitCode ?? `on ${String(signal)}`
  const tail = diagnosticTail(stderr)
  return new TranscriptionError(
    'provider-rejected',
    `whisper.cpp exited ${how}${tail === '' ? '' : `: ${tail}`}`,
  )
}

/** Samples per loudness window at the provider's 16 kHz: 30 ms, about one phoneme. */
const RMS_WINDOW_SAMPLES = 480

/**
 * Measure the loudest short window of a 16-bit PCM WAV.
 *
 * The loudest window rather than the whole-clip RMS: one short word in several seconds of room tone
 * averages down to the level of silence, but its own window does not. Chunks are walked rather than
 * assuming a 44-byte header, because WAV writers other than this plugin's encoder add `LIST`, `FLLR`,
 * and similar chunks before `data`.
 * @param bytes - the clip as uploaded.
 * @returns peak RMS on a 0–1 scale, or undefined when the bytes are not 16-bit PCM WAV — an input
 *   this function cannot judge, which is left for the binary to accept or reject.
 */
export function wavPeakRms(bytes: Uint8Array): number | undefined {
  if (bytes.byteLength < 12) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag = (offset: number): string => String.fromCharCode(
    view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3),
  )
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined

  let pcm16 = false
  let offset = 12
  while (offset + 8 <= bytes.byteLength) {
    const id = tag(offset)
    const size = view.getUint32(offset + 4, true)
    const body = offset + 8
    if (id === 'fmt ' && body + 16 <= bytes.byteLength) {
      pcm16 = view.getUint16(body, true) === 1 && view.getUint16(body + 14, true) === 16
    }
    if (id === 'data') {
      if (!pcm16) return undefined
      return peakWindowRms(view, body, Math.min(size, bytes.byteLength - body) >> 1)
    }
    // RIFF pads odd-sized chunks to an even boundary.
    offset = body + size + (size & 1)
  }
  return undefined
}

/**
 * The loudest {@link RMS_WINDOW_SAMPLES}-sample window of little-endian int16 samples.
 * @param view - the clip.
 * @param start - byte offset of the first sample.
 * @param samples - sample count.
 * @returns peak RMS on a 0–1 scale; 0 for an empty data chunk.
 */
function peakWindowRms(view: DataView, start: number, samples: number): number {
  let peak = 0
  for (let first = 0; first < samples; first += RMS_WINDOW_SAMPLES) {
    const count = Math.min(RMS_WINDOW_SAMPLES, samples - first)
    let sum = 0
    for (let index = 0; index < count; index++) {
      const sample = view.getInt16(start + (first + index) * 2, true) / 0x8000
      sum += sample * sample
    }
    peak = Math.max(peak, Math.sqrt(sum / count))
  }
  return peak
}
