import { describe, expect, it } from 'vitest'
import { appendTranscript } from '../src/client/draft.ts'

describe('appendTranscript', () => {
  it('replaces an empty draft without a leading space', () => {
    expect(appendTranscript('', 'hello')).toBe('hello')
  })

  it('separates words that would otherwise glue together', () => {
    expect(appendTranscript('write a', 'test')).toBe('write a test')
  })

  it('does not double an existing trailing space', () => {
    expect(appendTranscript('write a ', 'test')).toBe('write a test')
    expect(appendTranscript('line\n', 'next')).toBe('line\nnext')
  })
})
