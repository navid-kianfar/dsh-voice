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
function service(
  engine: { transcribe: (clip: { data: Uint8Array; language?: string }) => Promise<{ text: string }> },
  gate = new TranscriptionGate(),
  config: Record<string, unknown> = settings,
) {
  const fields = {
    ctx: { get: (name: string) => (name === 'transcription' ? engine : undefined) },
    source: () => config,
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

describe('VoiceService.Config', () => {
  const required = { maxClipSeconds: 120, maxClipBytes: 26_214_400, interactionMode: 'toggle', insertMode: 'append' } as const

  it('accepts 0 as the explicit "off" for silence stop and live preview, so a user layer can disable a composed value', () => {
    expect(VoiceService.Config({ ...required, polish: true, silenceStopMs: 0, liveIntervalMs: 0 }))
      .toMatchObject({ silenceStopMs: 0, liveIntervalMs: 0 })
    expect(() => VoiceService.Config({ ...required, polish: true, silenceStopMs: -1 })).toThrow()
  })

  it('still loads a profile written before the fix', () => {
    expect(VoiceService.Config({ ...required, polish: true, silenceStopMs: 2500, liveIntervalMs: 2000 }))
      .toMatchObject({ polish: true, silenceStopMs: 2500, liveIntervalMs: 2000 })
  })

  it('defaults polish to off, because polishing sends the transcript to a model', () => {
    expect(VoiceService.Config({ ...required }).polish).toBe(false)
  })
})

describe('VoiceService.describe', () => {
  const quiet = {
    transcribe: () => Promise.resolve({ text: '' }),
    describe: () => Promise.resolve({ provider: 'fake', ready: true, acceptedMediaTypes: [] }),
  }

  it('reports a 0 ms silence stop and live interval as absent, which the recorder reads as disabled', async () => {
    const voice = service(quiet, undefined, { ...settings, silenceStopMs: 0, liveIntervalMs: 0 })
    const view = await voice.describe()
    expect(view).not.toHaveProperty('silenceStopMs')
    expect(view).not.toHaveProperty('liveIntervalMs')
  })

  it('passes a positive silence stop through', async () => {
    const voice = service(quiet, undefined, { ...settings, silenceStopMs: 2500 })
    await expect(voice.describe()).resolves.toMatchObject({ silenceStopMs: 2500 })
  })

  it('reports a blank language as absent, meaning "detect"', async () => {
    const voice = service(quiet, undefined, { ...settings, language: ' ' })
    await expect(voice.describe()).resolves.not.toHaveProperty('language')
  })
})

describe('VoiceService.transcribe — language', () => {
  it('sends no language hint for a blank language, so the provider auto-detects', async () => {
    const seen: (string | undefined)[] = []
    const engine = { transcribe: (clip: { language?: string }) => { seen.push(clip.language); return Promise.resolve({ text: 'hi' }) } }
    const voice = service(engine, undefined, { ...settings, language: '' })
    await voice.transcribe({ audioBase64: 'aGk=', mimeType: 'audio/wav' }, never)
    expect(seen).toEqual([undefined])
  })
})
