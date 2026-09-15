/**
 * How a transcript joins the composer's existing text.
 *
 * The installed composer (`@deepseek-ai/dsh-client-ui-conversation` 0.1.5-rc.2) is a Lexical editor
 * whose draft can hold reference chips. Its public `inputActions.setDraft` rebuilds the whole
 * document from plain text, so writing a transcript through it turned every chip into literal
 * `@path` text and detached the reference. A transcript is therefore spliced in through the scoped
 * `slash/input-insert-text` verb, which edits the document in place — and this module computes where.
 * @module @achasoft/dsh-voice/client/draft
 */

/** The part of one reference occurrence the span arithmetic needs. */
export interface OccurrenceExtent {
  /** Length of the occurrence in the clipboard projection — its full `@path` text. */
  readonly length: number
}

/**
 * A draft span in the editor's detect coordinates, fenced with the revision it was measured at. The
 * shape of the input-trigger package's `TokenSpan`, restated because this package does not depend on
 * that one.
 */
export interface DraftSpan {
  readonly start: number
  readonly end: number
  readonly draftRev: number
}

/** One splice for the scoped insert-text verb. */
export interface TranscriptInsert {
  /** The text to write, including any separating space. */
  readonly text: string
  /** The span it replaces; collapsed at the end of the draft for an append. */
  readonly span: DraftSpan
}

/** The draft facts a splice is planned against, as the input standard kit publishes them. */
export interface DraftSnapshot {
  /** `InputState.draft`: the clipboard projection, chips spelled out as their `@path`. */
  readonly draft: string
  /** `InputState.draftRev`: the revision the editor fences every span against. */
  readonly draftRev: number
  /** `InputState.occurrences`: the chips; absent in composers that have none. */
  readonly occurrences?: readonly OccurrenceExtent[] | undefined
}

/**
 * Join a transcript onto an existing draft without gluing two words together or introducing a
 * leading space into an empty composer.
 * @param draft - the current composer text.
 * @param text - the transcript to append.
 * @returns the next whole draft.
 */
export function appendTranscript(draft: string, text: string): string {
  return `${draft}${separatorBefore(draft)}${text}`
}

/**
 * The whitespace a transcript needs in front of it.
 * @param draft - the text it lands after.
 * @returns a single space, or nothing when the draft is empty or already ends in whitespace.
 */
function separatorBefore(draft: string): string {
  return draft === '' || /\s$/u.test(draft) ? '' : ' '
}

/**
 * The end of the draft in the editor's detect coordinates.
 *
 * The draft string is the clipboard projection, in which each chip is its whole `@path`; the editor's
 * span-checked verbs measure the detect projection, in which each chip is one placeholder character.
 * Linebreaks and paragraph gaps are one character in both. A span at `draft.length` therefore points
 * past the end of the document as soon as the draft holds a chip, and the editor refuses it.
 * @param draft - the clipboard projection.
 * @param occurrences - the chips in it; absent reads as none.
 * @returns the document length the editor's verbs accept.
 */
export function detectLength(draft: string, occurrences: readonly OccurrenceExtent[] | undefined): number {
  let end = draft.length
  for (const occurrence of occurrences ?? []) end -= Math.max(0, occurrence.length - 1)
  return Math.max(0, end)
}

/**
 * Plan the splice that puts a transcript into the draft.
 *
 * An append is a collapsed span at the end of the document, so everything already there — chips
 * included — is untouched. A replace spans the whole document, which is what "replace" means; it is
 * still an in-place edit, so it is one undo step that brings the chips back.
 *
 * The end of the draft rather than the caret: a seat outside the editor can read a textarea's caret
 * but not a Lexical selection in detect coordinates, and the end is the composer's own answer when
 * it has no selection.
 * @param snapshot - the draft as the input kit last published it.
 * @param text - the transcript.
 * @param replace - whether the transcript replaces the draft rather than appending to it.
 * @returns the text and span for the insert-text verb.
 */
export function planTranscriptInsert(snapshot: DraftSnapshot, text: string, replace: boolean): TranscriptInsert {
  const end = detectLength(snapshot.draft, snapshot.occurrences)
  if (replace) return { text, span: { start: 0, end, draftRev: snapshot.draftRev } }
  return {
    text: `${separatorBefore(snapshot.draft)}${text}`,
    span: { start: end, end, draftRev: snapshot.draftRev },
  }
}
