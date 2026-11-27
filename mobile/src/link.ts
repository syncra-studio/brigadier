// The stream to the Mac as JS sees it: the shared client (D58) over the native module's decrypted bytes.
import Link from "../modules/link";
import { client, type Frame } from "../vendor/brigadier-shared/client";


const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
function toBase64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

let live = false;
let frames: Frame[] = [];
let waiting: ((f: Frame | null) => void) | null = null;
const closed = new Set<() => void>();

const wire = client(
  (frame) => Link.write(toBase64(frame)),
  (frame) => {
    const w = waiting;
    waiting = null;
    w ? w(frame) : frames.push(frame);
  },
);

function lost() {
  live = false;
  wire.reset();
  for (const reply of wire.drop()) reply({ ok: false, error: "closed" });
  frames = [];
  waiting?.(null);
  waiting = null;
}

Link.addListener("data", ({ b }) => wire.receive(fromBase64(b)));
Link.addListener("closed", () => {
  lost();
  for (const f of closed) f();
});

export async function connect(...args: Parameters<typeof Link.connect>) {
  lost();
  const r = await Link.connect(...args);
  live = !r.error;
  return r;
}

export function close() {
  Link.close();
  lost();
}

/** A frame with no reply id (pairing's `sig`; the Mac ignores the id the client adds). */
export const send = (frame: object) => wire.send(frame);

export const ask = (request: object) => new Promise<Frame>((done) => wire.ask(request, done));

/** The next frame that isn't a reply, or null once the stream is closed. */
export function next(): Promise<Frame | null> {
  if (frames.length) return Promise.resolve(frames.shift()!);
  if (!live) return Promise.resolve(null);
  return new Promise((done) => (waiting = done));
}

/** Called when the open stream ends; returns the unsubscribe. */
export function onClosed(f: () => void) {
  closed.add(f);
  return () => void closed.delete(f);
}
