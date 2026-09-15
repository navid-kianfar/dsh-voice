import { describe, expect, it } from 'vitest'
import { TranscriptionGate } from '../src/host/transcription-gate.ts'

/** A task the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

const never = new AbortController().signal

describe('TranscriptionGate', () => {
  it('runs up to the limit at once and queues the rest in arrival order', async () => {
    const gate = new TranscriptionGate(1, 2)
    const order: string[] = []
    const first = deferred<string>()
    const a = gate.run(never, () => { order.push('a'); return first.promise })
    const b = gate.run(never, () => { order.push('b'); return Promise.resolve('b') })
    const c = gate.run(never, () => { order.push('c'); return Promise.resolve('c') })
    await Promise.resolve()
    expect(order).toEqual(['a'])
    expect(gate.load).toEqual({ running: 1, waiting: 2 })
    first.resolve('a')
    await expect(Promise.all([a, b, c])).resolves.toEqual([{ value: 'a' }, { value: 'b' }, { value: 'c' }])
    expect(order).toEqual(['a', 'b', 'c'])
    expect(gate.load).toEqual({ running: 0, waiting: 0 })
  })

  it('refuses at once when the queue is full rather than growing it', async () => {
    const gate = new TranscriptionGate(1, 1)
    const hold = deferred<void>()
    const running = gate.run(never, () => hold.promise)
    const queued = gate.run(never, () => Promise.resolve())
    await expect(gate.run(never, () => Promise.resolve())).resolves.toBeUndefined()
    hold.resolve()
    await Promise.all([running, queued])
  })

  it('removes a caller cancelled while queued, so it never runs and frees its place', async () => {
    const gate = new TranscriptionGate(1, 1)
    const hold = deferred<void>()
    const running = gate.run(never, () => hold.promise)
    const controller = new AbortController()
    let ran = false
    const queued = gate.run(controller.signal, () => { ran = true; return Promise.resolve() })
    controller.abort(new Error('stopped'))
    await expect(queued).rejects.toThrow('stopped')
    expect(gate.load.waiting).toBe(0)
    hold.resolve()
    await running
    expect(ran).toBe(false)
    expect(gate.load).toEqual({ running: 0, waiting: 0 })
  })

  it('releases the slot when a task fails', async () => {
    const gate = new TranscriptionGate(1, 0)
    await expect(gate.run(never, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom')
    await expect(gate.run(never, () => Promise.resolve(1))).resolves.toEqual({ value: 1 })
  })
})
