import { describe, expect, it } from 'vitest'
import { WhisperCppTranscription } from '../src/providers/whisper-cpp.ts'
import { encodeWav } from '../src/client/audio.ts'
import { isTranscriptionError } from '../src/transcription/index.ts'

/** What a fake whisper-cli run prints and how it exits. */
interface FakeRun {
  readonly stdout: string
  readonly stderr?: string
  readonly exitCode?: number
}

/**
 * Build the provider over a fake subprocess seam. The constructor is bypassed because it only binds
 * the Cordis service key; `transcribe` reads nothing but `ctx.subprocess` and the config.
 */
function provider(run: FakeRun) {
  const spawned: (readonly string[])[] = []
  const subprocess = {
    spawn: (spec: { argv: readonly string[] }) => {
      spawned.push(spec.argv)
      return {
        done: Promise.resolve({ exitCode: run.exitCode ?? 0, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text: run.stdout, nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: run.stderr ?? '', nextOffset: 0, lossy: false }) },
        },
      }
    },
  }
  const fields = {
    ctx: { subprocess },
    config: { binaryPath: 'whisper-cli', modelPath: '/m.bin', timeoutMs: 10_000, maxOutputBytes: 4096, graceMs: 100 },
  }
  const engine = Object.assign(Object.create(WhisperCppTranscription.prototype) as object, fields) as unknown as WhisperCppTranscription
  return { engine, spawned }
}

const wav = (amplitude: number): Uint8Array<ArrayBuffer> =>
  encodeWav(Float32Array.from({ length: 16_000 }, (_, i) => amplitude * Math.sin(i / 8)), 16_000)
const clip = (data: Uint8Array<ArrayBuffer>) => ({ data, mimeType: 'audio/wav' })
const signal = new AbortController().signal

describe('WhisperCppTranscription.transcribe', () => {
  it('answers a silent clip with empty text without spawning the binary', async () => {
    const { engine, spawned } = provider({ stdout: '\n you' })
    await expect(engine.transcribe(clip(wav(0)), signal)).resolves.toEqual({ text: '' })
    expect(spawned).toHaveLength(0)
  })

  it('drops the stock phrase whisper prints for quiet room tone', async () => {
    // ±0.015 sine: above the no-signal gate, below the level any real speech reaches.
    const { engine, spawned } = provider({ stdout: '\n you' })
    await expect(engine.transcribe(clip(wav(0.015)), signal)).resolves.toEqual({ text: '' })
    expect(spawned).toHaveLength(1)
  })

  it('drops annotation-only output', async () => {
    const { engine } = provider({ stdout: '\n (machine whirring)' })
    await expect(engine.transcribe(clip(wav(0.3)), signal)).resolves.toEqual({ text: '' })
  })

  it('keeps a real one-word dictation on loud audio', async () => {
    const { engine } = provider({ stdout: '\n You.' })
    await expect(engine.transcribe(clip(wav(0.3)), signal)).resolves.toEqual({ text: 'You.' })
  })

  it('classifies an unreadable clip as a failure even though whisper-cli exited 0', async () => {
    const { engine } = provider({
      stdout: '',
      stderr: "load_backend: loaded CPU backend\nread_audio_data: failed to read audio data\nerror: failed to read audio file 'clip.wav'\n",
    })
    const garbage = new TextEncoder().encode('RIFFxxxxWAVEnot really audio at all') as Uint8Array<ArrayBuffer>
    const failure = await engine.transcribe(clip(garbage), signal).catch((error: unknown) => error)
    expect(isTranscriptionError(failure) && failure.code).toBe('provider-rejected')
  })
})
