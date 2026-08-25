import { describe, expect, it } from 'vitest'
import { buildWhisperArgv, classifyExit } from '../src/providers/whisper-protocol.ts'

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

  it('omits the optional flags entirely when unset, leaving whisper.cpp its own defaults', () => {
    const argv = buildWhisperArgv(base)
    expect(argv).not.toContain('-t')
    expect(argv).not.toContain('-l')
  })

  it('passes threads and language through when configured', () => {
    const argv = buildWhisperArgv({ ...base, threads: 4, language: 'en' })
    expect(argv.slice(argv.indexOf('-t'), argv.indexOf('-t') + 2)).toEqual(['-t', '4'])
    expect(argv.slice(argv.indexOf('-l'), argv.indexOf('-l') + 2)).toEqual(['-l', 'en'])
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
})
