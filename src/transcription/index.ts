/**
 * Speech-to-text Service Definition. `ctx.transcription` defines WHAT transcription does — turn one
 * encoded audio clip into text — without saying HOW; a provider plugin supplies the mechanism.
 *
 * The capability is deliberately narrow. A clip is a complete recording held in memory for the
 * lifetime of one call: the definition has no streaming verb, no session vocabulary, and no
 * persistence, because a transcript reaches the product as composer text a person edits before
 * sending, never as durable state of its own.
 * @module @deepseek-ai/dsh-transcription
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AudioClip, TranscriptResult, TranscriptionProviderInfo } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    transcription: TranscriptionEngine
  }
}

/**
 * Stable failure classes every provider maps its own vocabulary onto. Consumers switch on `code`
 * rather than parsing messages, so a provider swap cannot change how a caller reacts.
 *
 * `not-configured` is the one class a UI must distinguish: it means the deployment mounted a
 * provider that still lacks a credential, endpoint, or model, so the fix is configuration rather
 * than a retry.
 */
export type TranscriptionErrorCode =
  | 'empty-audio'
  | 'unsupported-media-type'
  | 'clip-too-large'
  | 'not-configured'
  | 'provider-unavailable'
  | 'provider-rejected'
  | 'provider-timeout'

/** One classified transcription failure. */
export class TranscriptionError extends Error {
  override readonly name = 'TranscriptionError'

  /**
   * Create one classified failure.
   * @param code - stable failure class the caller switches on.
   * @param message - provider diagnostic retained as the Error message.
   * @param options - standard Error options, carrying the provider cause when one exists.
   */
  constructor(readonly code: TranscriptionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
  }
}

/**
 * Narrow an unknown rejection to this capability's classified failure.
 * @param value - the caught value.
 * @returns whether the value is a {@link TranscriptionError}.
 */
export function isTranscriptionError(value: unknown): value is TranscriptionError {
  return value instanceof TranscriptionError
}

/**
 * The transcription capability's Service Definition.
 *
 * A provider extends this class and registers itself as `ctx.transcription`. Exactly one provider
 * is mounted at a time — the Cordis service key is the arbiter, so a composition that mounts two
 * fails loudly at load rather than silently preferring one.
 */
export abstract class TranscriptionEngine extends Service {
  /**
   * Bind the provider to the capability's service key.
   * @param ctx - registrant context the provider was applied to.
   */
  constructor(ctx: Context) {
    super(ctx, 'transcription')
  }

  /**
   * Transcribe one complete clip.
   *
   * Implementations reject with {@link TranscriptionError}; every other rejection is a defect. A
   * provider that finds only silence returns empty `text` rather than failing, because "nothing was
   * said" is a successful outcome the caller renders differently from an error.
   * @param clip - the complete encoded recording.
   * @param signal - caller-owned cancellation; implementations abandon in-flight work when it fires.
   * @returns the recognized text and whatever the provider could report about it.
   */
  abstract transcribe(clip: AudioClip, signal: AbortSignal): Promise<TranscriptResult>

  /**
   * Report what this provider is and whether it can run right now.
   *
   * Configuration surfaces call this to tell "no provider mounted" apart from "mounted but missing
   * a key", without attempting a transcription. It reports readiness, never a secret.
   * @returns the provider's identity and current readiness.
   */
  abstract describe(): Promise<TranscriptionProviderInfo>
}
