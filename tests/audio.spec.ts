import { describe, expect, it } from 'vitest'
import {
  PREFERRED_CONTAINERS, WAV_SAMPLE_RATE, bareMediaType, chooseDirectContainer, encodeWav, toBase64,
} from '../src/client/audio.ts'

const supportsAll = (): boolean => true
const supportsNone = (): boolean => false

describe('chooseDirectContainer', () => {
  it('prefers the smallest useful upload the provider accepts', () => {
    expect(chooseDirectContainer(['audio/webm', 'audio/mp4'], supportsAll)).toBe('audio/webm;codecs=opus')
  })

  it('falls through to a container both sides support', () => {
    const safariOnly = (type: string): boolean => type === 'audio/mp4'
    expect(chooseDirectContainer(['audio/mp4', 'audio/webm'], safariOnly)).toBe('audio/mp4')
  })

  it('accepts anything when the provider narrows nothing', () => {
    expect(chooseDirectContainer([], supportsAll)).toBe(PREFERRED_CONTAINERS[0])
  })

  it('returns undefined for a WAV-only provider, which is what triggers re-encoding', () => {
    // whisper.cpp reads 16 kHz mono WAV and no browser records it, so there is never a direct match.
    expect(chooseDirectContainer(['audio/wav'], supportsAll)).toBeUndefined()
  })

  it('returns undefined when the browser can record nothing', () => {
    expect(chooseDirectContainer(['audio/webm'], supportsNone)).toBeUndefined()
  })

  it('matches on the bare type, ignoring the codec parameter', () => {
    expect(bareMediaType('audio/webm;codecs=opus')).toBe('audio/webm')
  })
})

describe('encodeWav', () => {
  const samples = Float32Array.from([0, 0.5, -0.5, 1, -1])
  const wav = encodeWav(samples, WAV_SAMPLE_RATE)
  const view = new DataView(wav.buffer)
  const ascii = (at: number, length: number): string =>
    String.fromCharCode(...wav.subarray(at, at + length))

  it('writes a 44-byte header followed by 16-bit samples', () => {
    expect(wav.byteLength).toBe(44 + samples.length * 2)
    expect(ascii(0, 4)).toBe('RIFF')
    expect(ascii(8, 4)).toBe('WAVE')
    expect(ascii(36, 4)).toBe('data')
  })

  it('declares mono PCM at the requested rate', () => {
    expect(view.getUint16(20, true)).toBe(1)               // PCM
    expect(view.getUint16(22, true)).toBe(1)               // channels
    expect(view.getUint32(24, true)).toBe(WAV_SAMPLE_RATE)
    expect(view.getUint32(28, true)).toBe(WAV_SAMPLE_RATE * 2) // byte rate
    expect(view.getUint16(34, true)).toBe(16)              // bits per sample
  })

  it('states its own sizes consistently', () => {
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2)
    expect(view.getUint32(40, true)).toBe(samples.length * 2)
  })

  it('maps full scale without wrapping', () => {
    // +1 must not overflow into a negative int16, which is the classic clipping bug.
    expect(view.getInt16(44 + 3 * 2, true)).toBe(32767)
    expect(view.getInt16(44 + 4 * 2, true)).toBe(-32768)
  })

  it('clamps samples outside [-1, 1]', () => {
    const loud = encodeWav(Float32Array.from([4, -4]), WAV_SAMPLE_RATE)
    const loudView = new DataView(loud.buffer)
    expect(loudView.getInt16(44, true)).toBe(32767)
    expect(loudView.getInt16(46, true)).toBe(-32768)
  })

  it('encodes an empty recording as a header-only file', () => {
    expect(encodeWav(new Float32Array(0), WAV_SAMPLE_RATE).byteLength).toBe(44)
  })
})

describe('toBase64', () => {
  it('round-trips through the platform decoder', () => {
    const bytes = Uint8Array.from([0, 1, 254, 255, 128])
    expect(Uint8Array.from(atob(toBase64(bytes)), c => c.charCodeAt(0))).toEqual(bytes)
  })

  it('handles input past the argument-spread limit', () => {
    // A single String.fromCharCode(...bytes) throws on inputs this size; the chunking is the point.
    const long = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 256)
    expect(Uint8Array.from(atob(toBase64(long)), c => c.charCodeAt(0))).toEqual(long)
  })

  it('encodes nothing as the empty string', () => {
    expect(toBase64(new Uint8Array(0))).toBe('')
  })
})
