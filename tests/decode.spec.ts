import { describe, expect, it } from 'vitest'
import { Buffer } from 'node:buffer'
import { decodeAudio } from '../src/host/decode.ts'

describe('decodeAudio', () => {
  it('decodes padded and unpadded standard base64 alike', () => {
    expect(decodeAudio(Buffer.from('hi').toString('base64'))).toEqual(new Uint8Array([104, 105]))
    expect(decodeAudio('aGk')).toEqual(new Uint8Array([104, 105]))
  })

  it('accepts an empty payload, leaving the empty-audio decision to the provider', () => {
    // The Host distinguishes "not decodable" from "decoded to nothing": only the second is a clip
    // the capability can classify as `empty-audio`.
    expect(decodeAudio('')).toEqual(new Uint8Array([]))
  })

  it('rejects characters outside the standard alphabet', () => {
    expect(decodeAudio('aGk!')).toBeUndefined()
    expect(decodeAudio('a-_k')).toBeUndefined()
  })

  it('rejects a payload Buffer would silently truncate', () => {
    // A lone trailing character carries no whole byte; Buffer.from drops it rather than failing, so
    // the round trip is what catches it.
    expect(decodeAudio('aGkx1')).toBeUndefined()
  })

  it('returns bytes detached from the Buffer pool', () => {
    const bytes = decodeAudio(Buffer.from('hi').toString('base64'))
    expect(bytes).toBeDefined()
    // A pooled Buffer's ArrayBuffer is far larger than its view and shared with other allocations.
    expect(bytes?.buffer.byteLength).toBe(2)
    expect(bytes?.byteOffset).toBe(0)
  })

  it('round-trips arbitrary binary content', () => {
    const source = new Uint8Array(1024).map((_, i) => (i * 37) % 256)
    const decoded = decodeAudio(Buffer.from(source).toString('base64'))
    expect(decoded).toEqual(source)
  })
})
