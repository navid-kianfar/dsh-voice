/** The microphone glyph, owned here because the shared primitives ship no mic icon. */

/** Size in CSS pixels for the square glyph. */
export interface MicIconProps {
  /** Edge length of the square viewport, in CSS pixels. */
  size?: number
}

/**
 * A microphone outline that inherits the button's text colour.
 * @param props - the glyph size.
 * @returns the icon element.
 */
export function MicIcon({ size = 16 }: MicIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
      <rect x="5.75" y="1.75" width="4.5" height="8" rx="2.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M3.25 7.5v.75a4.75 4.75 0 0 0 9.5 0V7.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <path d="M8 13v1.75" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}
