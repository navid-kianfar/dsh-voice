import { describe, expect, it } from 'vitest'
import { millisecondsInvalid, plannedWrite, secondsInvalid } from '../src/client/settings-fields.ts'

describe('plannedWrite', () => {
  it('stores 0 for silence stop, the explicit "off" that overrides a composed 2500 ms', () => {
    expect(plannedWrite('silenceStopMs', '0')).toEqual({ kind: 'set', value: 0 })
  })

  it('clears a blank silence stop back to the deployment default rather than storing it', () => {
    expect(plannedWrite('silenceStopMs', '')).toEqual({ kind: 'unset' })
  })

  it('stores a positive live interval as a number', () => {
    expect(plannedWrite('liveIntervalMs', '2000')).toEqual({ kind: 'set', value: 2000 })
  })

  it('maps the remaining fields as before', () => {
    expect(plannedWrite('maxClipSeconds', '60')).toEqual({ kind: 'set', value: 60 })
    expect(plannedWrite('polish', 'false')).toEqual({ kind: 'set', value: false })
    expect(plannedWrite('language', '')).toEqual({ kind: 'unset' })
    expect(plannedWrite('polishPrompt', '')).toEqual({ kind: 'unset' })
    expect(plannedWrite('language', 'de')).toEqual({ kind: 'set', value: 'de' })
    expect(plannedWrite('insertMode', 'replace')).toEqual({ kind: 'set', value: 'replace' })
  })
})

describe('field validation', () => {
  it('accepts 0 and blank for an optional milliseconds field and rejects what the Host schema would', () => {
    expect(millisecondsInvalid('0')).toBe(false)
    expect(millisecondsInvalid('')).toBe(false)
    expect(millisecondsInvalid('2500')).toBe(false)
    expect(millisecondsInvalid('-1')).toBe(true)
    expect(millisecondsInvalid('1.5')).toBe(true)
  })

  it('still requires a positive whole number of seconds', () => {
    expect(secondsInvalid('0')).toBe(true)
    expect(secondsInvalid('')).toBe(true)
    expect(secondsInvalid('30')).toBe(false)
  })
})
