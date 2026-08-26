import { useEffect, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the keyed settings.plugin.item slot declaration. Cross-plugin collaboration goes
// through cordis services; a value import fails the client bundle-purity gate, so this card renders
// its own chrome rather than reusing the section's.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { VoiceCapabilityView, VoiceSettings } from '../host/types.ts'
import type { VoiceSettingsInjected } from './index.ts'
import css from './VoiceSettingsCard.module.css'

/** Props the renderer binds for the voice settings card. */
export type VoiceSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'voice'>
  & InjectFace<VoiceSettingsInjected>

/** Fields a person edits here; the rest of the section is deployment-owned. */
type Editable = Pick<VoiceSettings,
  'interactionMode' | 'insertMode' | 'maxClipSeconds' | 'language'
  | 'polish' | 'polishPrompt' | 'silenceStopMs' | 'liveIntervalMs'>

/** Optional whole-millisecond fields: blank clears them rather than storing a zero. */
const OPTIONAL_MS: readonly (keyof Editable)[] = ['silenceStopMs', 'liveIntervalMs']

/** Staged edits, keyed by field; absent means "unchanged from the resolved value". */
type Draft = Partial<Record<keyof Editable, string>>

/**
 * Read one field's staged text, falling back to the resolved value.
 * @param draft - staged edits.
 * @param value - the resolved section, absent while it loads.
 * @param field - the field to read.
 * @returns the text the control should display.
 */
function shown(draft: Draft, value: VoiceSettings | undefined, field: keyof Editable): string {
  const staged = draft[field]
  if (staged !== undefined) return staged
  const resolved = value?.[field]
  return resolved === undefined ? '' : String(resolved)
}

/**
 * Whether a staged seconds value could be stored. The Host schema requires a positive integer, and a
 * write it would reject must be refused here — a rejected write leaves the field looking accepted.
 * @param text - the staged text.
 * @returns true when the value is unusable.
 */
function secondsInvalid(text: string): boolean {
  const parsed = Number(text)
  return !Number.isSafeInteger(parsed) || parsed < 1
}

/**
 * The voice card on the plugin-configuration tab: provider readiness plus the four preferences a
 * person changes.
 *
 * Edits are staged rather than written per keystroke — the text and number fields would otherwise
 * issue one settings write per character — and committed together, which is also the interaction the
 * neighbouring cards use.
 */
export function VoiceSettingsCard(props: VoiceSettingsCardProps) {
  const { t, setField, unsetField, describeVoice, listDevices, readDevice, writeDevice } = props
  const settings = props.useVoiceSettings(snapshot => snapshot)
  const [capability, setCapability] = useState<VoiceCapabilityView | null>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>({})
  const [saving, setSaving] = useState(false)
  const [failed, setFailed] = useState(false)
  const [devices, setDevices] = useState<readonly MediaDeviceInfo[]>([])
  const [device, setDevice] = useState<string | undefined>(readDevice)

  useEffect(() => {
    let alive = true
    void listDevices().then((found) => { if (alive) setDevices(found) }, () => {
      // Enumeration is unavailable outside a secure context and before the first grant; the picker
      // then offers only the system default, which is exactly what the recorder will use.
    })
    return () => { alive = false }
  }, [listDevices])

  useEffect(() => {
    let alive = true
    void describeVoice().then((next) => {
      if (alive) setCapability(next)
    }, () => {
      // A failed probe leaves the status line on its "no provider" copy, which is the same thing a
      // deployment without a provider shows; the controls below stay editable either way.
    })
    return () => { alive = false }
  }, [describeVoice])

  const value = settings.value
  const edit = (field: keyof Editable, text: string): void => {
    setFailed(false)
    setDraft(current => ({ ...current, [field]: text }))
  }

  const changed = (Object.keys(draft) as (keyof Editable)[])
    .filter(field => draft[field] !== shown({}, value, field))
  const dirty = changed.length > 0
  const msInvalid = (field: keyof Editable): boolean => {
    const text = shown(draft, value, field)
    return text !== '' && secondsInvalid(text)
  }
  const invalid = secondsInvalid(shown(draft, value, 'maxClipSeconds'))
    || msInvalid('silenceStopMs') || msInvalid('liveIntervalMs')
  const writable = settings.writable && value !== undefined

  const save = (): void => {
    setSaving(true)
    setFailed(false)
    // Sequential rather than concurrent: each write is fenced with the revision it read, so
    // overlapping them would make all but the first fail on a stale fence.
    void changed.reduce(
      (queue, field) => queue.then(() => {
        const text = draft[field] ?? ''
        if (field === 'maxClipSeconds') return setField(field, Number(text))
        if (field === 'polish') return setField(field, text === 'true')
        // A blank optional field is CLEARED, not stored empty: an empty `language` would read as
        // configured-but-empty rather than "detect the language", and a 0 ms silence bound would
        // read as "stop immediately" rather than "do not stop on silence".
        if (OPTIONAL_MS.includes(field)) return text === '' ? unsetField(field) : setField(field, Number(text))
        if ((field === 'language' || field === 'polishPrompt') && text === '') return unsetField(field)
        return setField(field, text)
      }),
      Promise.resolve(),
    ).then(() => {
      setSaving(false)
      setDraft({})
    }, () => {
      setSaving(false)
      setFailed(true)
    })
  }

  const title = t('settings.title')
  return (
    <li className={`${css.card} ${open ? css.cardOpen : ''}`}>
      <button
        type="button"
        className={css.header}
        aria-expanded={open}
        aria-label={`${t(open ? 'settings.collapse' : 'settings.expand')}: ${title}`}
        onClick={() => { setOpen(!open) }}
      >
        <span className={css.headText}>
          <span className={css.name}>{title}</span>
          <span className={css.description}>{t('settings.description')}</span>
        </span>
        {dirty ? <span className={css.pending}>{t('settings.unsaved')}</span> : null}
        <IconChevronDownOutline14 className={`${css.chevron} ${open ? css.chevronOpen : ''}`} />
      </button>

      {open
        ? (
          <div className={css.body}>
            {!writable ? <p className={css.readOnly} role="status">{t('settings.readOnly')}</p> : null}

            <div className={css.field}>
              <div className={css.head}><span className={css.label}>{t('settings.provider')}</span></div>
              {capability === null || !capability.available
                ? <p className={css.hint}>{t('settings.provider.none')}</p>
                : (
                  <span className={css.provider}>
                    <span className={css.providerName}>
                      {capability.provider}
                      {capability.model === undefined ? '' : ` · ${capability.model}`}
                    </span>
                    <span className={capability.ready ? css.badgeReady : css.badgeBlocked}>
                      {capability.ready ? t('settings.status.ready') : t('settings.status.notReady')}
                    </span>
                  </span>
                )}
              {/* Readiness detail is an operator diagnostic; error surfaces stay English by policy. */}
              {capability?.detail !== undefined ? <p className={css.hint}>{capability.detail}</p> : null}
            </div>

            <label className={css.field}>
              <div className={css.head}><span className={css.label}>{t('settings.interaction')}</span></div>
              <select
                className={css.select}
                disabled={!writable}
                value={shown(draft, value, 'interactionMode')}
                onChange={(event) => { edit('interactionMode', event.target.value) }}
              >
                <option value="toggle">{t('settings.interaction.toggle')}</option>
                <option value="hold">{t('settings.interaction.hold')}</option>
              </select>
            </label>

            <label className={css.field}>
              <div className={css.head}><span className={css.label}>{t('settings.insert')}</span></div>
              <select
                className={css.select}
                disabled={!writable}
                value={shown(draft, value, 'insertMode')}
                onChange={(event) => { edit('insertMode', event.target.value) }}
              >
                <option value="append">{t('settings.insert.append')}</option>
                <option value="replace">{t('settings.insert.replace')}</option>
              </select>
            </label>

            <label className={css.field}>
              <div className={css.head}><span className={css.label}>{t('settings.maxClipSeconds')}</span></div>
              <input
                className={invalid ? css.controlInvalid : css.control}
                type="number"
                min={1}
                inputMode="numeric"
                disabled={!writable}
                value={shown(draft, value, 'maxClipSeconds')}
                onChange={(event) => { edit('maxClipSeconds', event.target.value) }}
              />
              {invalid ? <p className={css.invalid} role="status">{t('settings.invalidNumber')}</p> : null}
            </label>

            <label className={css.field}>
              <div className={css.head}><span className={css.label}>{t('settings.polish')}</span></div>
              <select
                className={css.select}
                disabled={!writable}
                value={shown(draft, value, 'polish')}
                onChange={(event) => { edit('polish', event.target.value) }}
              >
                <option value="true">{t('settings.polish.on')}</option>
                <option value="false">{t('settings.polish.off')}</option>
              </select>
            </label>

            {shown(draft, value, 'polish') === 'true' ? (
              <label className={css.field}>
                <div className={css.head}><span className={css.label}>{t('settings.polishPrompt')}</span></div>
                <input
                  className={css.control}
                  type="text"
                  disabled={!writable}
                  value={shown(draft, value, 'polishPrompt')}
                  onChange={(event) => { edit('polishPrompt', event.target.value) }}
                />
              </label>
            ) : null}

            <label className={css.field}>
              <div className={css.head}><span className={css.label}>{t('settings.silenceStop')}</span></div>
              <input
                className={msInvalid('silenceStopMs') ? css.controlInvalid : css.control}
                type="number"
                min={1}
                disabled={!writable}
                value={shown(draft, value, 'silenceStopMs')}
                onChange={(event) => { edit('silenceStopMs', event.target.value) }}
              />
            </label>

            <label className={css.field}>
              <div className={css.head}><span className={css.label}>{t('settings.liveInterval')}</span></div>
              <input
                className={msInvalid('liveIntervalMs') ? css.controlInvalid : css.control}
                type="number"
                min={1}
                disabled={!writable}
                value={shown(draft, value, 'liveIntervalMs')}
                onChange={(event) => { edit('liveIntervalMs', event.target.value) }}
              />
              <p className={css.hint}>{t('settings.liveInterval.hint')}</p>
            </label>

            {/* The device is browser-local, so it writes through on change rather than joining the
                staged form: there is no revision to fence and nothing to save. */}
            <label className={css.field}>
              <div className={css.head}><span className={css.label}>{t('settings.device')}</span></div>
              <select
                className={css.select}
                value={device ?? ''}
                onChange={(event) => {
                  const next = event.target.value === '' ? undefined : event.target.value
                  setDevice(next)
                  writeDevice(next)
                }}
              >
                <option value="">{t('settings.device.default')}</option>
                {devices.map((input, index) => (
                  <option key={input.deviceId} value={input.deviceId}>
                    {input.label === '' ? `${t('settings.device.unnamed')} ${index + 1}` : input.label}
                  </option>
                ))}
              </select>
              <p className={css.hint}>{t('settings.device.hint')}</p>
            </label>

            <label className={css.field}>
              <div className={css.head}><span className={css.label}>{t('settings.language')}</span></div>
              <input
                className={css.control}
                type="text"
                disabled={!writable}
                value={shown(draft, value, 'language')}
                onChange={(event) => { edit('language', event.target.value) }}
              />
            </label>

            <div className={css.footer}>
              {failed ? <p className={css.failed} role="status">{t('settings.saveFailed')}</p> : null}
              <button
                type="button"
                className={css.discard}
                disabled={!dirty || saving}
                onClick={() => { setDraft({}); setFailed(false) }}
              >
                {t('settings.discard')}
              </button>
              <button
                type="button"
                className={css.save}
                disabled={!dirty || invalid || saving || !writable}
                onClick={save}
              >
                {t(saving ? 'settings.saving' : 'settings.save')}
              </button>
            </div>
          </div>
        )
        : null}
    </li>
  )
}
