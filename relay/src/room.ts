import { DurableObject } from "cloudflare:workers";
import {
  CLOSE,
  DATA,
  type Env,
  LIMITED,
  MALFORMED,
  OFFLINE,
  OPEN,
  PASS,
  REFUSED,
  REPLACED,
  b64,
  doorRoom,
  frame,
  hex,
  isHash,
  now,
  parse,
  sha256,
  signed,
  source,
  unb64,
  unhex,
  utf8,
} from "./wire";

// A socket's state lives in its attachment, so it survives hibernation. `ok`: proven or admitted.
type Mac = { mac: true; ok: boolean; room: string; addr: string; at: number; nonce: string; bytes: number };
type Phone = { mac: false; ok: boolean; stream: number; addr: string; at: number };
type Seat = Mac | Phone;

const HELLO_MS = 10_000;
const MAX_TOKENS = 100;
const MAX_INVITES = 32;
// An offer lives 5 minutes; nothing a computer registers outlives this.
const MAX_LIFE = 600;
const MAX_MESSAGE = 65_535;
// Text is bounded before it is parsed: 4 KB from anyone, 16 KB from a proven computer (100 token hashes are ~7 KB).
const MAX_TEXT = 4_096;
const MAX_MAC_TEXT = 16_384;

const seat = (ws: WebSocket) => ws.deserializeAttachment() as Seat;

function shut(ws: WebSocket, code: number) {
  try {
    ws.close(code, "");
  } catch {
    // already closed
  }
}

// One computer's room: its socket, its phones' sockets, and the little it must remember. Never a message.
export class Room extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const addr = req.headers.get("CF-Connecting-IP") ?? "";
    const [client, server] = Object.values(new WebSocketPair());
    const at = Date.now();
    if (url.pathname === "/v1/mac") {
      const nonce = b64(crypto.getRandomValues(new Uint8Array(32)));
      const room = url.searchParams.get("room") ?? "";
      this.ctx.acceptWebSocket(server, ["mac"]);
      server.serializeAttachment({ mac: true, ok: false, room, addr, at, nonce, bytes: 0 } satisfies Mac);
      server.send(JSON.stringify({ t: "challenge", nonce }));
    } else {
      const stream = this.freeStream();
      this.ctx.acceptWebSocket(server, ["phone", `s${stream}`]);
      server.serializeAttachment({ mac: false, ok: false, stream, addr, at } satisfies Phone);
    }
    await this.wake(at + HELLO_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const s = seat(ws);
    if (typeof msg === "string" && msg.length > (s.mac && s.ok ? MAX_MAC_TEXT : MAX_TEXT)) return this.gone(ws, MALFORMED);
    if (s.mac) await (s.ok ? this.fromMac(ws, s, msg) : this.prove(ws, s, msg));
    else await (s.ok ? this.fromPhone(ws, s, msg) : this.hello(ws, s, msg));
  }

  async webSocketClose(ws: WebSocket) {
    await this.gone(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.gone(ws);
  }

  // Closes sockets that never proved or said hello in time, and forgets ended invites.
  async alarm() {
    const due = [];
    for (const ws of this.ctx.getWebSockets()) {
      const s = seat(ws);
      if (s.ok) continue;
      if (Date.now() - s.at >= HELLO_MS) shut(ws, MALFORMED);
      else due.push(s.at + HELLO_MS);
    }
    const held = Object.keys((await this.ctx.storage.get("invites")) ?? {}).length;
    const invites = await this.invites();
    const live = Object.keys(invites).length;
    if (live < held) await (live ? this.ctx.storage.put("invites", invites) : this.ctx.storage.delete("invites"));
    due.push(...Object.values(invites).map((until) => until * 1000));
    if (due.length) await this.ctx.storage.setAlarm(Math.min(...due));
  }

  private async prove(ws: WebSocket, s: Mac, msg: string | ArrayBuffer) {
    const p = parse(msg);
    if (p?.t !== "proof" || typeof p.key !== "string" || typeof p.sig !== "string") return shut(ws, MALFORMED);
    if (!(await this.verify(s, p.key, p.sig))) return shut(ws, REFUSED);
    const store = this.ctx.storage;
    if (!(await store.get("key"))) {
      const quota = this.env.QUOTA.get(this.env.QUOTA.idFromName(source(s.addr)));
      if (!(await quota.take())) return shut(ws, LIMITED);
    }
    const seen = (await store.get<number>("seen")) ?? 0;
    for (const old of this.ctx.getWebSockets("mac")) {
      const o = seat(old);
      if (old !== ws && o.ok && o.mac) {
        await this.retire(old, o);
        shut(old, REPLACED);
      }
    }
    await store.put({ key: p.key, seen: now() });
    ws.serializeAttachment({ ...s, ok: true, nonce: "" } satisfies Mac);
    ws.send(JSON.stringify({ t: "ready", seen }));
  }

  private async verify(s: Mac, key64: string, sig64: string) {
    // 65 and 64 bytes in padded base64, checked before decoding.
    if (key64.length !== 88 || sig64.length !== 88) return false;
    try {
      const key = unb64(key64);
      if (hex(await sha256(key)) !== s.room) return false;
      const data = new Uint8Array([...utf8("brigadier/relay/mac/v1"), ...unhex(s.room), ...unb64(s.nonce)]);
      return await signed(key, unb64(sig64), data);
    } catch {
      return false;
    }
  }

  private async fromMac(ws: WebSocket, s: Mac, msg: string | ArrayBuffer) {
    if (typeof msg === "string") return this.control(ws, s, msg);
    const b = new Uint8Array(msg);
    if (b.length < 5 || b.length > MAX_MESSAGE + 5 || b[4] > CLOSE) return this.gone(ws, MALFORMED);
    ws.serializeAttachment({ ...s, bytes: s.bytes + b.length } satisfies Mac);
    const stream = new DataView(msg).getUint32(0);
    // A stream already gone has its close on the way to the computer.
    const phone = this.ctx.getWebSockets(`s${stream}`).find((w) => seat(w).ok);
    if (!phone) return;
    if (b[4] === DATA) phone.send(b.subarray(5));
    else if (b[4] === CLOSE) {
      phone.serializeAttachment({ ...seat(phone), ok: false });
      shut(phone, 1000);
    }
  }

  private async control(ws: WebSocket, s: Mac, text: string) {
    const p = parse(text);
    if (!p) return this.gone(ws, MALFORMED);
    const store = this.ctx.storage;
    const until = p.until;
    if (p.t === "tokens") {
      const set = p.set;
      if (!Array.isArray(set) || set.length > MAX_TOKENS || !set.every(isHash)) return this.gone(ws, MALFORMED);
      await store.put("tokens", set);
    } else if (p.t === "invite") {
      if (!isHash(p.h) || !Number.isInteger(until)) return this.gone(ws, MALFORMED);
      const invites = await this.invites();
      delete invites[p.h];
      if ((until as number) > now()) invites[p.h] = Math.min(until as number, now() + MAX_LIFE);
      if (Object.keys(invites).length > MAX_INVITES) return this.gone(ws, MALFORMED);
      await (Object.keys(invites).length ? store.put("invites", invites) : store.delete("invites"));
      if (invites[p.h]) await this.wake(invites[p.h] * 1000);
    } else if (p.t === "lookup") {
      if (!isHash(p.id) || !Number.isInteger(until)) return this.gone(ws, MALFORMED);
      const lookup = this.env.LOOKUP.get(this.env.LOOKUP.idFromName(p.id));
      if ((until as number) <= now()) return lookup.remove(s.room);
      // The answer carries a pass for this room, so only one this room's key signed is kept.
      const m = typeof p.m === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(p.m) ? p.m : "";
      if (!m || (await doorRoom(PASS, p.key, until as number, p.sig)) !== s.room) return this.gone(ws, MALFORMED);
      const found = { room: s.room, m, key: p.key as string, until: until as number, sig: p.sig as string };
      await lookup.set(found, Math.min(until as number, now() + MAX_LIFE));
    }
    // Any other `t` is from a newer computer: ignored.
  }

  private async hello(ws: WebSocket, s: Phone, msg: string | ArrayBuffer) {
    const p = parse(msg);
    if (p?.t !== "hello" || !isHash(p.v)) return shut(ws, MALFORMED);
    const h = hex(await sha256(unhex(p.v)));
    const tokens = (await this.ctx.storage.get<string[]>("tokens")) ?? [];
    if (!tokens.includes(h) && !((await this.invites())[h] > now())) return shut(ws, REFUSED);
    const mac = this.mac();
    if (!mac) {
      ws.send(JSON.stringify({ t: "offline", seen: (await this.ctx.storage.get<number>("seen")) ?? 0 }));
      return shut(ws, OFFLINE);
    }
    ws.serializeAttachment({ ...s, ok: true } satisfies Phone);
    ws.send(JSON.stringify({ t: "ok" }));
    mac.send(frame(s.stream, OPEN, utf8(s.addr)));
  }

  private async fromPhone(ws: WebSocket, s: Phone, msg: string | ArrayBuffer) {
    if (typeof msg === "string" || msg.byteLength > MAX_MESSAGE) return this.gone(ws, MALFORMED);
    const mac = this.mac();
    if (!mac) return this.gone(ws, OFFLINE);
    const f = frame(s.stream, DATA, new Uint8Array(msg));
    const m = seat(mac) as Mac;
    mac.serializeAttachment({ ...m, bytes: m.bytes + f.length } satisfies Mac);
    mac.send(f);
  }

  // Every end of an admitted socket comes here, so a closing one never carries another byte.
  private async gone(ws: WebSocket, code = 1000) {
    shut(ws, code);
    const s = seat(ws);
    if (!s.ok) return;
    if (s.mac) return this.retire(ws, s);
    ws.serializeAttachment({ ...s, ok: false } satisfies Phone);
    this.mac()?.send(frame(s.stream, CLOSE));
  }

  // The computer socket is done: its bytes and time are kept, its phones' streams end with it.
  private async retire(ws: WebSocket, s: Mac) {
    ws.serializeAttachment({ ...s, ok: false } satisfies Mac);
    const bytes = (await this.ctx.storage.get<number>("bytes")) ?? 0;
    await this.ctx.storage.put({ bytes: bytes + s.bytes, seen: now() });
    for (const phone of this.ctx.getWebSockets("phone")) {
      const p = seat(phone);
      if (!p.ok) continue;
      phone.serializeAttachment({ ...p, ok: false });
      shut(phone, OFFLINE);
    }
  }

  private async wake(at: number) {
    const set = await this.ctx.storage.getAlarm();
    if (set === null || at < set) await this.ctx.storage.setAlarm(at);
  }

  private mac() {
    return this.ctx.getWebSockets("mac").find((w) => seat(w).ok);
  }

  private async invites() {
    const all = (await this.ctx.storage.get<Record<string, number>>("invites")) ?? {};
    return Object.fromEntries(Object.entries(all).filter(([, until]) => until > now()));
  }

  private freeStream() {
    for (;;) {
      const id = crypto.getRandomValues(new Uint32Array(1))[0] >>> 1;
      if (id > 0 && this.ctx.getWebSockets(`s${id}`).length === 0) return id;
    }
  }
}
