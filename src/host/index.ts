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
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { isTranscriptionError } from '../transcription/index.ts'
import { decodeAudio } from './decode.ts'
import type {} from '../transcription/index.ts'
import type {
  VoiceCapabilityView,
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

/** Host-side voice endpoint and settings owner. */
export class VoiceService extends TypertRemoteService {
  /** Loader validation for the recording caps and the two user-facing preferences. */
  static Config: z<Config> = z.object({
    maxClipSeconds: z.number().step(1).min(1).required(),
    maxClipBytes: z.number().step(1).min(1).required(),
    interactionMode: z.union(['toggle', 'hold'] as const).required(),
    insertMode: z.union(['append', 'replace'] as const).required(),
    language: z.string(),
  })

  private source: () => Config

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
    const limits = {
      maxClipSeconds: config.maxClipSeconds,
      maxClipBytes: config.maxClipBytes,
      interactionMode: config.interactionMode,
      insertMode: config.insertMode,
      ...config.language === undefined ? {} : { language: config.language },
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
    const data = decodeAudio(request.audioBase64)
    if (data === undefined) {
      return { ok: false, code: 'malformed-audio', message: 'audio payload is not canonical base64' }
    }
    const { maxClipBytes, language } = this.source()
    if (data.byteLength > maxClipBytes) {
      return {
        ok: false,
        code: 'clip-too-large',
        message: `clip is ${data.byteLength} bytes, over the ${maxClipBytes}-byte limit`,
      }
    }
    try {
      const result = await engine.transcribe({
        data,
        mimeType: request.mimeType,
        ...language === undefined ? {} : { language },
      }, signal)
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
}

export default VoiceService
