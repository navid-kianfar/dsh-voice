/**
 * `dsh-voice` root entry: the transcription capability's Service Definition.
 *
 * Importing this package by name gives `ctx.transcription`, the clip/transcript vocabulary, and the
 * classified failure union — everything a third-party provider needs to implement the capability
 * without depending on this plugin's Host endpoint or its browser surface.
 * @module @achasoft/dsh-voice
 */

export * from './transcription/index.ts'
