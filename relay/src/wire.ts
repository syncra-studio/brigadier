import type { Budget } from "./budget";
import type { Lookup } from "./lookup";
import type { Quota } from "./quota";
import type { Room } from "./room";

export interface Env {
  ROOM: DurableObjectNamespace<Room>;
  LOOKUP: DurableObjectNamespace<Lookup>;
  QUOTA: DurableObjectNamespace<Quota>;
  BUDGET: DurableObjectNamespace<Budget>;
  OPENS: RateLimit;
  LOOKUPS: RateLimit;
  HOSTED?: string;
  ROOMS?: string;
  // Hosted only. Bytes a free room may carry a month (none when unset); the relay's monthly budget in dollars (none
  // when unset); "0" stops all free traffic at once.
  CEILING?: string;
  BUDGET_USD?: string;
  FREE_OPEN?: string;
  PRICE_REQUESTS?: string;
  PRICE_GB_S?: string;
  // Push (rev 4): the owner's .p8 key, its key id and team id as secrets, hosted only; APNS_URL points elsewhere
  // only on the local emulator.
  APNS_KEY?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  APNS_URL?: string;
}

export const MALFORMED = 4400;
export const REFUSED = 4401;
export const PAUSED = 4402;
export const NOT_ADMITTED = 4403;
export const OFFLINE = 4404;
export const REPLACED = 4409;
export const LIMITED = 4429;

// Frame kinds on the computer's socket.
export const DATA = 0;
export const OPEN = 1;
export const CLOSE = 2;

export const now = () => Math.floor(Date.now() / 1000);

export const isHash = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);

export const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));

export const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

export const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const unb64url = (s: string) =>
  unb64(s.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (s.length % 4)) % 4));

export const utf8 = (s: string) => new TextEncoder().encode(s);

export const sha256 = async (b: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", b));

export async function signed(key: Uint8Array, sig: Uint8Array, data: Uint8Array) {
  try {
    const k = await crypto.subtle.importKey("raw", key, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, sig, data);
  } catch {
    return false;
  }
}

export const OPEN_PROOF = "brigadier/relay/open/v1";
export const PASS = "brigadier/relay/pass/v1";
export const PUSH = "brigadier/relay/push/v1";
const KEY = /^[A-Za-z0-9_-]{87}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;

// The room a front-door signature (open proof, pass, or push with its text's hash as `extra`) is good for, or null.
// Lengths are checked before decoding.
export async function doorRoom(label: string, key: unknown, time: number, sig: unknown, extra = new Uint8Array(0)) {
  if (typeof key !== "string" || typeof sig !== "string" || !KEY.test(key) || !SIG.test(sig)) return null;
  const k = unb64url(key);
  const room = hex(await sha256(k));
  const t = new Uint8Array(8);
  new DataView(t.buffer).setBigUint64(0, BigInt(time));
  return (await signed(k, unb64url(sig), new Uint8Array([...utf8(label), ...unhex(room), ...t, ...extra]))) ? room : null;
}

export function frame(stream: number, kind: number, body: Uint8Array = new Uint8Array(0)) {
  const f = new Uint8Array(5 + body.length);
  new DataView(f.buffer).setUint32(0, stream);
  f[4] = kind;
  f.set(body, 5);
  return f;
}

// A JSON object with a string `t`, or null.
export function parse(text: string | ArrayBuffer): Record<string, unknown> | null {
  if (typeof text !== "string") return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && typeof v.t === "string" ? v : null;
  } catch {
    return null;
  }
}

// What a limit counts: an IPv4 address, or an IPv6 /64, since one host may hold a whole /64.
export function source(ip: string) {
  if (!ip.includes(":")) return ip;
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t];
  return `${groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(":")}::/64`;
}
