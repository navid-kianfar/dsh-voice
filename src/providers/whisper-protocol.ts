/**
 * The invocation half of the local whisper.cpp protocol: the argument vector and how a closed
 * process maps onto the capability's failure classes. Separated from the provider so both are
 * testable without spawning anything.
 * @module @achasoft/dsh-voice/providers/whisper-protocol
 */

import { isAbsolute, join } from 'node:path'
import { TranscriptionError } from '../transcription/index.ts'

/** The only media type the binary decodes. */
export const ACCEPTED_MEDIA_TYPES: readonly string[] = Object.freeze(['audio/wav'])

/**
 * whisper-cli's own spelling of "detect the spoken language". Passed explicitly because omitting
 * `-l` does NOT detect: 1.9.4's `--help` lists the flag's default as `en`, so a multilingual model
 * given no hint transcribes every language as if it were English. An English-only `.en` model
 * ignores `auto` with a stderr warning and still exits 0 (verified against 1.9.4 with ggml-base.en).
 */
export const AUTO_DETECT_LANGUAGE = 'auto'

/** The home-directory prefix a configured path may start with. */
const HOME_PREFIX = '~'

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
  /** BCP-47 hint; absent or blank asks the binary to detect the language. */
  readonly language?: string
}

/** A configured model path, resolved the way the binary will receive it — or why it cannot be. */
export type ModelPathResolution =
  | { readonly kind: 'resolved'; readonly path: string }
  | { readonly kind: 'unusable'; readonly detail: string }

/**
 * Resolve the configured model path once, for both the readiness probe and the argument vector, so
 * the file `describe()` vouches for is the file the binary loads.
 *
 * A leading `~` is expanded because the binary is spawned without a shell and would otherwise look
 * for a directory literally named `~`. A relative path is refused rather than resolved: the binary
 * runs with the per-call scratch directory as its working directory, so no relative path could ever
 * name the intended file — the same reason the subprocess seam refuses relative executables.
 * @param configured - `modelPath` exactly as the deployment wrote it.
 * @param home - the Host user's home directory.
 * @returns the absolute path, or an operator-facing reason the path cannot be used.
 */
export function resolveModelPath(configured: string, home: string): ModelPathResolution {
  const trimmed = configured.trim()
  if (trimmed === '') {
    return { kind: 'unusable', detail: 'no model configured: set modelPath on the voice-whisper-cpp row' }
  }
  if (trimmed === HOME_PREFIX) return { kind: 'resolved', path: home }
  if (trimmed.startsWith(`${HOME_PREFIX}/`)) {
    const rest = trimmed.slice(HOME_PREFIX.length + 1)
    return { kind: 'resolved', path: join(home, rest) }
  }
  if (isAbsolute(trimmed)) return { kind: 'resolved', path: trimmed }
  return { kind: 'unusable', detail: `model path must be absolute or start with ~/: ${configured}` }
}

/**
 * Build the argument vector for one transcription.
 *
 * Timestamps and progress chatter are suppressed because both would land in the text this provider
 * returns — stdout IS the transcript. The language is always passed; see {@link AUTO_DETECT_LANGUAGE}.
 * @param invocation - binary, model, clip, and the two optional knobs.
 * @returns argv with the executable at index 0.
 */
export function buildWhisperArgv(invocation: WhisperInvocation): readonly string[] {
  const hint = invocation.language?.trim() ?? ''
  const language = hint === '' ? AUTO_DETECT_LANGUAGE : hint
  return [
    invocation.binaryPath,
    '-m', invocation.modelPath,
    '-f', invocation.wavPath,
    '--no-timestamps',
    '--no-prints',
    ...invocation.threads === undefined ? [] : ['-t', String(invocation.threads)],
    '-l', language,
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
