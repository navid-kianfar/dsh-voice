/**
 * How the voice settings card turns a staged text field into a settings write, and which staged
 * values it refuses. Kept apart from the component so the mapping is testable without a renderer.
 * @module @achasoft/dsh-voice/client/settings-fields
 */

import type { VoiceSettings } from '../host/types.ts'

/** Fields a person edits on the card; the rest of the section is deployment-owned. */
export type EditableField = keyof Pick<VoiceSettings,
  'interactionMode' | 'insertMode' | 'maxClipSeconds' | 'language'
  | 'polish' | 'polishPrompt' | 'silenceStopMs' | 'liveIntervalMs'>

/** One write the card issues for a changed field. */
export type PlannedWrite =
  | { readonly kind: 'set'; readonly value: string | number | boolean }
  | { readonly kind: 'unset' }

/** The stored text of the polish toggle's "on" option. */
const POLISH_ON = 'true'

/**
 * Plan the write for one changed field.
 *
 * A blank optional field is CLEARED, not stored empty: an empty `language` would read as
 * configured-but-empty rather than "detect the language". Clearing re-inherits the deployment's
 * composed value, which is why the millisecond fields take an explicit 0 for "off" — blank cannot
 * turn off a silence stop the deployment ships switched on.
 * @param field - the field that changed.
 * @param text - its staged text.
 * @returns the set or unset to issue.
 */
export function plannedWrite(field: EditableField, text: string): PlannedWrite {
  switch (field) {
    case 'maxClipSeconds':
      return { kind: 'set', value: Number(text) }
    case 'polish':
      return { kind: 'set', value: text === POLISH_ON }
    case 'silenceStopMs':
    case 'liveIntervalMs':
      return text === '' ? { kind: 'unset' } : { kind: 'set', value: Number(text) }
    case 'language':
    case 'polishPrompt':
      return text === '' ? { kind: 'unset' } : { kind: 'set', value: text }
    case 'interactionMode':
    case 'insertMode':
      return { kind: 'set', value: text }
    default: {
      const unexpected: never = field
      throw new TypeError(`voice settings card has no write for field ${String(unexpected)}`)
    }
  }
}

/**
 * Whether a staged seconds value could be stored. The Host schema requires a positive integer, and a
 * write it would reject must be refused here — a rejected write leaves the field looking accepted.
 * @param text - the staged text.
 * @returns true when the value is unusable.
 */
export function secondsInvalid(text: string): boolean {
  const parsed = Number(text)
  return !Number.isSafeInteger(parsed) || parsed < 1
}

/**
 * Whether a staged optional milliseconds value could be stored. Blank (clear the override) and 0
 * (explicitly off) are both valid; anything else must be a positive integer, as the Host schema says.
 * @param text - the staged text.
 * @returns true when the value is unusable.
 */
export function millisecondsInvalid(text: string): boolean {
  if (text === '') return false
  const parsed = Number(text)
  return !Number.isSafeInteger(parsed) || parsed < 0
}
