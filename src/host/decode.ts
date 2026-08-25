/**
 * Base64 admission for uploaded audio. Separated from the service so the decision — is this payload
 * canonical, and who owns the bytes afterwards — is testable without a Cordis context.
 * @module @achasoft/dsh-voice/host/decode
 */

import { Buffer } from 'node:buffer'

/** Standard base64, with or without padding. */
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/

/**
 * Decode canonical base64 without letting a malformed payload reach a provider.
 *
 * `Buffer.from` silently drops invalid input rather than failing, so a round trip is what actually
 * proves the payload survived: a lossy decode re-encodes to something else. The result is copied out
 * of Node's Buffer pool, because a pooled Buffer shares its backing store with unrelated
 * allocations and a provider hands these bytes to APIs that take ownership.
 * @param value - the browser-supplied base64 string.
 * @returns the decoded bytes, or undefined when the value is not canonical base64.
 */
export function decodeAudio(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!BASE64_PATTERN.test(value)) return undefined
  const decoded = Buffer.from(value, 'base64')
  const canonical = value.replace(/=+$/, '')
  if (decoded.toString('base64').replace(/=+$/, '') !== canonical) return undefined
  const bytes = new Uint8Array(new ArrayBuffer(decoded.byteLength))
  bytes.set(decoded)
  return bytes
}
