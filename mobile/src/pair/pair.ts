// Pairing and signing in, as crates/daemon/src/remote/pair.rs has them; the keys never leave the native module.
import Link, { type Mac, type Pass } from "../../modules/link";
import { ask, close, closeCount, connect, next, send, streamNow } from "../link";
import { PROTO } from "../../../app/shared/proto";
import { register } from "../push";

export type Problem =
  | "expired" | "reused" | "denied" | "unreachable" | "noOffer" | "wrongCode"
  | "notPaired" | "updatePhone" | "updateMac" | "lost" | "badQr" | "localNetwork";

/** What a Mac's QR holds: `https://brigadier.sh/p#v=1&m=…&s=…&a=…&e=…`, and `&r=<relay>&k=<key>&p=<until>.<sig>` while a relay carries it. */
export type Offer = { mac: string; secret: string; addresses: string[]; expires: number; relay?: Pass };

/** Where a typed code is looked up when no Mac on this Wi-Fi holds it, after the relays the paired Macs name. */
const HOSTED = "wss://relay.brigadier.sh";

/** The relay's phone socket for a pass (relay-wire "A phone's socket"); none once the pass has run out. */
const socket = (p: Pass | undefined) => (p && p.until * 1000 > Date.now() ? [`${p.url.replace(/\/+$/, "")}/v1/phone?key=${p.key}&until=${p.until}&sig=${p.sig}`] : []);

/** The pass's parts, checked before they go into a URL: a relay is ws(s)://, a key 65 bytes, a signature 64. */
function readPass(url: string | undefined, key: string | undefined, pass: string | undefined): Pass | undefined {
  const [until, sig] = (pass ?? "").split(".");
  if (!/^wss?:\/\/[^\s?#]+$/.test(url ?? "") || !/^[A-Za-z0-9_-]{87}$/.test(key ?? "") || !/^[0-9]{1,12}$/.test(until) || !/^[A-Za-z0-9_-]{86}$/.test(sig ?? "")) return undefined;
  return { url: url!, key: key!, until: Number(until), sig };
}

export function readQr(url: string): Offer | null {
  if (!url.startsWith("https://brigadier.sh/p#")) return null;
  const q = new Map(url.slice(url.indexOf("#") + 1).split("&").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  const [mac, secret, a, e] = [q.get("m"), q.get("s"), q.get("a"), Number(q.get("e"))];
  // Both keys are 32 bytes, base64url without padding.
  const key = /^[A-Za-z0-9_-]{43}$/;
  if (q.get("v") !== "1" || !key.test(mac ?? "") || !key.test(secret ?? "") || !a || !e) return null;
  return { mac: mac!, secret: secret!, addresses: a.split(","), expires: e, relay: readPass(q.get("r"), q.get("k"), q.get("p")) };
}

/** The typed code as the Mac derives from it: uppercase, `-` and spaces dropped, I/L as 1 and O as 0; null if it isn't 16 of Crockford's characters. */
export function readCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[-\s]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(code) ? code : null;
}

/**
 * The first request: the version check. A new relay pass replaces the one kept with the Mac; none (its relay socket
 * down for a moment, or turned off) keeps the old one, which then meets an offline relay after the direct paths.
 */
async function hello(pk: string): Promise<"ok" | Problem> {
  const r = await ask({ op: "hello", proto: PROTO, build: Link.build });
  if (r.ok) {
    if (r.relay) await Link.relay(pk, r.relay);
    void register(pk);
    return "ok";
  }
  if (r.error === "proto") return PROTO < r.proto_min ? "updatePhone" : "updateMac";
  return "lost";
}

/** The stream an attempt opened, -1 before it has one: all it may close. */
type Own = { n: number };

async function opened(own: Own, ...args: Parameters<typeof connect>) {
  const r = await connect(...args);
  own.n = r.stream ?? -1;
  return r;
}

/** Face ID's signature, or null if it was cancelled or the attempt lost its stream meanwhile (a newer one owns it). */
async function signature(own: Own): Promise<string | null> {
  try {
    const sig = await Link.sign();
    return own.n === streamNow() ? sig : null;
  } catch {
    close(own.n);
    return null;
  }
}

/** A native failure (the stream gone under a write, a Keychain error) ends the attempt as "lost", never stuck. */
async function guarded<T>(f: (own: Own) => Promise<T>): Promise<T | "lost"> {
  const own = { n: -1 };
  try {
    return await f(own);
  } catch {
    close(own.n);
    return "lost";
  }
}

type Paired = Mac | Problem | "cancelled";

/**
 * Pairs by a scanned offer or a typed code. `onCheck` gets the 6 digits once the Mac is asking; the result is the
 * Mac kept, a problem, or "cancelled" (Face ID was, or `close` was called).
 */
export const pair = (how: { offer: Offer } | { code: string }, onCheck: (digits: string) => void) => guarded((own) => pairing(own, how, onCheck));

async function pairing(own: Own, how: { offer: Offer } | { code: string }, onCheck: (digits: string) => void): Promise<Paired> {
  // Cancel calls `close`; each step after a wait checks it, so a cancelled pairing never goes on to save.
  const was = closeCount();
  const cancelled = () => closeCount() !== was;
  let check: string | undefined;
  let addresses: string[] = [];
  if ("offer" in how) {
    const { mac, secret, expires } = how.offer;
    if (expires * 1000 < Date.now()) return "expired";
    addresses = how.offer.addresses;
    const r = await opened(own, "qr", mac, [...addresses, ...socket(how.offer.relay)], secret);
    if (r.error) return r.error === "closed" ? "cancelled" : r.error === "refused" ? "expired" : "unreachable";
    check = r.check;
  } else {
    const { found, denied } = await Link.browse(3000);
    if (cancelled()) return "cancelled";
    const waiting = found.filter((f) => f.open === "1");
    // A Mac whose message 2 doesn't open holds another code: try the next.
    for (const f of waiting) {
      const r = await opened(own, "code", f.pk, [`bonjour:${f.name}`], how.code);
      if (r.error === "closed") return "cancelled";
      check = r.check;
      if (check) break;
    }
    if (!check) {
      // Away from home: the relays the paired Macs name, then the hosted one.
      const relays = new Set([...(await Link.macs()).flatMap((m) => (m.relay ? [m.relay.url.replace(/\/+$/, "")] : [])), HOSTED]);
      const far = await Link.find([...relays], how.code);
      if (cancelled()) return "cancelled";
      if (!far) return waiting.length ? "wrongCode" : denied ? "localNetwork" : "noOffer";
      const r = await opened(own, "code", far.m, socket(readPass(far.url, far.key, `${far.until}.${far.sig}`)), how.code);
      if (r.error) return r.error === "closed" ? "cancelled" : r.error === "refused" ? "wrongCode" : "unreachable";
      check = r.check;
    }
  }
  const sig = await signature(own);
  if (!sig || cancelled()) return "cancelled";
  send({ sig });
  onCheck(check!);
  // The Mac asks its owner for up to 2 minutes.
  const answer = await next(150_000);
  if (!answer) return "reused";
  if (answer.paired !== true) return "denied";
  const signed = await next();
  if (signed?.signed !== true) return "reused";
  if (cancelled()) return "cancelled";
  const pk = await Link.save(signed.name, signed.device, addresses);
  const h = await hello(pk);
  if (h !== "ok") return h;
  return (await Link.macs()).find((m) => m.pk === pk)!;
}

/**
 * Signs in to a paired Mac: found again on Bonjour by its key, else at the addresses kept, else through its relay.
 * `resume` first, then Face ID. `seen`: the relay has no Mac now, and last had it then (unix s). `paused`: the relay
 * carries none of its streams until then (0: no date).
 */
export const signIn = (mac: Mac) => guarded((own) => signingIn(own, mac));

async function signingIn(own: Own, mac: Mac): Promise<"ok" | Problem | "cancelled" | { seen: number } | { paused: number }> {
  const { found, denied } = await Link.browse(1500);
  const near = found.filter((f) => f.pk === mac.pk).map((f) => `bonjour:${f.name}`);
  // The pass as the last `hello` left it, which may be newer than the record shown.
  const pass = (await Link.macs()).find((m) => m.pk === mac.pk)?.relay;
  const r = await opened(own, "device", mac.pk, [...near, ...mac.addresses, ...socket(pass)], null);
  if (r.paused !== undefined) return { paused: r.paused };
  if (r.seen !== undefined) return { seen: r.seen };
  if (r.error) return r.error === "closed" ? "cancelled" : r.error === "refused" ? "notPaired" : denied ? "localNetwork" : "unreachable";
  send({ resume: true });
  let answer = await next();
  if (answer?.signed === false) {
    const sig = await signature(own);
    if (!sig) return "cancelled";
    send({ sig });
    answer = await next();
  }
  if (answer?.signed !== true) return "notPaired";
  return hello(mac.pk);
}
