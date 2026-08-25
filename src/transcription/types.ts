/**
 * Pure value types of the transcription capability, free of Cordis value imports so a consumer can
 * name what it sends and receives without loading the service.
 * @module @deepseek-ai/dsh-transcription/types
 */

/** One complete encoded recording handed to a provider. */
export interface AudioClip {
  /**
   * The encoded bytes exactly as the recorder produced them; never re-encoded by a caller. Backed
   * by a plain `ArrayBuffer` rather than a shared one, because providers hand the bytes to APIs
   * (`Blob`, `writeFile`) that refuse shared memory.
   */
  readonly data: Uint8Array<ArrayBuffer>
  /**
   * IANA media type of {@link data}, including any codec parameter the recorder reported (for
   * example `audio/webm;codecs=opus`). Providers match on it and reject what they cannot decode,
   * so a caller passes the recorder's own string through rather than normalizing it.
   */
  readonly mimeType: string
  /**
   * BCP-47 language hint. Absent asks the provider to detect the language, which every supported
   * provider can do at some accuracy cost; a hint is the caller's way to trade that away.
   */
  readonly language?: string
}

/** One completed transcription. */
export interface TranscriptResult {
  /**
   * The recognized text, already trimmed. Empty means the provider decoded the clip and found no
   * speech — a success the caller renders as "nothing heard", not a failure.
   */
  readonly text: string
  /** The language the provider reports having recognized, when it reports one. */
  readonly language?: string
  /** Audio duration the provider measured, when it measures one. */
  readonly durationMs?: number
}

/** What a mounted provider is, and whether it can run right now. */
export interface TranscriptionProviderInfo {
  /**
   * Stable provider identifier, equal to the providing plugin's registered name. A configuration
   * surface displays it and keys help text on it.
   */
  readonly provider: string
  /** The model or engine the provider will use, when that choice is the provider's to report. */
  readonly model?: string
  /**
   * Whether a transcription attempted now could reach the provider. False means configuration is
   * incomplete — a missing credential, endpoint, or model file — and {@link detail} says which.
   */
  readonly ready: boolean
  /** Human-readable reason {@link ready} is false; never a secret, and absent when ready. */
  readonly detail?: string
  /**
   * Media types this provider accepts, lowercased and without codec parameters (`audio/webm`). A
   * recorder picks its output format from this list, so an empty list means the provider accepts
   * whatever it is given and the caller may not narrow on it.
   */
  readonly acceptedMediaTypes: readonly string[]
}
