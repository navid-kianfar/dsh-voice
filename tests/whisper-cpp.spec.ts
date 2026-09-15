import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WhisperCppTranscription, type Config } from '../src/providers/whisper-cpp.ts'
import { encodeWav } from '../src/client/audio.ts'
import { isTranscriptionError } from '../src/transcription/index.ts'

/** What a fake whisper-cli run prints and how it exits. */
interface FakeRun {
  readonly stdout: string
  readonly stderr?: string
  readonly exitCode?: number
}

/** A real, readable stand-in model file: readiness and transcription both check the path on disk. */
let fixtures: string
let model: string

beforeAll(async () => {
  fixtures = await mkdtemp(join(tmpdir(), 'dsh-voice-spec-'))
  model = join(fixtures, 'ggml-test.bin')
  await writeFile(model, 'not really a model')
})

afterAll(async () => {
  await rm(fixtures, { recursive: true, force: true })
})

/**
 * Build the provider over a fake subprocess seam. The constructor is bypassed because it only binds
 * the Cordis service key; `describe` and `transcribe` read nothing but `ctx.subprocess` and the config.
 */
function provider(run: FakeRun, config: Partial<Config> = {}) {
  const spawned: (readonly string[])[] = []
  const subprocess = {
    resolveExecutable: (command: string) => Promise.resolve(`/opt/homebrew/bin/${command}`),
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
    config: { binaryPath: 'whisper-cli', modelPath: model, timeoutMs: 10_000, maxOutputBytes: 4096, graceMs: 100, ...config },
  }
  const engine = Object.assign(Object.create(WhisperCppTranscription.prototype) as object, fields) as unknown as WhisperCppTranscription
  return { engine, spawned }
}

/**
 * The value following one flag in a spawned argument vector.
 * @param argv - the vector the fake seam recorded.
 * @param flag - the flag to look up.
 * @returns the flag's argument, or undefined when the flag is absent.
 */
function flagValue(argv: readonly string[] | undefined, flag: string): string | undefined {
  const index = argv?.indexOf(flag) ?? -1
  return index < 0 ? undefined : argv?.[index + 1]
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

describe('WhisperCppTranscription.transcribe — language and model', () => {
  it('passes -l auto when no language is set, so a blank language really auto-detects', async () => {
    const { engine, spawned } = provider({ stdout: 'Hallo.' })
    await engine.transcribe(clip(wav(0.3)), signal)
    expect(flagValue(spawned[0], '-l')).toBe('auto')
  })

  it('passes an explicit language through unchanged', async () => {
    const { engine, spawned } = provider({ stdout: 'Hallo.' })
    await engine.transcribe({ ...clip(wav(0.3)), language: 'de' }, signal)
    expect(flagValue(spawned[0], '-l')).toBe('de')
  })

  it('hands the binary the same resolved model path readiness checked', async () => {
    const { engine, spawned } = provider({ stdout: 'Hi.' })
    await engine.transcribe(clip(wav(0.3)), signal)
    expect(flagValue(spawned[0], '-m')).toBe(model)
  })

  it('refuses as not-configured, without spawning, when no model is configured', async () => {
    const { engine, spawned } = provider({ stdout: 'Hi.' }, { modelPath: '' })
    const failure = await engine.transcribe(clip(wav(0.3)), signal).catch((error: unknown) => error)
    expect(isTranscriptionError(failure) && failure.code).toBe('not-configured')
    expect(spawned).toHaveLength(0)
  })
})

describe('WhisperCppTranscription.describe', () => {
  it('is ready when the binary resolves and the model file is readable', async () => {
    const { engine } = provider({ stdout: '' })
    await expect(engine.describe()).resolves.toMatchObject({ ready: true, model: model })
  })

  it('is not ready with "no model configured" for the shipped empty modelPath', async () => {
    const { engine } = provider({ stdout: '' }, { modelPath: '' })
    const info = await engine.describe()
    expect(info.ready).toBe(false)
    expect(info.detail).toMatch(/^no model configured/)
    expect(info.model).toBeUndefined()
  })

  it('is not ready with "model file not found" for a path that does not exist', async () => {
    const missing = join(fixtures, 'absent.bin')
    const { engine } = provider({ stdout: '' }, { modelPath: missing })
    await expect(engine.describe()).resolves.toMatchObject({ ready: false, detail: `model file not found at ${missing}` })
  })

  it('is not ready when the model path names a directory', async () => {
    const { engine } = provider({ stdout: '' }, { modelPath: fixtures })
    await expect(engine.describe()).resolves.toMatchObject({ ready: false, detail: `model path is not a file: ${fixtures}` })
  })

  it.skipIf(process.getuid?.() === 0)('is not ready when the model file cannot be read', async () => {
    const locked = join(fixtures, 'locked.bin')
    await writeFile(locked, 'x')
    await chmod(locked, 0o000)
    const { engine } = provider({ stdout: '' }, { modelPath: locked })
    await expect(engine.describe()).resolves.toMatchObject({ ready: false, detail: `model file not readable at ${locked}` })
  })

  it('is not ready for a relative model path', async () => {
    const { engine } = provider({ stdout: '' }, { modelPath: 'models/base.bin' })
    await expect(engine.describe()).resolves.toMatchObject({ ready: false })
  })

  it('still reports an unrunnable binary', async () => {
    const { engine } = provider({ stdout: '' })
    const failing = Object.assign(engine, {
      ctx: { subprocess: { resolveExecutable: () => Promise.reject(new Error('not on PATH')) } },
    })
    await expect(failing.describe()).resolves.toMatchObject({ ready: false, detail: 'whisper binary not runnable at whisper-cli' })
  })
})
