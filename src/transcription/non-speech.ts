/**
 * What counts as "nothing was said". Whisper-family models do not return empty text for silence:
 * on a silent or near-silent clip they emit a non-speech annotation (`(machine whirring)`,
 * `[BLANK_AUDIO]`) or a short phrase from their training data (`you`, `Thank you.`). Both reached the
 * composer as if the person had dictated them.
 *
 * The decision is split by how much evidence it needs. A transcript made only of annotations is
 * never speech, whatever the audio sounded like. A known stock phrase IS a plausible dictation —
 * someone can say "thank you" — so it is dropped only when the caller has measured the audio and
 * found it quiet. Loudness is the fact that separates the two readings; the text alone cannot.
 *
 * Pure and free of Cordis and browser globals, so the browser control and the Host provider apply
 * the same rule.
 * @module @achasoft/dsh-voice/transcription/non-speech
 */

/**
 * Peak short-window RMS (full scale = 1) below which a clip carried no signal at all. Digital silence
 * is 0 and a quiet room on a laptop microphone sits around 0.001–0.003; the quietest intelligible
 * speech measured against whisper.cpp sits two orders of magnitude higher. A clip under this is not
 * worth a transcription call.
 */
export const NO_SIGNAL_PEAK_RMS = 0.005

/**
 * Peak short-window RMS below which a clip is too quiet for a stock phrase to be believed. Equal to
 * the recorder's silence level, so "never heard speech" means the same thing on both sides.
 */
export const LOW_ENERGY_PEAK_RMS = 0.02

/**
 * One or more bracketed, parenthesized, or starred annotations and nothing else — whisper's
 * non-speech vocabulary (`[BLANK_AUDIO]`, `(wind blowing)`, `*music*`), plus bare music notes.
 */
const ANNOTATION_ONLY = /^(?:\s*(?:\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]+))+\s*$/u

/**
 * Stock phrases whisper models produce on silence, compared after lowercasing and stripping
 * punctuation. Deliberately short: every entry is a phrase a person could genuinely dictate, which
 * is why the list is only consulted for a clip already measured as quiet.
 */
const STOCK_PHRASES: ReadonlySet<string> = new Set([
  'you',
  'thank you',
  'thanks',
  'thanks for watching',
  'thank you for watching',
  'bye',
])

/**
 * Normalize a transcript for the stock-phrase comparison.
 * @param text - the provider's transcript.
 * @returns lowercased words joined by single spaces, punctuation removed.
 */
function normalizePhrase(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().replace(/\s+/gu, ' ')
}

/**
 * Decide whether a transcript describes silence rather than speech.
 * @param text - the provider's transcript, trimmed or not.
 * @param peakRms - the clip's measured peak short-window RMS; undefined when the caller could not
 *   measure it, in which case only the annotation rule applies.
 * @returns true when the transcript should be treated as empty.
 */
export function isNonSpeechTranscript(text: string, peakRms: number | undefined): boolean {
  const trimmed = text.trim()
  if (trimmed === '') return true
  if (ANNOTATION_ONLY.test(trimmed)) return true
  if (peakRms === undefined || peakRms >= LOW_ENERGY_PEAK_RMS) return false
  return STOCK_PHRASES.has(normalizePhrase(trimmed))
}
