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
// The open stream's number; the native module's events for any other are stale.
let stream = -1;
// Moves on at each connect and close, so an older connect's late result changes nothing.
let attempt = 0;
// How many times `close` was called: a flow that saw it change was cancelled.
let closes = 0;
export const closeCount = () => closes;
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
  stream = -1;
  wire.reset();
  for (const reply of wire.drop()) reply({ ok: false, error: "closed" });
  frames = [];
  waiting?.(null);
  waiting = null;
}

Link.addListener("data", ({ b, n }) => n === stream && wire.receive(fromBase64(b)));
Link.addListener("closed", ({ n }) => {
  if (n !== stream) return;
  lost();
  for (const f of closed) f();
});

export async function connect(...args: Parameters<typeof Link.connect>) {
  const mine = ++attempt;
  lost();
  const r = await Link.connect(...args);
  if (mine !== attempt) return { error: "closed" as const };
  live = r.stream !== undefined;
  stream = r.stream ?? -1;
  return r;
}

export function close() {
  attempt++;
  closes++;
  Link.close();
  lost();
}

/** A frame with no reply id (pairing's `sig`; the Mac ignores the id the client adds). */
export const send = (frame: object) => wire.send(frame);

/** A request and its reply; `{ok: false, error: "closed"}` if the stream ends first or no reply comes in 30 s. */
export function ask(request: object): Promise<Frame> {
  return new Promise((done) => {
    const timer = setTimeout(close, 30_000);
    try {
      wire.ask(request, (reply) => {
        clearTimeout(timer);
        done(reply);
      });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
  });
}

/** The next frame that isn't a reply, or null once the stream is closed; after `ms` the stream is closed. */
export function next(ms = 30_000): Promise<Frame | null> {
  if (frames.length) return Promise.resolve(frames.shift()!);
  if (!live) return Promise.resolve(null);
  return new Promise((done) => {
    const timer = setTimeout(close, ms);
    waiting = (f) => {
      clearTimeout(timer);
      done(f);
    };
  });
}

/** Called when the open stream ends; returns the unsubscribe. */
export function onClosed(f: () => void) {
  closed.add(f);
  return () => void closed.delete(f);
}
