import { describe, expect, it } from 'vitest'
import { buildWhisperArgv, classifyExit, resolveModelPath, wavPeakRms } from '../src/providers/whisper-protocol.ts'
import { encodeWav } from '../src/client/audio.ts'

const base = { binaryPath: '/opt/whisper-cli', modelPath: '/models/base.bin', wavPath: '/tmp/clip.wav' }

describe('buildWhisperArgv', () => {
  it('puts the executable first and always silences timestamps and progress', () => {
    const argv = buildWhisperArgv(base)
    expect(argv[0]).toBe('/opt/whisper-cli')
    // stdout IS the transcript; either of these would land in the returned text.
    expect(argv).toContain('--no-timestamps')
    expect(argv).toContain('--no-prints')
    expect(argv).toEqual(expect.arrayContaining(['-m', '/models/base.bin', '-f', '/tmp/clip.wav']))
  })

  it('omits threads when unset, leaving whisper.cpp its own default', () => {
    const argv = buildWhisperArgv(base)
    expect(argv).not.toContain('-t')
  })

  it('asks for auto-detection when no language is set, because whisper-cli 1.9.4 otherwise assumes English', () => {
    const argv = buildWhisperArgv(base)
    expect(argv.slice(argv.indexOf('-l'), argv.indexOf('-l') + 2)).toEqual(['-l', 'auto'])
  })

  it('treats a blank language as unset rather than passing an empty -l', () => {
    const argv = buildWhisperArgv({ ...base, language: '  ' })
    expect(argv.slice(argv.indexOf('-l'), argv.indexOf('-l') + 2)).toEqual(['-l', 'auto'])
  })

  it('passes threads and language through when configured', () => {
    const argv = buildWhisperArgv({ ...base, threads: 4, language: 'en' })
    expect(argv.slice(argv.indexOf('-t'), argv.indexOf('-t') + 2)).toEqual(['-t', '4'])
    expect(argv.slice(argv.indexOf('-l'), argv.indexOf('-l') + 2)).toEqual(['-l', 'en'])
  })
})

describe('resolveModelPath', () => {
  const home = '/Users/you'

  it('reports an empty path as no model configured', () => {
    expect(resolveModelPath('', home)).toEqual({ kind: 'unusable', detail: expect.stringMatching(/^no model configured/) })
    expect(resolveModelPath('   ', home)).toMatchObject({ kind: 'unusable' })
  })

  it('expands a leading ~ to the Host user\'s home, since the binary is spawned without a shell', () => {
    expect(resolveModelPath('~/.dsh/models/ggml-base.bin', home)).toEqual({ kind: 'resolved', path: '/Users/you/.dsh/models/ggml-base.bin' })
    expect(resolveModelPath('~', home)).toEqual({ kind: 'resolved', path: '/Users/you' })
  })

  it('keeps an absolute path as it is', () => {
    expect(resolveModelPath('/models/base.bin', home)).toEqual({ kind: 'resolved', path: '/models/base.bin' })
  })

  it('refuses a relative path, which the binary would resolve against its scratch directory', () => {
    expect(resolveModelPath('models/base.bin', home)).toEqual({ kind: 'unusable', detail: expect.stringContaining('models/base.bin') })
    expect(resolveModelPath('~other/base.bin', home)).toMatchObject({ kind: 'unusable' })
  })
})

describe('classifyExit', () => {
  it('treats a clean exit as success', () => {
    expect(classifyExit(0, null, 'loading model...')).toBeUndefined()
  })

  it('reports the exit code and the diagnostic', () => {
    const failure = classifyExit(1, null, '  no such model\n')
    expect(failure?.code).toBe('provider-rejected')
    expect(failure?.message).toBe('whisper.cpp exited 1: no such model')
  })

  it('names the signal when the process was killed', () => {
    expect(classifyExit(null, 'SIGKILL', '')?.message).toBe('whisper.cpp exited on SIGKILL')
  })

  it('bounds a runaway diagnostic', () => {
    const failure = classifyExit(2, null, 'x'.repeat(5000))
    expect(failure).toBeDefined()
    expect(failure!.message.length).toBeLessThan(600)
  })

  it('keeps the TAIL of stderr, where whisper-cli puts the real error after its ggml init noise', () => {
    const noise = Array.from({ length: 40 }, (_, i) => `ggml_metal_library_compile_all: compiled 'lib${i}' library in 0.1 sec`).join('\n')
    const failure = classifyExit(3, null, `${noise}\nerror: failed to initialize whisper context\n`)
    expect(failure?.message).toContain('error: failed to initialize whisper context')
    expect(failure?.message).not.toContain("'lib0'")
  })

  it('reports an unreadable clip even though whisper-cli exits 0 for it (reproduced with 1.9.4)', () => {
    const stderr = [
      'load_backend: loaded CPU backend from /opt/homebrew/lib/libggml-cpu.so',
      "read_audio_data: reading audio data from 'clip.wav' ...",
      'read_audio_data: trying to decode with miniaudio',
      'read_audio_data: failed to read audio data',
      "error: failed to read audio file 'clip.wav'",
    ].join('\n')
    const failure = classifyExit(0, null, stderr)
    expect(failure?.code).toBe('provider-rejected')
    expect(failure?.message).toBe("whisper.cpp failed: read_audio_data: failed to read audio data\nerror: failed to read audio file 'clip.wav'")
  })

  it('does not mistake a successful run\'s diagnostics for a failure', () => {
    expect(classifyExit(0, null, "ggml_metal_device_init: GPU name:   MTL0 (Apple M2)\nread_audio_data: reading audio data from 'clip.wav' ...\n")).toBeUndefined()
  })
})

describe('wavPeakRms', () => {
  const tone = (amplitude: number, seconds = 0.5): Float32Array =>
    Float32Array.from({ length: 16_000 * seconds }, (_, i) => amplitude * Math.sin(i / 8))

  it('measures digital silence as zero', () => {
    expect(wavPeakRms(encodeWav(new Float32Array(16_000), 16_000))).toBe(0)
  })

  it('measures the loudest window rather than the average, so one word in a long silence counts', () => {
    const quiet = new Float32Array(16_000 * 3)
    quiet.set(tone(0.5, 0.2), 16_000)
    const peak = wavPeakRms(encodeWav(quiet, 16_000))
    // A sine of amplitude A has RMS A/√2.
    expect(peak).toBeGreaterThan(0.3)
    expect(peak).toBeLessThan(0.4)
  })

  it('walks past extra RIFF chunks to find the data chunk', () => {
    const plain = encodeWav(tone(0.5), 16_000)
    const extra = new Uint8Array(12 + 8 + 4)
    extra.set(plain.subarray(0, 12))
    extra.set([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4], 12)
    const withList = new Uint8Array(extra.length + plain.length - 12)
    withList.set(extra)
    withList.set(plain.subarray(12), extra.length)
    expect(wavPeakRms(withList)).toBeCloseTo(wavPeakRms(plain)!, 6)
  })

  it('answers undefined for anything that is not 16-bit PCM WAV, leaving the decision to the binary', () => {
    expect(wavPeakRms(new TextEncoder().encode('RIFFxxxxWAVEnot really audio at all'))).toBeUndefined()
    expect(wavPeakRms(new Uint8Array(0))).toBeUndefined()
  })
})
