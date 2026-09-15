import { describe, expect, it } from 'vitest'
import { LOW_ENERGY_PEAK_RMS, isNonSpeechTranscript } from '../src/transcription/non-speech.ts'

// Levels measured with whisper-cli 1.9.4 + ggml-base.en on generated fixtures: digital silence 0,
// ±0.004 white noise 0.0024, ±0.02 white noise 0.012, a synthesized spoken "you" 0.16.
const SILENT = 0
const NOISE = 0.012
const SPOKEN = 0.16

describe('isNonSpeechTranscript', () => {
  it('treats the reproduced silent-clip output as empty when the clip was quiet', () => {
    // whisper-cli stdout on a silent WAV was "\n you".
    expect(isNonSpeechTranscript('\n you', SILENT)).toBe(true)
    expect(isNonSpeechTranscript('Thank you.', NOISE)).toBe(true)
  })

  it('keeps a genuinely dictated one-word stock phrase when the audio was loud', () => {
    // whisper-cli stdout on a spoken "you" was "\n You." — real speech must survive.
    expect(isNonSpeechTranscript('You.', SPOKEN)).toBe(false)
    expect(isNonSpeechTranscript('Thanks', LOW_ENERGY_PEAK_RMS)).toBe(false)
  })

  it('drops annotation-only output whatever the level, because it is never speech', () => {
    expect(isNonSpeechTranscript('(machine whirring)', NOISE)).toBe(true)
    expect(isNonSpeechTranscript('[BLANK_AUDIO]', SPOKEN)).toBe(true)
    expect(isNonSpeechTranscript(' *music*  (applause) ', undefined)).toBe(true)
    expect(isNonSpeechTranscript('♪', undefined)).toBe(true)
  })

  it('keeps ordinary quiet dictation that is not a stock phrase', () => {
    expect(isNonSpeechTranscript('yes', NOISE)).toBe(false)
    expect(isNonSpeechTranscript('you should refactor this (later)', NOISE)).toBe(false)
  })

  it('applies only the annotation rule when the caller could not measure the audio', () => {
    expect(isNonSpeechTranscript('you', undefined)).toBe(false)
    expect(isNonSpeechTranscript('   ', undefined)).toBe(true)
  })
})
