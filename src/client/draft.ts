/**
 * How a transcript joins the composer's existing text.
 * @module @achasoft/dsh-voice/client/draft
 */

/**
 * Join a transcript onto an existing draft without gluing two words together or introducing a
 * leading space into an empty composer.
 * @param draft - the current composer text.
 * @param text - the transcript to append.
 * @returns the next whole draft.
 */
export function appendTranscript(draft: string, text: string): string {
  if (draft === '') return text
  return /\s$/.test(draft) ? `${draft}${text}` : `${draft} ${text}`
}
