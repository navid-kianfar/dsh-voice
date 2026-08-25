/**
 * Voice input plugin, browser half. Two registrations over one Host endpoint: the composer's
 * microphone control in the `conversation.input.left` seat, and the voice card on the plugin
 * settings tab keyed by the `voice` namespace.
 *
 * The control writes its transcript through the input standard kit's public `setDraft`, so a
 * dictated prompt is an ordinary draft a person edits and sends. Nothing here reaches a model
 * directly and nothing is persisted.
 * @module @deepseek-ai/dsh-client-ui-voice/client
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientContext, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.remote Context merge and the generated `voice` namespace.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the settings shell's ctx.settingsScope Context merge.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the keyed settings.plugin.item slot declaration.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
// The generated Host-for-Client contract for this plugin's own endpoint. Importing it here — rather
// than adding a row to the curated api-remotes assembly — is what keeps the capability a plugin: the
// namespace mounts and unmounts with this fiber, and no shipped source names `voice`.
import voiceRemote from '../../generated/typert.remote-client.js'
import type { VoiceCapabilityView, VoiceSettings, VoiceTranscribeResult } from '../host/types.ts'
import { VoiceControl } from './VoiceControl.tsx'
import { VoiceSettingsCard } from './VoiceSettingsCard.tsx'
import type { RecordedClip } from './recorder.ts'
import { en, zh, type VoiceKey } from './locales.ts'

export type { VoiceKey } from './locales.ts'
export type { VoiceControlProps } from './VoiceControl.tsx'
export type { VoiceSettingsCardProps } from './VoiceSettingsCard.tsx'
export type { RecordedClip, RecordingSession, RecordingRequest, RecorderFailureCode } from './recorder.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The microphone control's and voice settings card's copy. */
    voice: VoiceKey
  }
}

/** Dictionary namespace and settings namespace owned by this plugin; the Host joins the card on it. */
const NS = 'voice'

/** Injected business face of the composer microphone seat. */
export interface VoiceControlInjected {
  /**
   * Read the Host's current voice capability: provider readiness, accepted formats, and the limits
   * and preferences the control must honour.
   * @returns the capability view.
   */
  describeVoice: () => Promise<VoiceCapabilityView>
  /**
   * Send one recorded clip for transcription.
   * @param clip - the encoded recording.
   * @returns the transcript, or a classified failure carried as a value.
   */
  transcribe: (clip: RecordedClip) => Promise<VoiceTranscribeResult>
}

/** Injected business face of the voice settings card. */
export interface VoiceSettingsInjected {
  /** Registrant-private reactive sources the renderer binds to `use<Name>` hooks. */
  hooks: {
    /** The bound `voice` settings scope: resolved value, layers, revision, and writability. */
    voiceSettings: SettingsScope<VoiceSettings>
  }
  /**
   * Read the Host's current voice capability for the card's status line.
   * @returns the capability view.
   */
  describeVoice: () => Promise<VoiceCapabilityView>
  /**
   * Store one field of the `voice` section; the bound scope owns revision fencing.
   * @param field - the field name inside the namespace.
   * @param value - the JSON-shaped value the control produced.
   * @returns settlement after the write.
   */
  setField: (field: string, value: unknown) => Promise<void>
}

/**
 * Required services of the OUTER plugin: locale and the Remote mount point.
 *
 * Deliberately NOT `remote.voice`. This plugin's apply creates that namespace by mounting its own
 * contribution, so it cannot also wait for it — and Cordis refuses to read a service the fiber did
 * not inject. Both halves of that bind are resolved by the child plugin below, which injects
 * `remote.voice` after the parent has provided it.
 */
export const inject = ['locale', 'remote']

/**
 * Client plugin body: mount this plugin's own Remote namespace, then register the composer control
 * and the settings card.
 * @param ctx - client root context.
 * @returns after the `voice` namespace is callable; its methods are withdrawn when this fiber unloads.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  // Mounted on THIS fiber, so the endpoint's lifetime is the plugin's.
  await ctx.remote.$mount(voiceRemote)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-voice: dictionaries')

  // The surface is a child so it can INJECT the namespace its parent just provided. Cordis will not
  // hand a fiber a service it did not declare, and the parent cannot declare one it creates itself;
  // the split is what lets the seats hold a properly injected reference.
  ctx.plugin({
    name: 'voice-surface',
    inject: ['slots', 'settingsScope', 'locale', 'remote', 'remote.voice'],
    apply: surface,
  })
}

/**
 * Register the composer seat and the settings card against a context that has the voice namespace.
 * @param ctx - the child fiber, with `remote.voice` injected.
 */
function surface(ctx: ClientContext): void {
  // Both endpoints return the carrier's RemoteResult envelope. A transport failure is a different
  // fact from a transcription failure, so it is thrown rather than folded into the business union
  // the Host defines: the surfaces catch it and show the RPC diagnostic verbatim.
  const unwrap = <T>(result: RemoteResult<T>): T => {
    if (!result.ok) throw new Error(`${result.error.message} (${result.error.code})`)
    return result.value
  }
  const describeVoice = (): Promise<VoiceCapabilityView> => ctx.remote.voice.describe().then(unwrap)
  const transcribe = (clip: RecordedClip): Promise<VoiceTranscribeResult> =>
    ctx.remote.voice.transcribe({ audioBase64: clip.base64, mimeType: clip.mimeType }).then(unwrap)

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    // List seats are addressed by id; the seat orders itself after the resident chrome.
    id: 'voice',
    locale: NS,
    inject: (): VoiceControlInjected => ({ describeVoice, transcribe }),
  }, VoiceControl))

  const scope = ctx.settingsScope.bind<VoiceSettings>({ namespace: NS })
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: NS,
    locale: NS,
    inject: (): VoiceSettingsInjected => ({
      hooks: { voiceSettings: scope },
      describeVoice,
      setField: (field, value) => scope.set(field, value),
    }),
  }, VoiceSettingsCard))
}
