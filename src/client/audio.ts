/**
 * Pure audio helpers: format negotiation, PCM-to-WAV encoding, and base64. Kept free of browser
 * globals — `chooseDirectContainer` takes a support predicate rather than calling `MediaRecorder`
 * itself — so every branch is testable outside a browser.
 * @module @achasoft/dsh-voice/client/audio
 */

/**
 * Container formats worth recording in, best first. Opus in WebM is the smallest useful upload;
 * MP4/AAC is the Safari equivalent. WAV is absent deliberately — no browser records it natively, so
 * it is only ever reached by re-encoding.
 */
export const PREFERRED_CONTAINERS: readonly string[] = Object.freeze([
  'audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus',
])

/** The sample rate whisper.cpp and every hosted Whisper deployment expect. */
export const WAV_SAMPLE_RATE = 16_000

/**
 * Drop the codec parameter from a media type.
 * @param mimeType - a media type, possibly parameterized.
 * @returns the lowercased type without parameters.
 */
export function bareMediaType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? '').trim().toLowerCase()
}

/**
 * Choose a container the browser can record AND the provider accepts.
 * @param accepted - the provider's accepted media types; empty accepts anything.
 * @param isSupported - whether this browser can record one container.
 * @returns the chosen recorder mime type, or undefined when re-encoding is required.
 */
export function chooseDirectContainer(
  accepted: readonly string[],
  isSupported: (type: string) => boolean,
): string | undefined {
  const allows = (type: string): boolean => accepted.length === 0 || accepted.includes(bareMediaType(type))
  return PREFERRED_CONTAINERS.find(type => isSupported(type) && allows(type))
}

/**
 * Base64-encode bytes in chunks, because spreading a long byte array into `String.fromCharCode`
 * overflows the argument limit on clips of any real length.
 * @param bytes - the encoded audio.
 * @returns standard base64.
 */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/**
 * Encode mono float samples as 16-bit PCM WAV.
 * @param samples - mono samples in [-1, 1]; values outside are clamped.
 * @param sampleRate - the rate the samples were resampled to.
 * @returns the complete WAV file bytes, header included.
 */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
  }
  return new Uint8Array(buffer)
}
