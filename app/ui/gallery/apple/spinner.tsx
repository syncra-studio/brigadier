import type { ComponentProps } from "react";

const SPOKES = [0, 1, 2, 3, 4, 5, 6, 7];

/** macOS's spinning activity indicator, drawn by us: eight spokes fading behind the brightest. */
export function Spinner(props: ComponentProps<"svg">) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" aria-hidden {...props}>
      {SPOKES.map((spoke) => (
        <line key={spoke} x1="12" y1="2.75" x2="12" y2="7.25" opacity={(spoke + 1) / SPOKES.length} transform={`rotate(${spoke * 45} 12 12)`} />
      ))}
    </svg>
  );
}

/** It steps round, the way the system's does. */
export const spin = "animate-apple-spin motion-reduce:animate-none";
