// Pairing and signing in, as msgs/remote-wire.md has them; the keys never leave the native module.
import Link, { type Mac } from "../../modules/link";
import { ask, close, connect, next, send } from "../link";
import { PROTO } from "../../vendor/brigadier-shared/proto";

export type Problem =
  | "expired" | "reused" | "denied" | "unreachable" | "noOffer" | "wrongCode"
  | "notPaired" | "updatePhone" | "updateMac" | "lost" | "badQr";

/** What a Mac's QR holds: `https://brigadier.sh/p#v=1&m=…&s=…&a=…&e=…`. */
export type Offer = { mac: string; secret: string; addresses: string[]; expires: number };

export function readQr(url: string): Offer | null {
  if (!url.startsWith("https://brigadier.sh/p#")) return null;
  const q = new Map(url.slice(url.indexOf("#") + 1).split("&").map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]));
  const [mac, secret, a, e] = [q.get("m"), q.get("s"), q.get("a"), Number(q.get("e"))];
  if (q.get("v") !== "1" || !mac || !secret || !a || !e) return null;
  return { mac, secret, addresses: a.split(","), expires: e };
}

/** The typed code as the Mac derives from it: uppercase, `-` and spaces dropped, I/L as 1 and O as 0; null if it isn't 16 of Crockford's characters. */
export function readCode(typed: string): string | null {
  const code = typed.toUpperCase().replace(/[-\s]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return /^[0-9A-HJKMNP-TV-Z]{16}$/.test(code) ? code : null;
}

/** The first request: the version check. */
async function hello(): Promise<"ok" | Problem> {
  const r = await ask({ op: "hello", proto: PROTO, build: Link.build });
  if (r.ok) return "ok";
  if (r.error === "proto") return PROTO < r.proto_min ? "updatePhone" : "updateMac";
  return "lost";
}

async function signature(): Promise<string | null> {
  try {
    return await Link.sign();
  } catch {
    close();
    return null;
  }
}

/**
 * Pairs by a scanned offer or a typed code. `onCheck` gets the 6 digits once the Mac is asking; the result is the
 * Mac kept, a problem, or "cancelled" (Face ID was).
 */
export async function pair(how: { offer: Offer } | { code: string }, onCheck: (digits: string) => void): Promise<Mac | Problem | "cancelled"> {
  let check: string | undefined;
  let addresses: string[] = [];
  if ("offer" in how) {
    const { mac, secret, expires } = how.offer;
    if (expires * 1000 < Date.now()) return "expired";
    addresses = how.offer.addresses;
    const r = await connect("qr", mac, addresses, secret);
    if (r.error) return r.error === "refused" ? "expired" : "unreachable";
    check = r.check;
  } else {
    const waiting = (await Link.browse(3000)).filter((f) => f.open === "1");
    if (!waiting.length) return "noOffer";
    // A Mac whose message 2 doesn't open holds another code: try the next.
    for (const f of waiting) {
      check = (await connect("code", f.pk, [`bonjour:${f.name}`], how.code)).check;
      if (check) break;
    }
    if (!check) return "wrongCode";
  }
  const sig = await signature();
  if (!sig) return "cancelled";
  send({ sig });
  onCheck(check!);
  const answer = await next();
  if (!answer) return "reused";
  if (answer.paired !== true) return "denied";
  const signed = await next();
  if (signed?.signed !== true) return "reused";
  const pk = await Link.save(signed.name, signed.device, addresses);
  const h = await hello();
  if (h !== "ok") return h;
  return (await Link.macs()).find((m) => m.pk === pk)!;
}

/** Signs in to a paired Mac: found again on Bonjour by its key, else at the addresses kept. `resume` first, then Face ID. */
export async function signIn(mac: Mac): Promise<"ok" | Problem | "cancelled"> {
  const near = (await Link.browse(1500)).filter((f) => f.pk === mac.pk).map((f) => `bonjour:${f.name}`);
  const r = await connect("device", mac.pk, [...near, ...mac.addresses], null);
  if (r.error) return r.error === "refused" ? "notPaired" : "unreachable";
  send({ resume: true });
  let answer = await next();
  if (answer?.signed === false) {
    const sig = await signature();
    if (!sig) return "cancelled";
    send({ sig });
    answer = await next();
  }
  if (answer?.signed !== true) return "notPaired";
  return hello();
}
