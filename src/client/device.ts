/**
 * Which microphone to record from. Browser-local by design: the input device is a fact about this
 * machine, not about the account, so it never reaches the synced settings document.
 * @module @achasoft/dsh-voice/client/device
 */

/** Storage key; namespaced so it cannot collide with another plugin's preference. */
const KEY = 'achasoft.dsh-voice.deviceId'

/**
 * Read the chosen input device.
 * @returns the stored device id, or undefined for the system default.
 */
export function readDevice(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined
  } catch {
    // Storage can be unavailable outright (private mode, blocked third-party storage). Falling back
    // to the system default is the correct behaviour, not an error worth surfacing.
    return undefined
  }
}

/**
 * Store the chosen input device, or clear it back to the system default.
 * @param deviceId - the device to use, or undefined for the system default.
 */
export function writeDevice(deviceId: string | undefined): void {
  try {
    if (deviceId === undefined) localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, deviceId)
  } catch {
    // Same as above: a preference that cannot be persisted still applies for this page's lifetime,
    // because the caller keeps its own state.
  }
}
