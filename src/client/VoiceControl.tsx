import { useCallback, useEffect, useRef, useState } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left seat) and
// the input standard kit (useInput + inputActions) it publishes.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { VoiceCapabilityView } from '../host/types.ts'
import { MicIcon } from './MicIcon.tsx'
import { appendTranscript } from './draft.ts'
import { startRecording, type RecordingSession } from './recorder.ts'
import type { VoiceControlInjected } from './index.ts'
import css from './VoiceControl.module.css'

/** Full mic-seat component props: runtime share (standard kit + InputZone owner) & injected share & locale seat. */
export type VoiceControlProps =
  PropsRuntime<'conversation.input.left'> & InjectFace<VoiceControlInjected> & PropsLocale<'voice'>

/** What the control is doing right now; every transition is driven by a user gesture or a settled promise. */
type Phase = 'idle' | 'recording' | 'transcribing'

/**
 * Failure copy for one transcription outcome. Error surfaces stay English by repository policy, so
 * these are literals rather than dictionary keys.
 * @param code - the classified failure from the Host.
 * @returns a short operator-facing line.
 */
function describeFailure(code: string): string {
  switch (code) {
    case 'no-provider': return 'no transcription provider'
    case 'not-configured': return 'transcription is not configured'
    case 'clip-too-large': return 'recording too long'
    case 'unsupported-media-type': return 'unsupported audio format'
    case 'provider-timeout': return 'transcription timed out'
    case 'provider-unavailable': return 'transcription is unreachable'
    case 'empty-audio': return 'nothing was recorded'
    default: return 'transcription failed'
  }
}

/**
 * The composer's microphone control: records from the system microphone, sends the clip to the Host
 * for transcription, and writes the result into the draft through the public input action.
 *
 * The gesture (`toggle` or `hold`) and the insertion rule come from the Host's voice settings, so
 * this component reads policy rather than owning it.
 */
export function VoiceControl({ useInput, inputActions, describeVoice, transcribe, t }: VoiceControlProps) {
  const draft = useInput(state => state.draft)
  const [view, setView] = useState<VoiceCapabilityView | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [elapsedMs, setElapsedMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef<RecordingSession | null>(null)
  const aliveRef = useRef(true)
  // Read through a call rather than the property: an `await` can unmount this component, but the
  // compiler narrows `aliveRef.current` after the first check and would treat every later one as
  // dead code.
  const alive = (): boolean => aliveRef.current
  const draftRef = useRef(draft)
  draftRef.current = draft

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      // A seat unmounting mid-recording must not leave the microphone indicator lit.
      sessionRef.current?.cancel()
      sessionRef.current = null
    }
  }, [])

  useEffect(() => {
    void describeVoice().then((next) => {
      if (alive()) setView(next)
    }, () => {
      // A failed probe leaves `view` null, which renders the control disabled with its
      // not-configured tooltip — the same state a deployment without a provider produces.
    })
  }, [describeVoice])

  useEffect(() => {
    if (phase !== 'recording') return undefined
    const startedAt = performance.now()
    setElapsedMs(0)
    const tick = setInterval(() =>{  setElapsedMs(performance.now() - startedAt) }, 200)
    return () =>{  clearInterval(tick) }
  }, [phase])

  const finish = useCallback(async (): Promise<void> => {
    const session = sessionRef.current
    sessionRef.current = null
    if (session === null) return
    setPhase('transcribing')
    try {
      const clip = await session.stop()
      const result = await transcribe(clip)
      if (!alive()) return
      if (!result.ok) {
        setError(describeFailure(result.code))
        return
      }
      if (result.text === '') {
        setError('nothing was heard')
        return
      }
      inputActions.setDraft(view?.insertMode === 'replace'
        ? result.text
        : appendTranscript(draftRef.current, result.text))
    } catch (cause) {
      if (!alive()) return
      setError(cause instanceof Error ? cause.message : 'transcription failed')
    } finally {
      if (alive()) setPhase('idle')
    }
  }, [inputActions, transcribe, view?.insertMode])

  const begin = useCallback(async (): Promise<void> => {
    setError(null)
    // Re-read policy at the gesture: a settings change between mount and now must take effect.
    const current = await describeVoice().catch(() => view)
    if (!alive()) return
    if (current !== null) setView(current)
    if (current === null || !current.ready) {
      setError(current?.detail ?? 'transcription is not configured')
      return
    }
    try {
      sessionRef.current = await startRecording({
        accepted: current.acceptedMediaTypes,
        maxMs: current.maxClipSeconds * 1000,
      })
      if (!alive()) {
        sessionRef.current.cancel()
        sessionRef.current = null
        return
      }
      setPhase('recording')
    } catch (cause) {
      if (!alive()) return
      setError(cause instanceof Error ? cause.message : 'could not open the microphone')
    }
  }, [describeVoice, view])

  // An unmounted capability leaves the seat empty rather than showing a dead button: a deployment
  // that composed no provider pays no layout, the same contract the named composer seats keep.
  if (view === null || !view.available) return null

  const hold = view.interactionMode === 'hold'
  const disabled = phase === 'transcribing'

  const onClick = (): void => {
    if (hold) return
    if (phase === 'recording') void finish()
    else if (phase === 'idle') void begin()
  }
  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!hold || phase !== 'idle') return
    event.currentTarget.setPointerCapture(event.pointerId)
    void begin()
  }
  const onPointerUp = (): void => {
    if (hold && phase === 'recording') void finish()
  }

  const label = phase === 'recording'
    ? t('mic.recording.aria')
    : phase === 'transcribing' ? t('mic.transcribing.aria') : t('mic.idle.aria')
  const title = !view.ready
    ? t('mic.unconfigured.title')
    : phase === 'recording'
      ? t('mic.recording.title')
      : phase === 'transcribing'
        ? t('mic.transcribing.title')
        : hold ? t('mic.hold.title') : t('mic.idle.title')

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={`${css.button} ${phase === 'recording' ? css.recording : ''} ${phase === 'transcribing' ? css.busy : ''}`}
        aria-label={label}
        aria-pressed={phase === 'recording'}
        title={title}
        disabled={disabled}
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <MicIcon />
      </button>
      {phase === 'recording' && (
        <span className={css.elapsed} role="timer">{Math.floor(elapsedMs / 1000)}s</span>
      )}
      {/* Failure copy stays English (error-surface policy: not localized). */}
      {error !== null && <span className={css.error} role="status" title={error}>{error}</span>}
    </span>
  )
}
