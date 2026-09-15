/**
 * Transcription provider running a local `whisper.cpp` binary through `ctx.subprocess`. No server,
 * no network, no credential — the deployment supplies a compiled binary and a model file, and the
 * audio never leaves the machine.
 *
 * The binary reads 16 kHz mono WAV and nothing else, so this provider accepts only `audio/wav` and
 * says so through `describe()`. Callers negotiate against that list rather than transcoding, which
 * is what keeps an audio converter out of the harness.
 * @module @deepseek-ai/dsh-transcription-whisper-cpp
 */

import { constants } from 'node:fs'
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-subprocess'
import {
  TranscriptionEngine,
  TranscriptionError,
  type AudioClip,
  type TranscriptResult,
  type TranscriptionProviderInfo,
} from '../transcription/index.ts'
import {
  ACCEPTED_MEDIA_TYPES,
  buildWhisperArgv,
  classifyExit,
  resolveModelPath,
  wavPeakRms,
} from './whisper-protocol.ts'
import { NO_SIGNAL_PEAK_RMS, isNonSpeechTranscript } from '../transcription/non-speech.ts'
import { bareMediaType } from './openai-protocol.ts'

/** Provider identity reported by `describe()`; equal to this package's plugin name. */
const PROVIDER_NAME = 'transcription-whisper-cpp'

/** Deployment configuration for a local whisper.cpp installation. */
export interface Config {
  /** Absolute path to the compiled `whisper-cli` (older builds name it `main`). */
  binaryPath: string
  /**
   * Absolute path to the GGML/GGUF model file the binary should load; a leading `~/` is expanded to
   * the Host user's home. Empty — the shipped default — means no model is configured, and the
   * provider reports itself not ready until one is.
   */
  modelPath: string
  /**
   * Threads the binary may use. Absent leaves the choice to whisper.cpp's own default, which reads
   * the machine's core count — the right answer on a developer workstation and the wrong one on a
   * shared host, which is why it is configurable rather than fixed.
   */
  threads?: number
  /**
   * Deadline for one transcription. Local inference time scales with clip length AND with model
   * size on this specific machine, so no constant could serve every deployment.
   */
  timeoutMs: number
  /**
   * In-memory cap for the binary's stdout. A transcript far past this is a runaway process rather
   * than speech, and the cap keeps one bad clip from growing the host's heap without bound.
   */
  maxOutputBytes: number
  /**
   * Grace period between SIGTERM and SIGKILL when a call is cancelled or times out. The subprocess
   * seam applies no defaults, so the deadline policy for killing a stuck inference is stated here.
   */
  graceMs: number
}

/** The resolved model file, or the operator-facing reason it cannot be loaded. */
type ModelCheck =
  | { readonly usable: true; readonly path: string }
  | { readonly usable: false; readonly path?: string; readonly detail: string }

/**
 * Check that the configured model is a readable file, answering with a reason rather than throwing.
 *
 * Checked here rather than left to the binary: whisper-cli given a missing model prints
 * `failed to initialize whisper context` after its backend noise, which reaches the person as a
 * failed dictation instead of as the configuration problem it is.
 * @param configured - `modelPath` as the deployment wrote it.
 * @returns the path to hand the binary, or why there is none.
 */
async function checkModel(configured: string): Promise<ModelCheck> {
  const home = homedir()
  const resolved = resolveModelPath(configured, home)
  if (resolved.kind === 'unusable') return { usable: false, detail: resolved.detail }
  const path = resolved.path
  try {
    const entry = await stat(path)
    if (!entry.isFile()) return { usable: false, path, detail: `model path is not a file: ${path}` }
    await access(path, constants.R_OK)
  } catch (error) {
    return { usable: false, path, detail: unreadableModelDetail(path, error) }
  }
  return { usable: true, path }
}

/**
 * Describe why a model path could not be opened.
 * @param path - the resolved path.
 * @param error - what `stat` or `access` rejected with.
 * @returns the readiness detail.
 */
function unreadableModelDetail(path: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  switch (code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return `model file not found at ${path}`
    case 'EACCES':
    case 'EPERM':
      return `model file not readable at ${path}`
    default:
      return `model file not accessible at ${path} (${code ?? String(error)})`
  }
}

/**
 * Remove one scratch directory, reporting nothing when it is already gone.
 * @param dir - the directory created for this call.
 */
async function discardScratch(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    // Cleanup of a temp directory cannot fail the transcription the caller already has; the only
    // reachable causes are a concurrent removal or a permission change under the process's own
    // temp root, and both leave at most one empty directory behind.
  }
}

/** Transcription by local whisper.cpp invocation. */
export class WhisperCppTranscription extends TranscriptionEngine {
  static inject = ['subprocess']

  /** Loader validation for the binary, model, and per-call resource policy. */
  static Config: z<Config> = z.object({
    binaryPath: z.string().required(),
    modelPath: z.string().required(),
    threads: z.number().step(1).min(1),
    timeoutMs: z.number().step(1).min(1).required(),
    maxOutputBytes: z.number().step(1).min(1).required(),
    graceMs: z.number().step(1).min(1).required(),
  })

  private readonly config: Config

  /**
   * @param ctx - registrant context carrying the subprocess seam.
   * @param config - the validated binary, model, and resource policy.
   */
  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.config = config
  }

  /**
   * Report identity and whether a transcription attempted now could run: the binary resolves AND
   * the model file is there to load. Ready on the binary alone used to promise a dictation whose
   * first attempt then failed on the shipped empty `modelPath`.
   * @returns the provider's identity, resolved model path, accepted media type, and readiness.
   */
  async describe(): Promise<TranscriptionProviderInfo> {
    const model = await checkModel(this.config.modelPath)
    const base = {
      provider: PROVIDER_NAME,
      ...model.path === undefined ? {} : { model: model.path },
      acceptedMediaTypes: ACCEPTED_MEDIA_TYPES,
    }
    try {
      await this.ctx.subprocess.resolveExecutable(this.config.binaryPath)
    } catch {
      // Lookup rejects for every not-runnable case (absent, not executable, unresolvable relative
      // path). Readiness is the only fact this method reports, and each of those is the same "not
      // ready" answer; the operator sees the exact cause from `transcribe()`, which does not swallow it.
      return { ...base, ready: false, detail: `whisper binary not runnable at ${this.config.binaryPath}` }
    }
    if (!model.usable) return { ...base, ready: false, detail: model.detail }
    return { ...base, ready: true }
  }

  /**
   * Write the clip to a scratch WAV, run the binary over it, and return its stdout.
   * @param clip - the complete recording; must be `audio/wav`.
   * @param signal - caller-owned cancellation, forwarded to the process tree.
   * @returns the recognized text.
   */
  async transcribe(clip: AudioClip, signal: AbortSignal): Promise<TranscriptResult> {
    if (clip.data.byteLength === 0) throw new TranscriptionError('empty-audio', 'clip carries no audio')
    const media = bareMediaType(clip.mimeType)
    if (media !== 'audio/wav') {
      throw new TranscriptionError('unsupported-media-type', `whisper.cpp reads 16 kHz mono WAV, not ${media || clip.mimeType}`)
    }

    // The same check readiness makes, so a call that races a settings change or skips `describe()`
    // fails as the configuration problem it is rather than as a rejected clip.
    const model = await checkModel(this.config.modelPath)
    if (!model.usable) throw new TranscriptionError('not-configured', model.detail)

    // Silence is answered without spawning. whisper.cpp does not return empty text for a silent clip —
    // 1.9.4 with ggml-base.en prints "you" — and the inference costs every core it is given to learn
    // nothing. A WAV this function cannot parse is measured as undefined and goes to the binary.
    const peakRms = wavPeakRms(clip.data)
    if (peakRms !== undefined && peakRms < NO_SIGNAL_PEAK_RMS) return { text: '' }

    const scratch = await mkdtemp(join(tmpdir(), 'dsh-voice-'))
    try {
      const wav = join(scratch, 'clip.wav')
      await writeFile(wav, clip.data)

      const timeout = AbortSignal.timeout(this.config.timeoutMs)
      const handle = this.ctx.subprocess.spawn({
        argv: [...buildWhisperArgv({
          binaryPath: this.config.binaryPath,
          modelPath: model.path,
          wavPath: wav,
          ...this.config.threads === undefined ? {} : { threads: this.config.threads },
          ...clip.language === undefined ? {} : { language: clip.language },
        })],
        cwd: scratch,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: this.config.maxOutputBytes },
          stderr: { maxBytes: this.config.maxOutputBytes },
        },
        graceMs: this.config.graceMs,
        signal: AbortSignal.any([signal, timeout]),
      })

      const outcome = await handle.done
      if (signal.aborted) throw signal.reason
      if (timeout.aborted) {
        throw new TranscriptionError('provider-timeout', 'whisper.cpp did not finish in time')
      }
      const failure = classifyExit(
        outcome.exitCode,
        outcome.signal,
        handle.collected.stderr?.readFrom(0).text ?? '',
      )
      if (failure !== undefined) throw failure
      const text = (handle.collected.stdout?.readFrom(0).text ?? '').trim()
      // The contract says silence is empty text; whisper's non-speech annotations and its stock
      // phrases on quiet audio are silence spelled differently.
      return { text: isNonSpeechTranscript(text, peakRms) ? '' : text }
    } finally {
      await discardScratch(scratch)
    }
  }
}

export default WhisperCppTranscription
