import { describe, expect, it } from 'vitest'
import { appendTranscript, detectLength, planTranscriptInsert } from '../src/client/draft.ts'

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

describe('planTranscriptInsert', () => {
  // A draft holding one reference chip, as the installed composer publishes it: the clipboard
  // projection spells the chip as its 11-character `@src/foo.ts`, the detect projection as one
  // placeholder, so the document is 10 characters shorter than the string.
  const withChip = { draft: 'see @src/foo.ts ', draftRev: 7, occurrences: [{ length: 11 }] }

  it('appends at the end of the DOCUMENT, not the end of the draft string, so the chip is untouched', () => {
    expect(planTranscriptInsert(withChip, 'please review', false)).toEqual({
      text: 'please review',
      span: { start: 6, end: 6, draftRev: 7 },
    })
  })

  it('separates a transcript from a chip or word it would otherwise weld onto', () => {
    const endsInChip = { draft: 'see @src/foo.ts', draftRev: 2, occurrences: [{ length: 11 }] }
    expect(planTranscriptInsert(endsInChip, 'now', false)).toEqual({ text: ' now', span: { start: 5, end: 5, draftRev: 2 } })
    expect(planTranscriptInsert({ draft: '', draftRev: 0 }, 'hello', false).text).toBe('hello')
  })

  it('replaces the whole document as one in-place splice', () => {
    expect(planTranscriptInsert(withChip, 'fresh', true)).toEqual({ text: 'fresh', span: { start: 0, end: 6, draftRev: 7 } })
  })

  it('measures a draft without chips as its own length', () => {
    expect(detectLength('line one\nline two', undefined)).toBe(17)
    expect(detectLength('', [])).toBe(0)
  })
})
