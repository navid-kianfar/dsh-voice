import { describe, expect, it, vi } from 'vitest'
import {
  DictationController, NOTHING_HEARD, RELEASED_BEFORE_START, limitNotice, type DictationDeps,
} from '../src/client/dictation.ts'
import type { VoiceCapabilityView, VoiceTranscribeResult } from '../src/host/types.ts'
import type { RecordedClip, RecordingRequest, RecordingSession } from '../src/client/recorder.ts'

const VIEW: VoiceCapabilityView = {
  available: true, ready: true, acceptedMediaTypes: ['audio/wav'], maxClipSeconds: 120, maxClipBytes: 1 << 20,
  interactionMode: 'toggle', insertMode: 'append', polish: false, liveIntervalMs: 1000,
}
const LOUD: RecordedClip = { base64: 'AAAA', mimeType: 'audio/wav', durationMs: 900, peakLevel: 0.2 }

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

/** Let every queued continuation run. */
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

/** A fake recorder session whose stop yields a chosen clip. */
function fakeSession(clip: RecordedClip = LOUD) {
  const session = { stop: vi.fn(() => Promise.resolve(clip)), cancel: vi.fn() }
  return session as typeof session & RecordingSession
}

/** A controller over fakes; each startRecording call hands out the next queued start. */
function harness(overrides: Partial<DictationDeps> = {}) {
  const requests: RecordingRequest[] = []
  const starts: ReturnType<typeof deferred<RecordingSession>>[] = []
  const delivered: { text: string; replace: boolean }[] = []
  let draft = ''
  const deps: DictationDeps = {
    describeVoice: () => Promise.resolve(VIEW),
    startRecording: (request) => {
      requests.push(request)
      const start = deferred<RecordingSession>()
      starts.push(start)
      return start.promise
    },
    transcribe: () => Promise.resolve({ ok: true, text: 'hello world' }),
    polish: text => Promise.resolve({ ok: true, text }),
    readDevice: () => undefined,
    readDraft: () => draft,
    deliver: (text, replace) => { delivered.push({ text, replace }) },
    ...overrides,
  }
  const controller = new DictationController(() => deps)
  const unmount = controller.mount()
  return {
    controller, unmount, requests, starts, delivered,
    setDraft: (next: string) => { draft = next },
    state: () => controller.getSnapshot(),
  }
}

describe('DictationController — starting (finding 3)', () => {
  it('holds a "starting" phase across the permission wait and ignores a second press', async () => {
    const h = harness()
    h.controller.press()
    await settle()
    expect(h.state().phase).toBe('starting')
    h.controller.press()
    h.controller.press()
    await settle()
    expect(h.requests).toHaveLength(1)
    const session = fakeSession()
    h.starts[0]!.resolve(session)
    await settle()
    expect(h.state().phase).toBe('recording')
  })

  it('cancels a stream that arrives after the seat unmounted, so the microphone is released', async () => {
    const h = harness()
    h.controller.press()
    await settle()
    h.unmount()
    const session = fakeSession()
    h.starts[0]!.resolve(session)
    await settle()
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(h.state().phase).not.toBe('recording')
  })

  it('cancels the live session on unmount and ignores its late automatic stop', async () => {
    const h = harness()
    h.controller.press()
    await settle()
    const session = fakeSession()
    h.starts[0]!.resolve(session)
    await settle()
    h.unmount()
    expect(session.cancel).toHaveBeenCalledTimes(1)
    h.requests[0]!.onAutoStop?.('silence')
    await settle()
    expect(session.stop).not.toHaveBeenCalled()
  })

  it('never lets a superseded recorder stop the live recording', async () => {
    const h = harness()
    // First attempt: a hold released during the prompt, so its recorder is an orphan.
    h.controller.holdStart()
    await settle()
    h.controller.holdEnd()
    const orphan = fakeSession()
    h.starts[0]!.resolve(orphan)
    await settle()
    // Second attempt records for real.
    h.controller.press()
    await settle()
    const live = fakeSession()
    h.starts[1]!.resolve(live)
    await settle()
    h.requests[0]!.onAutoStop?.('silence')
    await settle()
    expect(orphan.cancel).toHaveBeenCalled()
    expect(live.stop).not.toHaveBeenCalled()
    expect(h.state().phase).toBe('recording')
  })
})

describe('DictationController — hold released before recording started (finding 4)', () => {
  it('abandons the start, tells the person why, and cancels the stream when it arrives', async () => {
    const h = harness()
    h.controller.holdStart()
    await settle()
    expect(h.state().phase).toBe('starting')
    h.controller.holdEnd()
    expect(h.state()).toMatchObject({ phase: 'idle', notice: RELEASED_BEFORE_START })
    const session = fakeSession()
    h.starts[0]!.resolve(session)
    await settle()
    expect(session.cancel).toHaveBeenCalledTimes(1)
    expect(h.state().phase).toBe('idle')
  })

  it('stops and transcribes when released after recording started', async () => {
    const h = harness()
    h.controller.holdStart()
    await settle()
    const session = fakeSession()
    h.starts[0]!.resolve(session)
    await settle()
    h.controller.holdEnd()
    await settle()
    expect(session.stop).toHaveBeenCalledTimes(1)
    expect(h.delivered).toEqual([{ text: 'hello world', replace: false }])
  })
})

describe('DictationController — automatic stops (finding 2)', () => {
  it('finalizes a recording the duration cap ended, exactly like silence, and says the cap was hit', async () => {
    const h = harness()
    h.controller.press()
    await settle()
    const session = fakeSession()
    h.starts[0]!.resolve(session)
    await settle()
    h.requests[0]!.onAutoStop?.('limit')
    expect(h.state().phase).toBe('transcribing')
    await settle()
    expect(session.stop).toHaveBeenCalledTimes(1)
    expect(h.delivered).toEqual([{ text: 'hello world', replace: false }])
    expect(h.state()).toMatchObject({ phase: 'idle', notice: limitNotice(120), level: 0 })
  })

  it('finalizes on silence without a notice', async () => {
    const h = harness()
    h.controller.press()
    await settle()
    h.starts[0]!.resolve(fakeSession())
    await settle()
    h.requests[0]!.onAutoStop?.('silence')
    await settle()
    expect(h.delivered).toHaveLength(1)
    expect(h.state()).toMatchObject({ phase: 'idle', notice: null })
  })
})

describe('DictationController — silence and hallucinations (finding 5)', () => {
  it('does not send a clip that carried no signal', async () => {
    const transcribe = vi.fn(() => Promise.resolve<VoiceTranscribeResult>({ ok: true, text: 'you' }))
    const h = harness({ transcribe })
    h.controller.press()
    await settle()
    h.starts[0]!.resolve(fakeSession({ ...LOUD, peakLevel: 0 }))
    await settle()
    h.controller.press()
    await settle()
    expect(transcribe).not.toHaveBeenCalled()
    expect(h.state().error).toBe(NOTHING_HEARD)
    expect(h.delivered).toEqual([])
  })

  it('treats the stock "you" on a quiet clip as nothing heard', async () => {
    const h = harness({ transcribe: () => Promise.resolve({ ok: true, text: 'you' }) })
    h.controller.press()
    await settle()
    h.starts[0]!.resolve(fakeSession({ ...LOUD, peakLevel: 0.01 }))
    await settle()
    h.controller.press()
    await settle()
    expect(h.state().error).toBe(NOTHING_HEARD)
    expect(h.delivered).toEqual([])
  })

  it('delivers a real one-word dictation on a loud clip', async () => {
    const h = harness({ transcribe: () => Promise.resolve({ ok: true, text: 'You.' }) })
    h.controller.press()
    await settle()
    h.starts[0]!.resolve(fakeSession())
    await settle()
    h.controller.press()
    await settle()
    expect(h.delivered).toEqual([{ text: 'You.', replace: false }])
  })
})

describe('DictationController — provisional passes (finding 7)', () => {
  it('aborts the in-flight preview when the recording stops', async () => {
    const signals: AbortSignal[] = []
    const h = harness({
      transcribe: (_clip, signal) => {
        signals.push(signal)
        return signals.length === 1 ? new Promise<VoiceTranscribeResult>(() => {}) : Promise.resolve({ ok: true, text: 'final' })
      },
    })
    h.controller.press()
    await settle()
    h.starts[0]!.resolve(fakeSession())
    await settle()
    h.requests[0]!.onInterim?.(LOUD)
    h.requests[0]!.onInterim?.(LOUD)
    expect(signals).toHaveLength(1)
    h.controller.press()
    await settle()
    expect(signals[0]!.aborted).toBe(true)
    expect(signals[1]!.aborted).toBe(false)
    expect(h.delivered).toEqual([{ text: 'final', replace: false }])
  })
})

describe('DictationController — insertion policy', () => {
  it('replaces only a draft nobody typed into while dictating', async () => {
    const h = harness({ describeVoice: () => Promise.resolve({ ...VIEW, insertMode: 'replace' }) })
    h.setDraft('before')
    h.controller.press()
    await settle()
    h.starts[0]!.resolve(fakeSession())
    await settle()
    h.controller.press()
    await settle()
    h.setDraft('before')
    expect(h.delivered.at(-1)).toEqual({ text: 'hello world', replace: true })

    h.controller.press()
    await settle()
    h.starts[1]!.resolve(fakeSession())
    await settle()
    h.setDraft('before and typed')
    h.controller.press()
    await settle()
    expect(h.delivered.at(-1)).toEqual({ text: 'hello world', replace: false })
  })
})
