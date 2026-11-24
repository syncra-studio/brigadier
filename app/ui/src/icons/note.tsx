// Icons copied from @openai/apps-sdk-ui 0.2.2 (MIT, see THIRD_PARTY_NOTICES.md), and the old app's page glyphs. Add only what the app draws.
import type { ReactNode } from "react";

import type { IconProps } from "./index";

export function SimpleSmile(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 4C7.58172 4 4 7.58172 4 12C4 16.4183 7.58172 20 12 20C16.4183 20 20 16.4183 20 12C20 7.58172 16.4183 4 12 4ZM2 12C2 6.47715 6.47715 2 12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12ZM7.39933 14.201C7.84087 13.8693 8.46775 13.9583 8.79949 14.3998C10.3701 16.4903 13.6299 16.4903 15.2005 14.3998C15.5323 13.9583 16.1591 13.8693 16.6007 14.201C17.0422 14.5327 17.1312 15.1596 16.7995 15.6012C14.4288 18.7565 9.57119 18.7565 7.20051 15.6012C6.86876 15.1596 6.95778 14.5327 7.39933 14.201Z" />
    </svg>
  );
}

export function SquarePlus(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path fillRule="evenodd" clipRule="evenodd" d="M6.911 18.962C7.361 19 7.943 19 8.8 19H10a1 1 0 1 1 0 2H8.759c-.805 0-1.47 0-2.01-.044-.563-.046-1.08-.145-1.565-.392a4 4 0 0 1-1.748-1.748c-.247-.485-.346-1.002-.392-1.564C3 16.71 3 16.046 3 15.242V8.758c0-.805 0-1.47.044-2.01.046-.563.145-1.08.392-1.565a4 4 0 0 1 1.748-1.748c.485-.247 1.002-.346 1.564-.392C7.29 3 7.954 3 8.758 3h6.483c.805 0 1.47 0 2.01.044.563.046 1.08.145 1.565.392a4 4 0 0 1 1.748 1.748c.247.485.346 1.002.392 1.564C21 7.29 21 7.954 21 8.758V10a1 1 0 1 1-2 0V8.8c0-.857 0-1.439-.038-1.889-.035-.438-.1-.663-.18-.819a2 2 0 0 0-.874-.874c-.156-.08-.38-.145-.819-.18C16.639 5 16.057 5 15.2 5H8.8c-.857 0-1.439 0-1.889.038-.438.035-.663.1-.819.18a2 2 0 0 0-.874.874c-.08.156-.145.38-.18.819C5 7.361 5 7.943 5 8.8v6.4c0 .857 0 1.439.038 1.889.035.438.1.663.18.819a2 2 0 0 0 .874.874c.156.08.38.145.819.18Z" />
      <path d="M19 15a1 1 0 1 0-2 0v2h-2a1 1 0 1 0 0 2h2v2a1 1 0 1 0 2 0v-2h2a1 1 0 1 0 0-2h-2v-2Z" />
    </svg>
  );
}

export function History(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path fillRule="evenodd" clipRule="evenodd" d="M2.954 7.807A1 1 0 0 0 3.968 9c.064.002.13-.003.196-.014l3-.5a1 1 0 0 0-.328-1.972l-.778.13a8 8 0 1 1-2.009 6.247 1 1 0 0 0-1.988.219C2.614 18.11 6.852 22 12 22c5.523 0 10-4.477 10-10S17.523 2 12 2a9.975 9.975 0 0 0-7.434 3.312l-.08-.476a1 1 0 0 0-1.972.328l.44 2.643ZM12 7a1 1 0 0 1 1 1v3.586l2.207 2.207a1 1 0 0 1-1.414 1.414l-2.5-2.5A1 1 0 0 1 11 12V8a1 1 0 0 1 1-1Z" />
    </svg>
  );
}

export function MinimizeRight(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M19 19a1 1 0 1 0 2 0V5a1 1 0 1 0-2 0v14Zm-8.707-2.707a1 1 0 1 0 1.414 1.414l5-5a1 1 0 0 0 0-1.414l-5-5a1 1 0 1 0-1.414 1.414L13.586 11H4a1 1 0 1 0 0 2h9.586l-3.293 3.293Z" />
    </svg>
  );
}

/** A page block's drag handle: two columns of three dots (10 × 16), the old app's. */
export function DragDots(props: IconProps) {
  return (
    <svg viewBox="0 0 10 16" fill="currentColor" aria-hidden {...props}>
      {[3, 8, 13].flatMap((y) => [2.5, 7.5].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.25" />))}
    </svg>
  );
}

const svg = (children: ReactNode) => (
  <svg aria-hidden viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" className="note-block-icon size-icon-sm shrink-0">
    {children}
  </svg>
);
const letters = (text: string) =>
  svg(
    <text x="8" y="11.5" textAnchor="middle" fill="currentColor" stroke="none" fontSize="8.5" fontWeight="600">
      {text}
    </text>,
  );

/** Each note block kind's icon, the old app's page block icons: 16-unit stroked line icons. */
export const BLOCK_ICONS = {
  paragraph: letters("Aa"),
  h1: letters("H1"),
  h2: letters("H2"),
  h3: letters("H3"),
  bullet: svg(<><circle cx="3" cy="4.5" r=".9" fill="currentColor" /><circle cx="3" cy="11.5" r=".9" fill="currentColor" /><path d="M6.5 4.5h7M6.5 11.5h7" /></>),
  number: svg(<><path d="M2.5 3.2l1-.7v4M2.3 13.5h2.2l-2.2-2.4c.6-1 2.2-.8 2.2.3" /><path d="M7 4.5h6.5M7 11.5h6.5" /></>),
  check: svg(<><path d="M4.5 2.5h6A2.5 2.5 0 0 1 13 5v6a2.5 2.5 0 0 1-2.5 2.5h-6A2.5 2.5 0 0 1 2 11V5a2.5 2.5 0 0 1 2.5-2.5z" /><path d="M5 8l2 2 3.5-4" /></>),
  quote: svg(<><path d="M3 3.5v9" /><path d="M6.5 5h7M6.5 8h7M6.5 11h4.5" /></>),
  code: svg(<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5" />),
  table: svg(<><path d="M4 2.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" /><path d="M2 6.5h12M6.5 6.5v7" /></>),
  image: svg(<><path d="M4 2.5h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" /><circle cx="5.5" cy="6" r="1.2" /><path d="M2.5 12l3.5-3 2.5 2 2.5-2.5 3 3" /></>),
  divider: svg(<path d="M2 8h12" />),
} as const;
