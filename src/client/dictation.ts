/**
 * The microphone control's lifecycle, kept out of the component so every transition is testable
 * without a browser: start, the permission wait, recording, the automatic stops, transcription,
 * cleanup, and delivery of the transcript.
 *
 * The component used to own this with refs and a `phase` that stayed `idle` across the two awaits a
 * start involves (the capability probe and `getUserMedia`, which waits on a permission prompt). That
 * gap is where three defects lived: a second click started a second recording and orphaned the first
 * microphone stream; a hold-to-talk release during the prompt was ignored, so recording began
 * unheld; and the duration cap stopped the recorder without the control noticing. Here a start is an
 * explicit `starting` phase, and every async continuation carries the attempt number it belongs to —
 * a continuation whose attempt is no longer current releases what it acquired and changes nothing.
 * @module @achasoft/dsh-voice/client/dictation
 */

import type { VoiceCapabilityView, VoicePolishResult, VoiceTranscribeResult } from '../host/types.ts'
import { NO_SIGNAL_PEAK_RMS, isNonSpeechTranscript } from '../transcription/non-speech.ts'
import type { AutoStopReason, RecordedClip, RecordingRequest, RecordingSession } from './recorder.ts'

/** What the control is doing right now. */
export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing' | 'polishing'

/** Why a recording ended: the person's gesture, or one of the recorder's own bounds. */
export type StopReason = 'gesture' | AutoStopReason

/** Everything the control renders. Replaced, never mutated, so it can back `useSyncExternalStore`. */
export interface DictationState {
  /** The Host's capability view; null until the first probe answers. */
  readonly view: VoiceCapabilityView | null
  readonly phase: DictationPhase
  /** Display loudness, 0–1. */
  readonly level: number
  /** The latest provisional transcript; never written to the draft. */
  readonly interim: string
  /** A failure to show; English by the repository's error-surface policy. */
  readonly error: string | null
  /** Information that is not a failure, such as the duration cap ending a recording. */
  readonly notice: string | null
}

/** What the controller calls out to. Read through a getter so the component can rebind per render. */
export interface DictationDeps {
  readonly describeVoice: () => Promise<VoiceCapabilityView>
  readonly startRecording: (request: RecordingRequest) => Promise<RecordingSession>
  /**
   * Send one clip for transcription.
   * @param clip - the recording.
   * @param signal - aborted when the result is no longer wanted.
   */
  readonly transcribe: (clip: RecordedClip, signal: AbortSignal) => Promise<VoiceTranscribeResult>
  readonly polish: (text: string) => Promise<VoicePolishResult>
  readonly readDevice: () => string | undefined
  /** The composer's current draft text, for the "typed while dictating" comparison. */
  readonly readDraft: () => string
  /**
   * Put a finished transcript into the draft.
   * @param text - the transcript, polished when cleanup ran.
   * @param replace - whether it replaces the draft rather than appending.
   */
  readonly deliver: (text: string, replace: boolean) => void
}

/** Shown when a hold-to-talk press is released before the microphone opened. */
export const RELEASED_BEFORE_START = 'hold the button while you speak'

/** Shown when the provider found no speech, or the clip carried no signal to send. */
export const NOTHING_HEARD = 'nothing was heard'

/**
 * Failure copy for one transcription outcome. Error surfaces stay English by repository policy, so
 * these are literals rather than dictionary keys.
 * @param code - the classified failure from the Host.
 * @returns a short operator-facing line.
 */
export function describeFailure(code: string): string {
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
 * The notice for a recording the duration cap ended.
 * @param maxClipSeconds - the cap in force for that recording.
 * @returns the line shown beside the control.
 */
export function limitNotice(maxClipSeconds: number): string {
  return `stopped at the ${maxClipSeconds}s limit`
}

/**
 * A thrown value's message, or a fallback for values that carry none.
 * @param cause - the caught value.
 * @param fallback - the line to show otherwise.
 * @returns the message to render.
 */
function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message !== '' ? cause.message : fallback
}

/** A recording in progress, with the policy it was started under. */
interface LiveRecording {
  readonly attempt: number
  readonly session: RecordingSession
  readonly view: VoiceCapabilityView
  /** The draft when recording began; a `replace` only replaces a draft nobody typed into since. */
  readonly draftAtStart: string
}

const INITIAL: DictationState = {
  view: null, phase: 'idle', level: 0, interim: '', error: null, notice: null,
}

/** One composer seat's dictation state machine. */
export class DictationController {
  private state: DictationState = INITIAL
  private readonly listeners = new Set<() => void>()
  /** Incremented by every start, abandoned start, and unmount; continuations compare against it. */
  private attempt = 0
  private mounted = false
  private held = false
  private recording: LiveRecording | undefined
  /** An automatic stop that arrived while the session was still being handed back. */
  private pendingStop: AutoStopReason | undefined
  private previewAbort: AbortController | undefined
  private finalAbort: AbortController | undefined

  /** @param deps - read on every use, so the owner can hand in fresh callbacks each render. */
  constructor(private readonly deps: () => DictationDeps) {}

  /**
   * Subscribe to state changes.
   * @param listener - called after every change.
   * @returns the unsubscriber.
   */
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * The current state.
   * @returns the latest immutable snapshot.
   */
  readonly getSnapshot = (): DictationState => this.state

  /**
   * Attach to a mounted seat and probe the capability.
   *
   * Paired with the returned cleanup rather than a one-way dispose, because React's development mode
   * mounts, unmounts, and mounts again, and a controller that could only die once would be dead.
   * @returns the unmount cleanup, which releases the microphone and abandons every pending call.
   */
  mount(): () => void {
    this.mounted = true
    this.attempt += 1
    this.update({ phase: 'idle', level: 0, interim: '' })
    this.refresh()
    return () => { this.unmount() }
  }

  /** Toggle gesture: start when idle, stop when recording, and ignore presses while a start is pending. */
  press(): void {
    switch (this.state.phase) {
      case 'idle': void this.begin(); return
      case 'recording': void this.finish('gesture'); return
      case 'starting':
      case 'transcribing':
      case 'polishing':
        // A start waiting on the permission prompt must not be started again: the second start used
        // to replace the first session and orphan its open microphone.
        return
    }
  }

  /** Hold gesture, pressed. */
  holdStart(): void {
    if (this.state.phase !== 'idle') return
    this.held = true
    void this.begin()
  }

  /** Hold gesture, released (or cancelled by the browser). */
  holdEnd(): void {
    const wasHeld = this.held
    this.held = false
    if (this.state.phase === 'recording') {
      void this.finish('gesture')
      return
    }
    if (this.state.phase !== 'starting' || !wasHeld) return
    // Released before the microphone opened — typically to answer the permission prompt. Starting
    // anyway would record a person who has already let go, so the start is abandoned; the session
    // it produces is cancelled the moment it arrives.
    this.attempt += 1
    this.update({ phase: 'idle', level: 0, notice: RELEASED_BEFORE_START })
  }

  /**
   * Show a failure raised outside the lifecycle, such as a transcript the editor would not take.
   * @param error - the line to show.
   */
  report(error: string): void {
    this.update({ error })
  }

  /** Probe the capability for the idle render; a failed probe leaves the control hidden. */
  private refresh(): void {
    const attempt = this.attempt
    this.deps().describeVoice().then((view) => {
      if (this.mounted && attempt === this.attempt && this.state.view === null) this.update({ view })
    }, () => {
      // A failed probe leaves `view` null, which renders nothing — the same state a deployment
      // without a provider produces. The next gesture probes again and reports its own failure.
    })
  }

  /**
   * Whether a continuation still belongs to the live attempt.
   * @param attempt - the attempt the continuation captured.
   * @returns false after an unmount, an abandoned start, or a newer start.
   */
  private isCurrent(attempt: number): boolean {
    return this.mounted && attempt === this.attempt
  }

  /** Probe policy, open the microphone, and enter `recording` — or release everything if superseded. */
  private async begin(): Promise<void> {
    this.attempt += 1
    const attempt = this.attempt
    this.pendingStop = undefined
    this.update({ phase: 'starting', error: null, notice: null, interim: '', level: 0 })
    const deps = this.deps()

    // Re-read policy at the gesture: a settings change between mount and now must take effect. A
    // failed probe falls back to the last view rather than failing the gesture outright.
    const current = await deps.describeVoice().catch(() => this.state.view)
    if (!this.isCurrent(attempt)) return
    if (current === null || !current.ready) {
      this.update({ view: current ?? this.state.view, phase: 'idle', error: current?.detail ?? 'transcription is not configured' })
      return
    }
    this.update({ view: current })

    const draftAtStart = deps.readDraft()
    const deviceId = deps.readDevice()
    let session: RecordingSession
    try {
      session = await deps.startRecording({
        accepted: current.acceptedMediaTypes,
        maxMs: current.maxClipSeconds * 1000,
        ...deviceId === undefined ? {} : { deviceId },
        ...current.silenceStopMs === undefined ? {} : { silenceStopMs: current.silenceStopMs },
        ...current.liveIntervalMs === undefined ? {} : { liveIntervalMs: current.liveIntervalMs },
        onLevel: (level) => {
          if (this.isCurrent(attempt) && this.state.phase === 'recording') this.update({ level })
        },
        onInterim: (clip) => { this.preview(attempt, clip) },
        // Silence and the duration cap end the recording the same way a gesture does. Only the
        // current attempt's recorder may stop it: an orphan's silence timer used to stop the live one.
        onAutoStop: (reason) => { this.autoStop(attempt, reason) },
      })
    } catch (cause) {
      if (this.isCurrent(attempt)) this.update({ phase: 'idle', error: messageOf(cause, 'could not open the microphone') })
      return
    }
    if (!this.isCurrent(attempt)) {
      // Superseded while the permission prompt was open: this stream was acquired for nobody.
      session.cancel()
      return
    }
    this.recording = { attempt, session, view: current, draftAtStart }
    this.update({ phase: 'recording' })
    const stop = this.pendingStop
    this.pendingStop = undefined
    if (stop !== undefined) void this.finish(stop)
  }

  /**
   * React to the recorder ending capture on its own.
   * @param attempt - the attempt whose recorder fired.
   * @param reason - silence or the duration cap.
   */
  private autoStop(attempt: number, reason: AutoStopReason): void {
    if (!this.isCurrent(attempt)) return
    if (this.recording === undefined) {
      this.pendingStop = reason
      return
    }
    void this.finish(reason)
  }

  /**
   * Run one provisional pass. Dropped rather than queued while one is in flight, and cancelled when
   * the recording stops, so a stale preview never holds a Host transcription slot the final pass needs.
   * @param attempt - the recording's attempt.
   * @param clip - everything captured so far.
   */
  private preview(attempt: number, clip: RecordedClip): void {
    if (!this.isCurrent(attempt) || this.state.phase !== 'recording' || this.previewAbort !== undefined) return
    const controller = new AbortController()
    this.previewAbort = controller
    this.deps().transcribe(clip, controller.signal).then((result) => {
      if (controller.signal.aborted || !this.isCurrent(attempt) || this.state.phase !== 'recording') return
      if (result.ok && !isNonSpeechTranscript(result.text, clip.peakLevel)) this.update({ interim: result.text })
    }, () => {
      // A provisional pass that fails — or is aborted by the stop — is not a failure the person
      // needs to see; the final pass reports its own outcome.
    }).finally(() => {
      if (this.previewAbort === controller) this.previewAbort = undefined
    })
  }

  /**
   * Stop capture, transcribe, optionally polish, and deliver. Never rejects: every failure becomes
   * state, which is why callers may start it without awaiting.
   * @param reason - what ended the recording.
   */
  private async finish(reason: StopReason): Promise<void> {
    const recording = this.recording
    if (recording === undefined) return
    this.recording = undefined
    this.previewAbort?.abort()
    this.previewAbort = undefined
    const { attempt, session, view, draftAtStart } = recording
    const final = new AbortController()
    this.finalAbort = final
    this.update({
      phase: 'transcribing',
      level: 0,
      interim: '',
      ...reason === 'limit' ? { notice: limitNotice(view.maxClipSeconds) } : {},
    })
    const deps = this.deps()
    try {
      // stop() releases the stream, the meter, and the cap timer whatever the reason was.
      const clip = await session.stop()
      if (!this.isCurrent(attempt)) return
      // A clip with no signal at all is not sent: the provider would only invent a word for it.
      if (clip.peakLevel < NO_SIGNAL_PEAK_RMS) {
        this.update({ error: NOTHING_HEARD })
        return
      }
      const result = await deps.transcribe(clip, final.signal)
      if (!this.isCurrent(attempt)) return
      if (!result.ok) {
        this.update({ error: describeFailure(result.code) })
        return
      }
      if (isNonSpeechTranscript(result.text, clip.peakLevel)) {
        this.update({ error: NOTHING_HEARD })
        return
      }

      let text = result.text
      if (view.polish) {
        this.update({ phase: 'polishing' })
        // A failed cleanup is not a failed dictation: the raw transcript is always usable, so the
        // failure is replaced by the original text rather than reported.
        const polished = await deps.polish(text).catch(() => null)
        if (!this.isCurrent(attempt)) return
        if (polished !== null && polished.ok && polished.text !== '') text = polished.text
      }

      // `replace` becomes `append` when the person typed while dictating — discarding their
      // keystrokes to honour a preference they set earlier is never what they meant.
      deps.deliver(text, view.insertMode === 'replace' && deps.readDraft() === draftAtStart)
    } catch (cause) {
      if (this.isCurrent(attempt)) this.update({ error: messageOf(cause, 'transcription failed') })
    } finally {
      if (this.finalAbort === final) this.finalAbort = undefined
      if (this.isCurrent(attempt)) this.update({ phase: 'idle', interim: '' })
    }
  }

  /** Release the microphone and abandon every pending call; the seat is gone. */
  private unmount(): void {
    this.mounted = false
    this.attempt += 1
    this.held = false
    this.pendingStop = undefined
    // A seat unmounting mid-recording must not leave the microphone indicator lit. A start still
    // waiting on the prompt is covered by the attempt bump: its session is cancelled on arrival.
    this.recording?.session.cancel()
    this.recording = undefined
    this.previewAbort?.abort()
    this.previewAbort = undefined
    this.finalAbort?.abort()
    this.finalAbort = undefined
  }

  /**
   * Replace the state and notify.
   * @param patch - the fields that change.
   */
  private update(patch: Partial<DictationState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) listener()
  }
}
