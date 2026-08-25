import { useEffect, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceCapabilityView } from '../host/types.ts'
// Type-only: the keyed settings.plugin.item slot declaration. Cross-plugin
// collaboration goes through cordis services; a value import fails the client
// bundle-purity gate, so this card renders its own chrome rather than reusing
// the section's fields.
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { VoiceSettingsInjected } from './index.ts'
import css from './VoiceSettingsCard.module.css'

/** Props the renderer binds for the voice settings card. */
export type VoiceSettingsCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'voice'>
  & InjectFace<VoiceSettingsInjected>

/**
 * The voice card on the plugin-configuration tab: provider readiness plus the four preferences a
 * person changes. Every control writes immediately through the bound settings scope, which owns
 * revision fencing, so the card carries no staged form of its own.
 */
export function VoiceSettingsCard(props: VoiceSettingsCardProps) {
  const { t, setField, describeVoice } = props
  const settings = props.useVoiceSettings(snapshot => snapshot)
  const [capability, setCapability] = useState<VoiceCapabilityView | null>(null)
  const value = settings.value
  const disabled = !settings.writable || value === undefined

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

  return (
    <section className={css.card}>
      <header className={css.head}>
        <span className={css.title}>{t('settings.title')}</span>
        <span className={css.description}>{t('settings.description')}</span>
      </header>

      <div className={css.row}>
        <span className={css.label}>{t('settings.provider')}</span>
        <span className={css.status}>
          {capability === null || !capability.available
            ? t('settings.provider.none')
            : (
              <>
                {capability.provider}
                {capability.model === undefined ? '' : ` · ${capability.model}`}
                {' '}
                <span className={`${css.badge} ${capability.ready ? css.ready : css.notReady}`}>
                  {capability.ready ? t('settings.status.ready') : t('settings.status.notReady')}
                </span>
              </>
            )}
        </span>
      </div>
      {/* Readiness detail is an operator diagnostic; error surfaces stay English by policy. */}
      {capability?.detail !== undefined && <span className={css.status}>{capability.detail}</span>}

      <label className={css.row}>
        <span className={css.label}>{t('settings.interaction')}</span>
        <select
          className={css.control}
          disabled={disabled}
          value={value?.interactionMode ?? 'toggle'}
          onChange={(event) => { void setField('interactionMode', event.target.value) }}
        >
          <option value="toggle">{t('settings.interaction.toggle')}</option>
          <option value="hold">{t('settings.interaction.hold')}</option>
        </select>
      </label>

      <label className={css.row}>
        <span className={css.label}>{t('settings.insert')}</span>
        <select
          className={css.control}
          disabled={disabled}
          value={value?.insertMode ?? 'append'}
          onChange={(event) => { void setField('insertMode', event.target.value) }}
        >
          <option value="append">{t('settings.insert.append')}</option>
          <option value="replace">{t('settings.insert.replace')}</option>
        </select>
      </label>

      <label className={css.row}>
        <span className={css.label}>{t('settings.maxClipSeconds')}</span>
        <input
          className={css.control}
          type="number"
          min={1}
          disabled={disabled}
          value={value?.maxClipSeconds ?? 0}
          onChange={(event) => {
            const next = Number(event.target.value)
            // A non-integer or non-positive entry is refused here rather than sent: the Host schema
            // would reject it, and a rejected write leaves the field looking accepted.
            if (Number.isSafeInteger(next) && next > 0) void setField('maxClipSeconds', next)
          }}
        />
      </label>

      <label className={css.row}>
        <span className={css.label}>{t('settings.language')}</span>
        <input
          className={css.control}
          type="text"
          disabled={disabled}
          value={value?.language ?? ''}
          onChange={(event) => { void setField('language', event.target.value) }}
        />
      </label>
    </section>
  )
}
