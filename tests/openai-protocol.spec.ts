import { describe, expect, it } from 'vitest'
import { isTranscriptionError } from '../src/transcription/index.ts'
import {
  ACCEPTED_MEDIA_TYPES, classifyHttpFailure, mediaTypeExtension, parseTranscriptionBody,
} from '../src/providers/openai-protocol.ts'

describe('mediaTypeExtension', () => {
  it('maps every advertised media type, so describe() cannot promise what transcribe() rejects', () => {
    for (const type of ACCEPTED_MEDIA_TYPES) expect(() => mediaTypeExtension(type)).not.toThrow()
  })

  it('ignores the codec parameter a recorder appends', () => {
    expect(mediaTypeExtension('audio/webm;codecs=opus')).toBe('webm')
    expect(mediaTypeExtension('AUDIO/WEBM')).toBe('webm')
  })

  it('maps aliases onto the extension the endpoint dispatches on', () => {
    expect(mediaTypeExtension('audio/mpeg')).toBe('mp3')
    expect(mediaTypeExtension('audio/x-wav')).toBe('wav')
  })

  it('classifies an undecodable type rather than guessing an extension', () => {
    try {
      mediaTypeExtension('audio/aiff')
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(isTranscriptionError(error) && error.code).toBe('unsupported-media-type')
    }
  })
})

describe('classifyHttpFailure', () => {
  it.each([401, 403])('reads %i as configuration, not a retryable outage', (status) => {
    expect(classifyHttpFailure(status, '').code).toBe('not-configured')
  })

  it('reads 413 as an oversized clip', () => {
    expect(classifyHttpFailure(413, '').code).toBe('clip-too-large')
  })

  it('reads any other status as a provider rejection and keeps the diagnostic', () => {
    const failure = classifyHttpFailure(500, 'upstream exploded')
    expect(failure.code).toBe('provider-rejected')
    expect(failure.message).toContain('500')
    expect(failure.message).toContain('upstream exploded')
  })

  it('omits the separator when no body could be read', () => {
    expect(classifyHttpFailure(502, '').message).toBe('endpoint returned 502')
  })
})

describe('parseTranscriptionBody', () => {
  it('trims the transcript', () => {
    expect(parseTranscriptionBody({ text: '  hello there \n' })).toEqual({ text: 'hello there' })
  })

  it('projects language and converts duration seconds to milliseconds', () => {
    expect(parseTranscriptionBody({ text: 'x', language: 'en', duration: 1.25 }))
      .toEqual({ text: 'x', language: 'en', durationMs: 1250 })
  })

  it('drops fields the endpoint reported in an unusable form', () => {
    expect(parseTranscriptionBody({ text: 'x', language: 7, duration: 'long' })).toEqual({ text: 'x' })
    expect(parseTranscriptionBody({ text: 'x', duration: Number.POSITIVE_INFINITY })).toEqual({ text: 'x' })
  })

  it('keeps an empty transcript as a success', () => {
    // Silence is a successful outcome the caller renders differently, not a failure.
    expect(parseTranscriptionBody({ text: '' })).toEqual({ text: '' })
  })

  it.each([null, undefined, 42, 'text', {}, { text: 5 }])('rejects an unusable body: %s', (payload) => {
    try {
      parseTranscriptionBody(payload)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(isTranscriptionError(error) && error.code).toBe('provider-rejected')
    }
  })
})
