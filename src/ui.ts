/**
 * Voice input surface, node half. Pure UI plugin: the empty apply exists so the plugin appears in
 * the Loader entry list, which is how the client module system discovers this package's
 * `dsh.client` declaration and serves its built `./client` export to the browser.
 * @module @achasoft/dsh-voice/ui
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
