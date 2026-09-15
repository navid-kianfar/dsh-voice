/**
 * Admission control for transcription on one Host. Separated from the service so the queueing rule —
 * how many run, how many wait, what a cancelled waiter does — is testable without a Cordis context.
 * @module @achasoft/dsh-voice/host/transcription-gate
 */

/**
 * Transcriptions allowed to run at once on this Host.
 *
 * whisper.cpp uses every thread it is given for one inference, so two local runs already contend for
 * the same cores and a third only makes all of them slower; a hosted provider is billed per call and
 * gains nothing from a burst either. Two rather than one so a person's final pass is not held behind
 * another tab's provisional pass.
 */
export const MAX_RUNNING_TRANSCRIPTIONS = 2

/**
 * Transcriptions allowed to wait for a slot. Past this the Host answers "busy" at once: a clip queued
 * behind many others would outlive the provider timeout and the person's patience, and every waiter
 * holds its decoded audio in memory.
 */
export const MAX_WAITING_TRANSCRIPTIONS = 4

/** One queued caller. */
interface Waiter {
  /** Hand the caller its slot. */
  readonly admit: () => void
}

/** A counting semaphore with a bounded, cancellable wait queue. */
export class TranscriptionGate {
  private running = 0
  private readonly waiting: Waiter[] = []

  /**
   * @param maxRunning - concurrent runs allowed.
   * @param maxWaiting - callers allowed to queue for a slot.
   */
  constructor(
    private readonly maxRunning: number = MAX_RUNNING_TRANSCRIPTIONS,
    private readonly maxWaiting: number = MAX_WAITING_TRANSCRIPTIONS,
  ) {}

  /** Runs in progress plus callers queued; for diagnostics and tests. */
  get load(): { readonly running: number; readonly waiting: number } {
    return { running: this.running, waiting: this.waiting.length }
  }

  /**
   * Run one task once a slot is free.
   * @param signal - the caller's cancellation; a caller cancelled while queued leaves the queue
   *   without ever running, and its rejection is the signal's reason.
   * @param task - the work to run inside the slot.
   * @returns the task's result, or `undefined` when the queue is already full — the caller turns that
   *   into its own "busy" answer rather than this module inventing one.
   */
  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<{ readonly value: T } | undefined> {
    signal.throwIfAborted()
    if (this.running >= this.maxRunning) {
      if (this.waiting.length >= this.maxWaiting) return undefined
      await this.wait(signal)
    } else {
      this.running += 1
    }
    try {
      return { value: await task() }
    } finally {
      this.release()
    }
  }

  /**
   * Queue for a slot. The slot is transferred by {@link release} directly to the waiter, so `running`
   * is never decremented and re-incremented around a hand-off a third caller could steal.
   * @param signal - cancellation while queued.
   * @returns once this caller holds a slot.
   */
  private wait(signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        const index = this.waiting.indexOf(waiter)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(signal.reason)
      }
      const waiter: Waiter = {
        admit: () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
      }
      this.waiting.push(waiter)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Give a finished run's slot to the next waiter, or free it. */
  private release(): void {
    const next = this.waiting.shift()
    if (next === undefined) {
      this.running -= 1
      return
    }
    next.admit()
  }
}
