/**
 * The voice capability's Consumer half on the Host: one Remote endpoint the browser calls with a
 * recorded clip, and the settings section that owns the deployment's voice preferences.
 *
 * Nothing here is model-facing. A transcript becomes composer text a person reads, edits, and sends
 * as an ordinary user message, so the capability adds no prompt, no tool, and no session event —
 * and the audio itself is decoded, transcribed, and discarded inside one call.
 * @module @deepseek-ai/dsh-voice
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection, settingsNamespace } from './settings-section.ts'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { isTranscriptionError } from '../transcription/index.ts'
import { decodeAudio, decodedByteLength } from './decode.ts'
import { TranscriptionGate } from './transcription-gate.ts'
import type {} from '../transcription/index.ts'
import type {
  VoiceCapabilityView,
  VoicePolishResult,
  VoiceSettings,
  VoiceTranscribeRequest,
  VoiceTranscribeResult,
} from './types.ts'

export type * from './types.ts'

/** The settings namespace both halves of this plugin address; the browser card joins on it. */
export const VOICE_SETTINGS_NAMESPACE = settingsNamespace('voice')

/** Deployment configuration for the voice capability; the `voice` settings section's own shape. */
export type Config = VoiceSettings

declare module '@deepseek-ai/cordis' {
  interface Context {
    voice: VoiceService
  }
}

/**
 * The built-in cleanup instruction. Deliberately conservative: dictation software that rewrites
 * meaning is worse than dictation software that leaves a stray "um" in, because the person cannot
 * tell which words are theirs any more.
 */
const DEFAULT_POLISH_PROMPT =
  'You clean up dictated speech so it reads as typed text. Remove filler words and false starts, '
  + 'restore punctuation and capitalisation, fix obvious misrecognitions of technical terms, and '
  + 'turn spoken enumerations into a Markdown list when that is clearly what was meant.\n\n'
  + 'Do NOT answer, summarise, translate, or add anything. Do not change wording that is already '
  + 'clear. Keep the original language. Reply with the cleaned text and nothing else.'

/**
 * The stored value of an optional duration that means "off". Absent cannot serve: clearing a user
 * override re-inherits the composed value, so a deployment that ships `silenceStopMs: 2500` would
 * leave a person no way to turn silence stop off from the settings card.
 */
const DISABLED_MS = 0

/**
 * Read an optional duration as the browser should act on it.
 * @param value - the resolved setting.
 * @returns the duration, or undefined when it is unset or explicitly disabled.
 */
function activeMs(value: number | undefined): number | undefined {
  return value === DISABLED_MS ? undefined : value
}

/**
 * Read the language hint as a provider should receive it. A blank string is a configured-but-empty
 * value in a hand-written patch, and every provider must read it as "detect", not as a language.
 * @param value - the resolved setting.
 * @returns the trimmed hint, or undefined for "detect the language".
 */
function languageHint(value: string | undefined): string | undefined {
  const hint = value?.trim() ?? ''
  return hint === '' ? undefined : hint
}

/** Host-side voice endpoint and settings owner. */
export class VoiceService extends TypertRemoteService {
  /**
   * Loader validation for the recording caps and the user-facing preferences.
   *
   * Both widenings below keep every earlier profile loading: `polish` was required, so any stored
   * section already states it, and a duration of 1 or more still validates.
   */
  static Config: z<Config> = z.object({
    maxClipSeconds: z.number().step(1).min(1).required(),
    maxClipBytes: z.number().step(1).min(1).required(),
    interactionMode: z.union(['toggle', 'hold'] as const).required(),
    insertMode: z.union(['append', 'replace'] as const).required(),
    language: z.string(),
    // Off unless chosen: polishing sends the transcript to the deployment's model, which may be
    // hosted even when transcription itself is local.
    polish: z.boolean().default(false),
    polishPrompt: z.string(),
    silenceStopMs: z.number().step(1).min(DISABLED_MS),
    liveIntervalMs: z.number().step(1).min(DISABLED_MS),
  })

  private source: () => Config

  /**
   * Bounds concurrent transcriptions on this Host. Per service instance, which is per Host process:
   * every browser tab and every provisional pass shares it, and that sharing is the point.
   */
  private readonly gate = new TranscriptionGate()

  /**
   * @param ctx - Host context; the transcription provider is resolved optionally so a deployment
   * without one still serves a view explaining that.
   * @param config - the composition-layer voice preferences.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'voice')
    this.source = () => config
    installSettingsSection(ctx, VOICE_SETTINGS_NAMESPACE, VoiceService.Config, config, {
      setSource: (current) => { this.source = current },
      // Nothing is derived from the section: every read happens inside a call, so a committed
      // change reaches the next request with no registration to rebuild.
      onChange: () => {},
    })
  }

  /**
   * Describe what the browser needs to record and to explain itself: the mounted provider's
   * readiness and accepted formats, plus the current limits and preferences.
   * @returns the capability view; `available: false` when no provider is mounted.
   */
  @Remote('describe')
  async describe(): Promise<VoiceCapabilityView> {
    const config = this.source()
    // Normalised here, once, so the browser keeps its one rule: an absent field is a disabled one.
    const language = languageHint(config.language)
    const silenceStopMs = activeMs(config.silenceStopMs)
    const liveIntervalMs = activeMs(config.liveIntervalMs)
    const limits = {
      maxClipSeconds: config.maxClipSeconds,
      maxClipBytes: config.maxClipBytes,
      interactionMode: config.interactionMode,
      insertMode: config.insertMode,
      ...language === undefined ? {} : { language },
      polish: config.polish,
      ...silenceStopMs === undefined ? {} : { silenceStopMs },
      ...liveIntervalMs === undefined ? {} : { liveIntervalMs },
    }
    const engine = this.ctx.get('transcription')
    if (engine === undefined) {
      return { available: false, ready: false, acceptedMediaTypes: [], ...limits }
    }
    const info = await engine.describe()
    return {
      available: true,
      provider: info.provider,
      ...info.model === undefined ? {} : { model: info.model },
      ready: info.ready,
      ...info.detail === undefined ? {} : { detail: info.detail },
      acceptedMediaTypes: info.acceptedMediaTypes,
      ...limits,
    }
  }

  /**
   * Transcribe one uploaded recording.
   *
   * Every failure is returned rather than thrown: the gateway erases a business exception's
   * classification, and the browser's next action depends on which class it was.
   * @param request - the base64 clip and its media type.
   * @param signal - gateway-supplied cancellation for the caller's abandoned request.
   * @returns the transcript, or a classified failure.
   */
  @Remote('transcribe')
  async transcribe(request: VoiceTranscribeRequest, signal: AbortSignal): Promise<VoiceTranscribeResult> {
    const engine = this.ctx.get('transcription')
    if (engine === undefined) {
      return { ok: false, code: 'no-provider', message: 'no transcription provider is mounted' }
    }
    const config = this.source()
    const maxClipBytes = config.maxClipBytes
    const language = languageHint(config.language)
    // Sized from the text before decoding: the cap exists to keep an oversized upload off the heap,
    // and decoding first would allocate exactly the buffer it refuses.
    const encodedBytes = decodedByteLength(request.audioBase64)
    if (encodedBytes > maxClipBytes) {
      return {
        ok: false,
        code: 'clip-too-large',
        message: `clip is ${encodedBytes} bytes, over the ${maxClipBytes}-byte limit`,
      }
    }
    const data = decodeAudio(request.audioBase64)
    if (data === undefined) {
      return { ok: false, code: 'malformed-audio', message: 'audio payload is not canonical base64' }
    }
    try {
      const admitted = await this.gate.run(signal, () => engine.transcribe({
        data,
        mimeType: request.mimeType,
        ...language === undefined ? {} : { language },
      }, signal))
      if (admitted === undefined) {
        // `provider-unavailable` rather than a new code: the browser already renders it as "try again",
        // which is the right advice, and a new code would change the wire contract.
        return {
          ok: false,
          code: 'provider-unavailable',
          message: 'transcription is busy with other recordings; try again shortly',
        }
      }
      const result = admitted.value
      return {
        ok: true,
        text: result.text,
        ...result.language === undefined ? {} : { language: result.language },
        ...result.durationMs === undefined ? {} : { durationMs: result.durationMs },
      }
    } catch (error) {
      if (isTranscriptionError(error)) return { ok: false, code: error.code, message: error.message }
      throw error
    }
  }

  /**
   * Clean up one transcript with the deployment's default model.
   *
   * The default model (`agentDefaultModel`), NOT the model a particular session selected: this
   * endpoint is unscoped and receives no session, and reaching a session's selection would mean a
   * session-scoped Remote — a change to the wire surface. Reusing the configured default still means
   * dictation needs no second credential and no second provider. Failures are returned rather than
   * thrown: the caller still has the raw transcript, and losing the cleanup is not losing the dictation.
   * @param text - the raw transcript.
   * @param signal - gateway-supplied cancellation.
   * @returns the cleaned text, or a classified failure.
   */
  @Remote('polish')
  async polish(text: string, signal: AbortSignal): Promise<VoicePolishResult> {
    const raw = text.trim()
    if (raw === '') return { ok: true, text: '' }
    const models = this.ctx.get('agentDefaultModel')
    const llm = this.ctx.get('llm')
    if (models === undefined || llm === undefined) {
      return { ok: false, code: 'no-model', message: 'no model is configured for this deployment' }
    }
    const selection = models.currentSelection()
    try {
      let cleaned = ''
      for await (const chunk of llm.stream({
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
        system: this.source().polishPrompt ?? DEFAULT_POLISH_PROMPT,
        messages: [createUserMessage({ content: [{ type: 'text', text: raw }], source: { kind: 'user' } })],
        signal,
      })) {
        if (chunk.type === 'text-delta') cleaned += chunk.text
      }
      // A model that answers with nothing has not improved anything; the raw transcript is the
      // honest result rather than an empty draft.
      const result = cleaned.trim()
      return { ok: true, text: result === '' ? raw : result }
    } catch (error) {
      if (signal.aborted) throw signal.reason
      return {
        ok: false,
        code: 'llm-failed',
        message: error instanceof Error ? error.message : 'the model request failed',
      }
    }
  }
}

export default VoiceService
