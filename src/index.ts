/**
 * `@achasoft/dsh-voice` root entry — two roles in one module, because the client module system
 * requires them together.
 *
 * **As a plugin**, this is the voice surface's node half. The apply is empty: the browser half ships
 * via `exports["./client"]` and is discovered through the package's `dsh.client` declaration. That
 * discovery resolves `<loader row name>/package.json`, so the row naming this plugin must be the
 * BARE package name — a subpath row (`.../ui`) resolves nothing and the browser half is silently
 * never served.
 *
 * **As a library**, it re-exports the transcription capability's Service Definition, so a
 * third-party provider can implement `ctx.transcription` against this package's types without
 * depending on the Host endpoint or the browser surface.
 * @module @achasoft/dsh-voice
 */

export * from './transcription/index.ts'

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
