import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-conversation SlotMap merge (the input.left seat) and the input standard
// kit (useInput + inputActions) it publishes.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { MicIcon } from './MicIcon.tsx'
import { appendTranscript, planTranscriptInsert } from './draft.ts'
import { DictationController, type DictationDeps } from './dictation.ts'
import { startRecording } from './recorder.ts'
import type { VoiceControlInjected } from './index.ts'
import css from './VoiceControl.module.css'

/** Full mic-seat component props: runtime share (standard kit + InputZone owner) & injected share & locale seat. */
export type VoiceControlProps =
  PropsRuntime<'conversation.input.left'> & InjectFace<VoiceControlInjected> & PropsLocale<'voice'>

/**
 * How long a refused transcript insert waits for the draft revision to move before it is reported.
 * A refusal is normally a keystroke that landed between the input kit's publish and this seat's
 * effect, and the next publish arrives within a frame; one that outlives this window is not that
 * race, and retrying silently would leave the transcript nowhere.
 */
const INSERT_RETRY_WINDOW_MS = 500

/** A finished transcript on its way into the editor. */
interface PendingTranscript {
  /** Distinguishes two identical transcripts, so each is inserted once. */
  readonly seq: number
  readonly text: string
  readonly replace: boolean
}

/**
 * The composer's microphone control: records from the system microphone, sends the clip to the Host
 * for transcription, and splices the result into the draft.
 *
 * The lifecycle lives in {@link DictationController}; this component renders its state, forwards
 * gestures, and owns the one step that needs the input kit — putting the transcript into the editor.
 * The gesture (`toggle` or `hold`) and the insertion rule come from the Host's voice settings, so
 * this component reads policy rather than owning it.
 */
export function VoiceControl({
  useInput, inputActions, describeVoice, transcribe, polish, readDevice, insertText, t,
}: VoiceControlProps) {
  const draft = useInput(state => state.draft)
  const draftRev = useInput(state => state.draftRev)
  const occurrences = useInput(state => state.occurrences)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const [pending, setPending] = useState<PendingTranscript | null>(null)
  const sequenceRef = useRef(0)
  const insertedRef = useRef(0)
  const [elapsedMs, setElapsedMs] = useState(0)

  // The controller reads its collaborators through this ref, so a re-render that hands the seat new
  // callbacks never leaves a recording talking to stale ones.
  const depsRef = useRef<DictationDeps | null>(null)
  depsRef.current = {
    describeVoice,
    startRecording,
    transcribe,
    polish,
    readDevice,
    readDraft: () => draftRef.current,
    deliver: (text, replace) => {
      sequenceRef.current += 1
      setPending({ seq: sequenceRef.current, text, replace })
    },
  }
  const [controller] = useState(() => new DictationController(() => depsRef.current as DictationDeps))
  const { view, phase, level, interim, error, notice } = useSyncExternalStore(controller.subscribe, controller.getSnapshot)

  useEffect(() => controller.mount(), [controller])

  useEffect(() => {
    if (phase !== 'recording') return undefined
    const startedAt = performance.now()
    setElapsedMs(0)
    const tick = setInterval(() => { setElapsedMs(performance.now() - startedAt) }, 200)
    return () => { clearInterval(tick) }
  }, [phase])

  useEffect(() => {
    if (pending === null || insertedRef.current === pending.seq) return undefined
    if (insertText === undefined) {
      // No session scope to address the scoped verb: a composer this old has a plain-text draft and
      // no chips, so rebuilding it from text loses nothing.
      insertedRef.current = pending.seq
      inputActions.setDraft(pending.replace ? pending.text : appendTranscript(draft, pending.text))
      setPending(null)
      return undefined
    }
    // Spliced in place through the editor's span-checked verb. `setDraft` would rebuild the document
    // from the draft's plain-text projection and turn every reference chip into literal `@path` text.
    const plan = planTranscriptInsert({ draft, draftRev, occurrences }, pending.text, pending.replace)
    if (insertText(plan.text, plan.span)) {
      insertedRef.current = pending.seq
      setPending(null)
      return undefined
    }
    // Refused: the revision moved first. The next publish re-runs this effect against it; a refusal
    // that outlives the window is reported with the transcript, so the dictation is never lost silently.
    const giveUp = setTimeout(() => {
      insertedRef.current = pending.seq
      setPending(null)
      controller.report(`transcript not inserted: ${pending.text}`)
    }, INSERT_RETRY_WINDOW_MS)
    return () => { clearTimeout(giveUp) }
  }, [pending, draft, draftRev, occurrences, insertText, inputActions, controller])

  // An unmounted capability leaves the seat empty rather than showing a dead button: a deployment
  // that composed no provider pays no layout, the same contract the named composer seats keep.
  if (view === null || !view.available) return null

  const hold = view.interactionMode === 'hold'
  // Not disabled while starting: a disabled button receives no pointerup, and the hold gesture needs
  // the release that arrives during the permission prompt.
  const disabled = phase === 'transcribing'

  const onClick = (): void => {
    if (!hold) controller.press()
  }
  const onPointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    if (!hold || phase !== 'idle') return
    event.currentTarget.setPointerCapture(event.pointerId)
    controller.holdStart()
  }
  const onPointerUp = (): void => {
    if (hold) controller.holdEnd()
  }

  const working = phase === 'transcribing' || phase === 'polishing'
  const label = phase === 'recording'
    ? t('mic.recording.aria')
    : working ? t('mic.transcribing.aria') : t('mic.idle.aria')
  const title = !view.ready
    ? t('mic.unconfigured.title')
    : phase === 'recording'
      ? t('mic.recording.title')
      : phase === 'polishing'
        ? t('mic.polishing.title')
        : phase === 'transcribing'
          ? t('mic.transcribing.title')
          : hold ? t('mic.hold.title') : t('mic.idle.title')

  return (
    <span className={css.wrap}>
      <button
        type="button"
        className={`${css.button} ${phase === 'recording' ? css.recording : ''} ${working ? css.busy : ''}`}
        aria-label={label}
        aria-pressed={phase === 'recording'}
        aria-busy={phase === 'starting' || working}
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
        <>
          {/* A live level meter, not a spinner: it distinguishes "recording" from "hearing you",
              which is the difference between a dead mic and a working one. */}
          <span className={css.meter} aria-hidden>
            {[0, 1, 2].map(bar => (
              <span
                key={bar}
                className={css.bar}
                style={{ transform: `scaleY(${Math.max(0.15, Math.min(1, level * (bar === 1 ? 1.4 : 0.9)))})` }}
              />
            ))}
          </span>
          <span className={css.elapsed} role="timer">{Math.floor(elapsedMs / 1000)}s</span>
        </>
      )}
      {/* Provisional text never reaches the draft; the composer changes once, when dictation ends. */}
      {phase === 'recording' && interim !== '' && (
        <span className={css.interim} title={interim}>{interim}</span>
      )}
      {phase === 'polishing' && <span className={css.elapsed}>{t('mic.polishing.short')}</span>}
      {/* Information rather than failure (the duration cap, a released hold), so it reads in the
          secondary text colour; English by the same error-surface policy as the line below. */}
      {notice !== null && <span className={css.elapsed} role="status">{notice}</span>}
      {/* Failure copy stays English (error-surface policy: not localized). */}
      {error !== null && <span className={css.error} role="status" title={error}>{error}</span>}
    </span>
  )
}
