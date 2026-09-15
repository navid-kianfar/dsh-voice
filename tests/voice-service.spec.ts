import { describe, expect, it } from 'vitest'
import { VoiceService } from '../src/host/index.ts'
import { TranscriptionGate } from '../src/host/transcription-gate.ts'

const settings = {
  maxClipSeconds: 120, maxClipBytes: 16, interactionMode: 'toggle', insertMode: 'append', polish: false,
} as const
const never = new AbortController().signal

/**
 * The service over a fake transcription engine. The constructor is bypassed because it attaches the
 * settings section; `transcribe` reads only `ctx.get`, the settings source, and the gate.
 */
function service(engine: { transcribe: (clip: { data: Uint8Array }) => Promise<{ text: string }> }, gate = new TranscriptionGate()) {
  const fields = {
    ctx: { get: (name: string) => (name === 'transcription' ? engine : undefined) },
    source: () => settings,
    gate,
  }
  return Object.assign(Object.create(VoiceService.prototype) as object, fields) as unknown as VoiceService
}

describe('VoiceService.transcribe', () => {
  it('refuses an oversized clip from its encoded length, before the payload is decoded', async () => {
    let called = false
    const voice = service({ transcribe: () => { called = true; return Promise.resolve({ text: '' }) } })
    // 24 base64 characters decode to 18 bytes, over the 16-byte cap. The trailing "!" makes the payload
    // undecodable, so a size answer proves the size check ran first.
    const result = await voice.transcribe({ audioBase64: `${'A'.repeat(24)}!`, mimeType: 'audio/wav' }, never)
    expect(result).toMatchObject({ ok: false, code: 'clip-too-large' })
    expect(called).toBe(false)
  })

  it('answers "busy" when this Host already has its fill of transcriptions queued', async () => {
    let release!: () => void
    const blocked = new Promise<{ text: string }>((resolve) => { release = () => resolve({ text: 'hi' }) })
    const voice = service({ transcribe: () => blocked }, new TranscriptionGate(1, 0))
    const first = voice.transcribe({ audioBase64: 'aGk=', mimeType: 'audio/wav' }, never)
    const second = await voice.transcribe({ audioBase64: 'aGk=', mimeType: 'audio/wav' }, never)
    expect(second).toMatchObject({ ok: false, code: 'provider-unavailable' })
    release()
    await expect(first).resolves.toEqual({ ok: true, text: 'hi' })
  })
})
