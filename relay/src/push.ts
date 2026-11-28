import { type Env, unb64, utf8 } from "./wire";

// Shown only where the phone's extension doesn't run; app/shared/away.ts's PUSH_WORDS.fallback, copied as the
// relay imports nothing.
const FALLBACK = "Your Mac needs you";
const TOPIC = "sh.brigadier.mobile";
// APNs' limit on a notification's payload.
const MAX = 4096;
// Apple wants a provider token renewed no more often than every 20 minutes and at least every 60.
const RENEW_MS = 40 * 60_000;

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

// shortcut: kept per isolate, so each isolate signs its own; keep one in a Durable Object if APNs answers TooManyProviderTokenUpdates.
let held: { jwt: string; at: number } | null = null;

// The APNs provider token: ES256 over the key id and team id, signed with the .p8 key (PEM or its bare base64).
async function token(env: Env) {
  if (held && Date.now() - held.at < RENEW_MS) return held.jwt;
  const der = unb64((env.APNS_KEY ?? "").replace(/-----[A-Z ]+-----|\s/g, ""));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const part = (o: object) => b64url(utf8(JSON.stringify(o)));
  const head = `${part({ alg: "ES256", kid: env.APNS_KEY_ID })}.${part({ iss: env.APNS_TEAM_ID, iat: Math.floor(Date.now() / 1000) })}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(head)));
  held = { jwt: `${head}.${b64url(sig)}`, at: Date.now() };
  return held.jwt;
}

// Whether this deploy can push: until the owner sets the three secrets, push answers "off" (status 0).
export const configured = (env: Env) => Boolean(env.APNS_KEY && env.APNS_KEY_ID && env.APNS_TEAM_ID);

// One sealed notification to APNs, kept nowhere: the extension replaces the fixed text with what `e` opens to.
// APNs' status, or 413 when it wouldn't fit.
export async function apns(env: Env, device: string, sealed: string) {
  const body = JSON.stringify({ aps: { alert: { body: FALLBACK }, "mutable-content": 1, sound: "default" }, e: sealed });
  if (body.length > MAX) return 413;
  const r = await fetch(`${env.APNS_URL ?? "https://api.push.apple.com"}/3/device/${device}`, {
    method: "POST",
    headers: { authorization: `bearer ${await token(env)}`, "apns-push-type": "alert", "apns-topic": TOPIC, "apns-priority": "10" },
    body,
  });
  await r.body?.cancel();
  return r.status;
}
