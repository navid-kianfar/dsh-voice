/**
 * Voice input plugin, browser half. Two registrations over one Host endpoint: the composer's
 * microphone control in the `conversation.input.left` seat, and the voice card on the plugin
 * settings tab keyed by the `voice` namespace.
 *
 * The control splices its transcript into the draft through the session scope's
 * `slash/input-insert-text` verb, so a dictated prompt is an ordinary draft a person edits and sends —
 * and the reference chips already in it survive. Nothing here reaches a model directly and nothing is
 * persisted.
 * @module @deepseek-ai/dsh-client-ui-voice/client
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ClientContext, SessionId, SettingsScope } from '@deepseek-ai/dsh-client-runtime/client'
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
import type {
  VoiceCapabilityView, VoicePolishResult, VoiceSettings, VoiceTranscribeResult,
} from '../host/types.ts'
import { VoiceControl } from './VoiceControl.tsx'
import { VoiceSettingsCard } from './VoiceSettingsCard.tsx'
import { listMicrophones, type RecordedClip } from './recorder.ts'
import { readDevice, writeDevice } from './device.ts'
import type { DraftSpan } from './draft.ts'
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
   * @param signal - aborts the call when its result is no longer wanted, such as a provisional pass
   *   overtaken by the stop; the Host then frees its transcription slot.
   * @returns the transcript, or a classified failure carried as a value.
   */
  transcribe: (clip: RecordedClip, signal?: AbortSignal) => Promise<VoiceTranscribeResult>
  /**
   * Clean up one transcript with the session's model.
   * @param text - the raw transcript.
   * @returns the cleaned text, or a classified failure the caller ignores in favour of the raw text.
   */
  polish: (text: string) => Promise<VoicePolishResult>
  /**
   * The microphone this machine is set to record from.
   * @returns the stored device id, or undefined for the system default.
   */
  readDevice: () => string | undefined
  /**
   * Splice text into this session's draft in place, through the scoped `slash/input-insert-text`
   * event the composer's input hub answers with its span-checked insertion.
   *
   * `inputActions.setDraft` cannot do this on the installed harness: it rebuilds the editor document
   * from the draft's plain-text projection, which flattens every reference chip into literal `@path`
   * text. Undefined when the session scope cannot be resolved; the control then falls back to
   * `setDraft`, which is only reachable in composers that have no chips to lose.
   * @param text - the text to insert.
   * @param span - the span it replaces, in detect coordinates, fenced with the draft revision.
   * @returns true when the editor applied it; false when the revision moved first.
   */
  insertText: ((text: string, span: DraftSpan) => boolean) | undefined
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
  /**
   * List the input devices this browser will name.
   * @returns the available microphones; empty when enumeration is unavailable.
   */
  listDevices: () => Promise<readonly MediaDeviceInfo[]>
  /**
   * The microphone this machine records from.
   * @returns the stored device id, or undefined for the system default.
   */
  readDevice: () => string | undefined
  /**
   * Choose the microphone for this machine only; it never reaches the settings document.
   * @param deviceId - the device to use, or undefined for the system default.
   */
  writeDevice: (deviceId: string | undefined) => void
  /**
   * Clear one optional field back to the composition layer. A blank optional field is cleared
   * rather than stored empty, so it reads as unset instead of configured-but-empty.
   * @param field - the field name inside the namespace.
   * @returns settlement after the write.
   */
  unsetField: (field: string) => Promise<void>
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
    inject: ['slots', 'settingsScope', 'locale', 'sessions', 'remote', 'remote.voice'],
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
  const transcribe = (clip: RecordedClip, signal?: AbortSignal): Promise<VoiceTranscribeResult> =>
    ctx.remote.voice.transcribe({ audioBase64: clip.base64, mimeType: clip.mimeType }, signal).then(unwrap)
  const polish = (text: string): Promise<VoicePolishResult> => ctx.remote.voice.polish(text).then(unwrap)

  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    // List seats are addressed by id; the seat orders itself after the resident chrome.
    id: 'voice',
    locale: NS,
    inject: (sessionId: SessionId): VoiceControlInjected => ({
      describeVoice, transcribe, polish, readDevice, insertText: textInserter(ctx, sessionId),
    }),
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
      unsetField: field => scope.unset(field),
      listDevices: listMicrophones,
      readDevice,
      writeDevice,
    }),
  }, VoiceSettingsCard))
}

/**
 * The one member of a session scope the text writer calls. The event's request type is declared by
 * the input-trigger package, which this plugin does not depend on; naming the single call keeps the
 * cast as narrow as the use.
 */
interface ScopedTextInsert {
  bail(thisArg: unknown, name: 'slash/input-insert-text', request: { readonly text: string; readonly span: DraftSpan }): unknown
}

/**
 * Bind the in-place text writer for one session.
 *
 * Emitted as the scoped `slash/input-insert-text` event on the session scope, which the composer's
 * input hub answers with its span-checked text insertion — a public verb in both the checkout this
 * compiles against and the installed harness (`dsh-client-ui-conversation` 0.1.5-rc.2). Being an
 * ordinary editor update, it is one undo step, and it leaves every node outside its span alone.
 * @param ctx - the fiber holding the session service.
 * @param sessionId - the session the seat is mounted for.
 * @returns the writer, or undefined when the session scope is not resolvable.
 */
function textInserter(
  ctx: ClientContext,
  sessionId: SessionId,
): ((text: string, span: DraftSpan) => boolean) | undefined {
  const actx = ctx.sessions.scope(sessionId)
  if (actx === undefined) return undefined
  const scope = actx as unknown as ScopedTextInsert
  return (text, span) => scope.bail(actx, 'slash/input-insert-text', { text, span }) === true
}
