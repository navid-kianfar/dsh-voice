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

/**
 * Classify one closed process.
 * @param exitCode - the process exit code; null when it died from a signal.
 * @param signal - the terminating signal; null on a normal exit.
 * @param stderr - collected diagnostics, used only to explain a failure.
 * @returns the classified failure, or undefined when the run succeeded.
 */
export function classifyExit(
  exitCode: number | null,
  signal: string | null,
  stderr: string,
): TranscriptionError | undefined {
  if (exitCode === 0) return undefined
  const how = exitCode ?? `on ${String(signal)}`
  const trimmed = stderr.trim()
  return new TranscriptionError(
    'provider-rejected',
    `whisper.cpp exited ${how}${trimmed === '' ? '' : `: ${trimmed.slice(0, 512)}`}`,
  )
}
