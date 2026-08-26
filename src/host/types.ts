/**
 * Wire vocabulary of the voice capability: what the browser sends, what it gets back, and the
 * settings the two halves share. Kept free of Host value imports so the Client contribution can
 * name these types without pulling the Host plane in.
 * @module @deepseek-ai/dsh-voice/types
 */

/** How the composer control starts and stops a recording. */
export type VoiceInteractionMode = 'toggle' | 'hold'

/** Where a finished transcript lands relative to whatever is already in the draft. */
export type VoiceInsertMode = 'append' | 'replace'

/** One recording uploaded for transcription. */
export interface VoiceTranscribeRequest {
  /**
   * Canonical, unpadded-or-padded standard base64 of the encoded clip. Base64 rather than binary
   * because the RPC gateway carries JSON-safe values only; the Host decodes once and never stores it.
   */
  readonly audioBase64: string
  /** Media type of the decoded bytes, exactly as the recorder reported it. */
  readonly mimeType: string
}

/** A transcription that produced text. */
export interface VoiceTranscribeSuccess {
  readonly ok: true
  /** The recognized text, trimmed. Empty means the clip decoded but carried no speech. */
  readonly text: string
  /** Language the provider reported recognizing, when it reports one. */
  readonly language?: string
  /** Audio duration the provider measured, when it measures one. */
  readonly durationMs?: number
}

/**
 * A transcription that failed, carried as a value rather than thrown.
 *
 * The RPC gateway maps a business exception to the opaque `internal` code with empty details, so a
 * thrown `TranscriptionError` would reach the browser with its classification erased. Returning the
 * failure keeps `code` intact, which is what lets the composer control distinguish "configure a
 * provider" from "try again".
 */
export interface VoiceTranscribeFailure {
  readonly ok: false
  /** The capability's classified failure, plus the two codes this endpoint itself can raise. */
  readonly code: VoiceFailureCode
  /** Operator-facing diagnostic; never a secret. */
  readonly message: string
}

/**
 * Failure classes the browser may receive: the transcription capability's own union, plus
 * `no-provider` for a deployment that mounted no provider and `malformed-audio` for a request whose
 * base64 the Host could not decode.
 */
export type VoiceFailureCode =
  | 'empty-audio'
  | 'unsupported-media-type'
  | 'clip-too-large'
  | 'not-configured'
  | 'provider-unavailable'
  | 'provider-rejected'
  | 'provider-timeout'
  | 'no-provider'
  | 'malformed-audio'

/** Result of one transcription attempt. */
export type VoiceTranscribeResult = VoiceTranscribeSuccess | VoiceTranscribeFailure

/**
 * Everything the composer control needs to configure a recorder and render its own state, answered
 * in one call so a seat does not assemble it from the settings document plus a provider probe.
 */
export interface VoiceCapabilityView {
  /** Whether a provider is mounted at all. False means the deployment composed none. */
  readonly available: boolean
  /** The mounted provider's identity, absent when none is mounted. */
  readonly provider?: string
  /** The model or engine that provider will use, when it reports one. */
  readonly model?: string
  /** Whether a transcription attempted now could reach the provider. */
  readonly ready: boolean
  /** Why {@link ready} is false; absent when ready or when no provider is mounted. */
  readonly detail?: string
  /**
   * Media types the provider accepts, lowercased and without codec parameters. The recorder picks
   * its output format from this list; empty means the provider narrows nothing.
   */
  readonly acceptedMediaTypes: readonly string[]
  /** Longest recording the Host will accept, in seconds. */
  readonly maxClipSeconds: number
  /** Largest decoded clip the Host will accept, in bytes. */
  readonly maxClipBytes: number
  /** The deployment's current start/stop gesture. */
  readonly interactionMode: VoiceInteractionMode
  /** The deployment's current draft-insertion rule. */
  readonly insertMode: VoiceInsertMode
  /** BCP-47 language hint passed to the provider; absent asks the provider to detect. */
  readonly language?: string
  /** Whether a transcript is cleaned up by the session's model before it reaches the draft. */
  readonly polish: boolean
  /** Continuous silence that ends a recording; absent leaves the duration cap as the only bound. */
  readonly silenceStopMs?: number
  /** Interval for provisional in-progress transcripts; absent disables them. */
  readonly liveIntervalMs?: number
}

/** A transcript the session's model rewrote. */
export interface VoicePolishSuccess {
  readonly ok: true
  /** The cleaned-up text. */
  readonly text: string
}

/** Why a cleanup could not run. Carried as a value for the same reason transcription failures are. */
export interface VoicePolishFailure {
  readonly ok: false
  /** `no-model` when no model is selected, `llm-failed` when the request itself failed. */
  readonly code: 'no-model' | 'llm-failed'
  /** Operator-facing diagnostic; never a secret. */
  readonly message: string
}

/**
 * Result of one cleanup attempt.
 *
 * A failure is never fatal to dictation: the caller keeps the raw transcript, which is always
 * usable. Cleanup is an improvement, not a dependency.
 */
export type VoicePolishResult = VoicePolishSuccess | VoicePolishFailure

/**
 * The `voice` settings section as both halves see it: the Host validates it as its plugin `Config`,
 * and the browser card binds a settings scope to exactly this shape.
 */
export interface VoiceSettings {
  /**
   * Longest recording the composer control will make. The Host cannot verify a duration without
   * decoding the audio, so this is the browser's gate and {@link VoiceSettings.maxClipBytes} is the
   * Host's.
   */
  maxClipSeconds: number
  /** Largest decoded clip the Host accepts. The one limit enforced on that side of the boundary. */
  maxClipBytes: number
  /** Whether the control records while held or toggles between clicks. */
  interactionMode: VoiceInteractionMode
  /** Whether a transcript appends to the draft or replaces it. */
  insertMode: VoiceInsertMode
  /** BCP-47 hint passed to the provider; omit to let the provider detect the language. */
  language?: string
  /**
   * Run the raw transcript through the session's own model to remove fillers, restore punctuation,
   * and turn spoken enumerations into lists. Dictation is speech, not prose; this is what makes it
   * read like something a person typed.
   */
  polish: boolean
  /**
   * System prompt for that cleanup. Absent uses the built-in one, which is deliberately conservative
   * — it rewrites nothing it was not asked to.
   */
  polishPrompt?: string
  /**
   * Stop recording after this much continuous silence. Absent disables it, leaving
   * {@link VoiceSettings.maxClipSeconds} as the only bound.
   */
  silenceStopMs?: number
  /**
   * While recording, re-transcribe what has been captured so far every this many milliseconds and
   * show it as provisional text. Absent disables it.
   *
   * Each pass transcribes the clip from the beginning, because a compressed stream's later chunks
   * are not independently decodable. That is cheap against a local binary and BILLED PER PASS
   * against a hosted endpoint, which is why it is opt-in rather than a default.
   */
  liveIntervalMs?: number
}
