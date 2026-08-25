/**
 * The wire half of the OpenAI-compatible transcription protocol: what the endpoint accepts, how its
 * statuses map onto the capability's failure classes, and what a usable response body looks like.
 * Separated from the provider so every branch is testable without a Cordis context or a network.
 * @module @achasoft/dsh-voice/providers/openai-protocol
 */

import { TranscriptionError, type TranscriptResult } from '../transcription/index.ts'

/**
 * Media types the OpenAI transcription API documents, mapped to the filename extension the
 * multipart part must carry. The endpoint dispatches its decoder on that extension rather than on
 * the part's content type, so a correct extension is a protocol requirement, not a preference.
 */
export const MEDIA_TYPE_EXTENSIONS: Readonly<Record<string, string>> = {
  'audio/flac': 'flac',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/mp4': 'mp4',
  'audio/mpeg': 'mp3',
  'audio/mpga': 'mpga',
  'audio/ogg': 'ogg',
  'audio/oga': 'oga',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/webm': 'webm',
}

/** The accepted media types, derived from the one map so the two can never disagree. */
export const ACCEPTED_MEDIA_TYPES: readonly string[] = Object.freeze(Object.keys(MEDIA_TYPE_EXTENSIONS))

/**
 * Resolve the bare media type, dropping any codec parameter a recorder appended.
 * @param mimeType - the recorder's media type, possibly `audio/webm;codecs=opus`.
 * @returns the lowercased type without parameters.
 */
export function bareMediaType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase()
}

/**
 * Resolve the multipart filename extension for one clip.
 * @param mimeType - the recorder's media type.
 * @returns the extension the endpoint dispatches on.
 * @throws {TranscriptionError} `unsupported-media-type` when the endpoint cannot decode it.
 */
export function mediaTypeExtension(mimeType: string): string {
  const media = bareMediaType(mimeType)
  const extension = MEDIA_TYPE_EXTENSIONS[media]
  if (extension === undefined) {
    throw new TranscriptionError('unsupported-media-type', `endpoint does not accept ${media || mimeType}`)
  }
  return extension
}

/**
 * Map one non-OK response onto a capability failure class.
 *
 * An authorization refusal is `not-configured` rather than `provider-rejected` because the fix is a
 * credential, not a retry — that distinction is the only one a UI must act on differently.
 * @param status - the HTTP status the endpoint returned.
 * @param detail - a bounded excerpt of its body, empty when unreadable.
 * @returns the classified failure to throw.
 */
export function classifyHttpFailure(status: number, detail: string): TranscriptionError {
  if (status === 401 || status === 403) {
    return new TranscriptionError('not-configured', `endpoint rejected the credential (${status})`)
  }
  if (status === 413) {
    return new TranscriptionError('clip-too-large', 'endpoint refused the clip as too large')
  }
  return new TranscriptionError('provider-rejected', `endpoint returned ${status}${detail === '' ? '' : `: ${detail}`}`)
}

/**
 * Validate and project one response body.
 *
 * A wire boundary: the endpoint is a separate process whose contract this package cannot check
 * statically, so the one field the capability needs is validated rather than trusted.
 * @param payload - the parsed JSON body.
 * @returns the transcript plus whatever else the endpoint reported.
 * @throws {TranscriptionError} `provider-rejected` when the body carries no `text` string.
 */
export function parseTranscriptionBody(payload: unknown): TranscriptResult {
  if (typeof payload !== 'object' || payload === null || typeof (payload as { text?: unknown }).text !== 'string') {
    throw new TranscriptionError('provider-rejected', 'endpoint response carries no `text` string')
  }
  const body = payload as { text: string; language?: unknown; duration?: unknown }
  return {
    text: body.text.trim(),
    ...typeof body.language === 'string' ? { language: body.language } : {},
    ...typeof body.duration === 'number' && Number.isFinite(body.duration)
      ? { durationMs: Math.round(body.duration * 1000) }
      : {},
  }
}
