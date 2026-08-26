# @achasoft/dsh-voice

Voice input for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web Client. A microphone button in the composer records what you say, transcribes it, and drops the text into the draft — where you read and edit it before sending.

Transcription is a swappable capability. Ship it against a hosted Whisper API, a Whisper server on your own machine, or a local `whisper.cpp` binary with no network at all.

**What makes a dictation usable, not just possible:** the transcript is cleaned up by the model you already configured — fillers gone, punctuation restored, spoken enumerations turned into lists. Recording stops when you stop talking. A live level meter shows it is hearing you, and an optional provisional transcript appears while you speak. Text you type mid-dictation is never overwritten.

## Requirements

- A dsh installation with the Web Client (`@deepseek-ai/dsh-web-app`).
- **A secure context.** Browsers only expose the microphone over HTTPS or on `localhost`; on any other plain-HTTP origin the button will not appear.
- One transcription provider, configured below. Without one, the composer seat renders nothing and the settings card explains why — an unconfigured install shows no dead control.

## Install

`dsh plugin` forwards to pnpm, so any pnpm source works:

```bash
dsh plugin --profile default add @achasoft/dsh-voice
```

<details>
<summary>Other install sources</summary>

```bash
dsh plugin --profile default add ./achasoft-dsh-voice-0.1.0.tgz   # from `pnpm pack`
dsh plugin --profile default add ./dsh-voice                       # a local checkout
dsh plugin --profile default add github:achasoft/dsh-voice#<sha>   # from git
```

A git install fetches sources, not build output. This package ships a `prepare` script that builds them, but pnpm ≥10 will not run it until you allow it — add the key pnpm names to your profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  '@achasoft/dsh-voice': true
```

That is permission to execute this package's code at install time. Prefer the npm or tarball forms, which need no such allowance.
</details>

The bundle appends itself to your profile automatically. Verify with `dsh --profile default --dump-config`, which should show a `# == @achasoft/dsh-voice` layer.

## Pick a provider

Both providers claim `ctx.transcription`. **Enable exactly one** — a composition that mounts both fails loudly at load rather than silently preferring one.

Enable your choice from your profile's own `cordis.patch.yml` (`$DSH_HOME/profiles/<name>/cordis.patch.yml`). A patch replaces a row's entire `config`, so restate every key.

### Hosted or self-hosted HTTP — `openai-compatible`

Speaks OpenAI's `/v1/audio/transcriptions`. One request shape reaches the hosted API, Groq, `faster-whisper-server`, `whisper.cpp`'s own server, and LM Studio.

```yaml
- id: voice-openai-compatible
  disabled: false
  config:
    baseUrl: https://api.openai.com/v1
    model: whisper-1
    apiKeyEnv: OPENAI_API_KEY
    timeoutMs: 120000
```

| Field | Meaning |
|---|---|
| `baseUrl` | Endpoint prefix without `/audio/transcriptions`. A local server might be `http://127.0.0.1:8000/v1`. |
| `model` | Transcription model, e.g. `whisper-1` or `Systran/faster-whisper-small`. |
| `apiKeyEnv` | **Name of an environment variable**, never the key. Omit entirely for a local server needing no authorization. |
| `timeoutMs` | Deadline for one request. |

**The key is addressed, never stored.** `apiKeyEnv` is a credential *reference*: the value is resolved from the harness credential seam at the start of every call and never cached, so rotating it reaches the next request with no restart. Your settings document stays safe to sync and to render in a UI.

### Fully local, no network — `whisper-cpp`

Runs a [whisper.cpp](https://github.com/ggerganov/whisper.cpp) binary through the harness subprocess seam. No server, no credential; the audio never leaves the machine.

```yaml
- id: voice-whisper-cpp
  disabled: false
  config:
    binaryPath: /opt/whisper.cpp/build/bin/whisper-cli
    modelPath: /opt/whisper.cpp/models/ggml-base.en.bin
    timeoutMs: 300000
    maxOutputBytes: 262144
    graceMs: 5000
    # threads: 4
```

The binary reads **16 kHz mono WAV and nothing else**, so this provider advertises only `audio/wav`. The browser re-encodes to that format using its own audio pipeline — no transcoder is installed anywhere.

## Settings

The **Voice input** card on the plugin settings tab edits these live; the values below are the composition defaults.

| Field | Default | Meaning |
|---|---|---|
| `interactionMode` | `toggle` | `toggle` = click to start, click to stop. `hold` = hold the button to talk. |
| `insertMode` | `append` | Whether a transcript appends to the draft or replaces it. |
| `maxClipSeconds` | `120` | Longest recording the browser will make. |
| `maxClipBytes` | `26214400` | Largest clip the Host accepts (25 MiB, the hosted API's ceiling). |
| `language` | *(unset)* | BCP-47 hint. Blank asks the provider to detect the language. |
| `polish` | `true` | Clean the transcript with the session's own model — no second credential. |
| `polishPrompt` | *(unset)* | Custom cleanup instruction. Blank uses the built-in one, which is deliberately conservative: it rewrites nothing it was not asked to. |
| `silenceStopMs` | `2500` | End the recording after this much continuous silence. Blank disables it. |
| `liveIntervalMs` | *(unset)* | Show a provisional transcript this often while recording. **Each pass re-transcribes from the beginning** — cheap against a local binary, billed per pass against a hosted endpoint, which is why it is opt-in. |

The **microphone** is chosen in the card too, but stored in the browser rather than the settings document: which input device to use is a fact about the machine, not the account.

### Polish uses your model, not another key

Cleanup runs through `ctx.llm` with the model your deployment already selected, so it needs no extra provider and no extra credential. A failed cleanup is never a failed dictation — the raw transcript is always what lands if the model request fails.

`maxClipSeconds` is the browser's gate and `maxClipBytes` is the Host's — the Host cannot measure a duration without decoding the audio, so the two limits exist for different reasons.

## How it works

```
composer mic seat ─ getUserMedia → MediaRecorder → (re-encode to WAV if needed)
        │                                            └─ negotiated against the provider
        ▼  base64 over one unary RPC
Host  VoiceService.transcribe() ─ byte cap ─→ ctx.transcription ─┬─ openai-compatible
        │                                                        └─ whisper-cpp
        ▼  { text } | { code, message }
composer draft ← inputActions.setDraft()
```

Three decisions worth knowing:

- **Nothing is persisted and nothing is model-facing.** The transcript reaches the model only if you send it, as ordinary user-message text. The plugin registers no prompt, no tool, and no session event; the audio is decoded, transcribed, and discarded inside one call.
- **Failures cross the wire as values, not exceptions.** The RPC gateway erases a thrown error's classification, and the composer's next move depends on which class it was — "configure a provider" is not "try again".
- **The recorder negotiates format.** `describe()` reports what the mounted provider accepts, so a WAV-only local binary and a container-flexible hosted API are the same code path.

## Writing another provider

Import the package root for the Service Definition and register your own implementation as `ctx.transcription`:

```ts
import { TranscriptionEngine, TranscriptionError } from '@achasoft/dsh-voice'

export default class MyTranscription extends TranscriptionEngine {
  async transcribe(clip, signal) { /* … */ }
  async describe() { /* … */ }
}
```

`transcribe` rejects only with `TranscriptionError`; its `code` is the closed union callers switch on (`not-configured` is the one a UI must treat differently). Silence returns empty `text` rather than failing — "nothing was said" is a successful outcome.

## Development

Development links against a **sibling deepseek-harness checkout**, because npm's published dsh
packages lag the versions this plugin is built against. Clone both side by side:

```
your-workspace/
├── deepseek-harness/
└── dsh-voice/          ← this repo
```

```bash
pnpm install
pnpm run build       # tsc emit → tsdown bundle (~1s)
pnpm test            # Typert drift check + unit tests
pnpm run typecheck
```

`generated/` holds the Typert RPC contract. It is a build output of the harness's generator, which only runs inside a deepseek-harness checkout, so it is committed here — and `pnpm test` fails if the Host surface changed without it:

```bash
pnpm run regen:typert /path/to/deepseek-harness
```

That script stages the Host sources in the harness, builds, copies the artifacts back, and restores the checkout. It refuses to run against a dirty working tree.

On a fresh clone pnpm may refuse esbuild's postinstall (`ERR_PNPM_IGNORED_BUILDS`), which then blocks every `pnpm run`. Run `pnpm approve-builds` once and pick esbuild. It is a dev-only transitive of vitest; consumers of the published package never install it.

## Known limitations

- **No streaming or partial transcripts.** The RPC gateway dispatches unary methods only, so a clip is transcribed after you stop recording. Live partials need a different transport.
- **Provisional transcripts re-transcribe from the start.** A compressed stream's later chunks are not independently decodable, so each live pass covers the whole clip. That is why `liveIntervalMs` is opt-in rather than a default.
- **Web Client only.** The terminal CLI has no capture path; adding one means a host-side recorder and an external binary.
- **One provider at a time.** No runtime selection among several, and no fallback from a remote provider to a local one.
- **`describe()` checks the whisper.cpp binary, not the model.** A missing or corrupt `modelPath` surfaces on the first real call, because verifying it means loading it.

## License

MIT

---

<details>
<summary>Note on the publint CJS warning</summary>

`publint` flags `exports["./client"]` as CJS inside a `"type": "module"` package. That is the required shape, not a defect: the Web Client fetches the browser half over HTTP and evaluates it as an opaque `window.__ModuleLoader__.load({ id, factory })` closure, so Node's ESM resolver never sees it. The harness's own UI plugin packages are built exactly the same way.
</details>
