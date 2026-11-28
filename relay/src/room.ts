import { DurableObject } from "cloudflare:workers";
import { COST_STEP, month, nextMonth, paid, prices } from "./budget";
import {
  CLOSE,
  DATA,
  type Env,
  LIMITED,
  MALFORMED,
  OFFLINE,
  OPEN,
  PASS,
  PAUSED,
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

// A socket's state lives in its attachment, so it survives hibernation. `ok`: proven or admitted. The computer's
// carries the room's month: bytes `used` (`kept`: as last stored), cost not yet reported, and the budget's last answer.
type Mac = {
  mac: true;
  ok: boolean;
  room: string;
  addr: string;
  at: number;
  nonce: string;
  month: string;
  used: number;
  kept: number;
  cost: number;
  free: boolean;
};
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
// The count is stored at every MB of it, and at 80% and 100% of the ceiling.
const MB = 1_000_000;
const step = (used: number, ceiling: number) => (ceiling ? [0.8, 1].filter((f) => used >= f * ceiling).length : 0);

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
  private price = prices(this.env);

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Nothing about whose room: it shows hibernation's wakes on the local emulator.
    console.log("a room woke");
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const addr = req.headers.get("CF-Connecting-IP") ?? "";
    const [client, server] = Object.values(new WebSocketPair());
    const at = Date.now();
    if (url.pathname === "/v1/mac") {
      const nonce = b64(crypto.getRandomValues(new Uint8Array(32)));
      const room = url.searchParams.get("room") ?? "";
      this.ctx.acceptWebSocket(server, ["mac"]);
      server.serializeAttachment({ mac: true, ok: false, room, addr, at, nonce, month: "", used: 0, kept: 0, cost: 0, free: true } satisfies Mac);
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
    const held = await store.get<{ month: string; used: number; cost: number }>("usage");
    const used = held?.month === month() ? held.used : 0;
    const cost = (held?.cost ?? 0) + this.price.request;
    ws.serializeAttachment({ ...s, ok: true, nonce: "", month: month(), used, kept: used, cost, free: true } satisfies Mac);
    ws.send(JSON.stringify({ t: "ready", seen }));
    await this.settle(ws, 0, this.price.message, true);
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
    if (typeof msg === "string") {
      // Controls cost like any message, but don't count toward the ceiling.
      await this.settle(ws, 0, this.price.message);
      return this.control(ws, s, msg);
    }
    const b = new Uint8Array(msg);
    if (b.length < 5 || b.length > MAX_MESSAGE + 5 || b[4] > CLOSE) return this.gone(ws, MALFORMED);
    const stream = new DataView(msg).getUint32(0);
    // A stream already gone has its close on the way to the computer.
    const phone = this.ctx.getWebSockets(`s${stream}`).find((w) => seat(w).ok);
    if (!phone) return;
    if (b[4] === DATA) {
      const held = this.paused(s);
      if (held) return this.cut(held);
      const why = await this.settle(ws, b.length - 5, this.price.message);
      phone.send(b.subarray(5));
      if (why) this.cut(why);
    } else if (b[4] === CLOSE) {
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
    // Every new stream is reported, so a spent budget is known before it carries anything.
    const why = await this.settle(mac, 0, this.price.request + this.price.message, true);
    if (why) {
      ws.send(JSON.stringify({ t: "paused", until: why === "ceiling" ? nextMonth() : 0 }));
      shut(ws, PAUSED);
      return this.cut(why);
    }
    ws.serializeAttachment({ ...s, ok: true } satisfies Phone);
    ws.send(JSON.stringify({ t: "ok" }));
    mac.send(frame(s.stream, OPEN, utf8(s.addr)));
  }

  private async fromPhone(ws: WebSocket, s: Phone, msg: string | ArrayBuffer) {
    if (typeof msg === "string" || msg.byteLength > MAX_MESSAGE) return this.gone(ws, MALFORMED);
    const mac = this.mac();
    if (!mac) return this.gone(ws, OFFLINE);
    if (this.paused(seat(mac) as Mac)) return this.gone(ws, PAUSED);
    const why = await this.settle(mac, msg.byteLength, this.price.message);
    mac.send(frame(s.stream, DATA, new Uint8Array(msg)));
    if (why) this.cut(why);
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

  // The computer socket is done: its count and time are kept, its phones' streams end with it.
  private async retire(ws: WebSocket, s: Mac) {
    ws.serializeAttachment({ ...s, ok: false } satisfies Mac);
    await this.ctx.storage.put({ usage: { month: s.month, used: s.used, cost: s.cost }, seen: now() });
    for (const phone of this.ctx.getWebSockets("phone")) {
      const p = seat(phone);
      if (!p.ok) continue;
      phone.serializeAttachment({ ...p, ok: false });
      shut(phone, OFFLINE);
    }
  }

  /**
   * Counts `n` relayed bytes and `cost` on the computer's socket before they are forwarded, and brings its month up
   * to date. Stored at every MB, ceiling step and new month; reported to the budget then, at every COST_STEP and when
   * `report`. The computer hears its usage at each of those and at each change of pause. Returns why phones can't
   * pass now, or null. Only `report` (a new stream or computer) waits for the budget's answer: a frame never waits on
   * it, so frames are forwarded in the order they came; a pause it brings is applied when it comes.
   */
  private async settle(mac: WebSocket, n: number, cost: number, report = false) {
    const was = seat(mac) as Mac;
    const s = { ...was, cost: was.cost + cost };
    if (s.month !== month()) Object.assign(s, { month: month(), used: 0, kept: 0 });
    s.used += n;
    const c = this.ceiling();
    const write = s.month !== was.month || s.used - s.kept >= MB || step(s.used, c) !== step(was.used, c);
    const ask = Boolean(this.env.BUDGET_USD) && (report || write || s.cost >= COST_STEP);
    const owed = s.cost;
    if (ask) s.cost = 0;
    if (write) s.kept = s.used;
    mac.serializeAttachment(s satisfies Mac);
    if (write) await this.ctx.storage.put("usage", { month: s.month, used: s.used, cost: s.cost });
    const why = this.paused(s);
    if (write || report || ask || why !== this.paused(was)) mac.send(this.usage(s));
    if (!ask) return why;
    // The socket's state is written before this wait, so a message handled meanwhile is never lost.
    const answer = this.env.BUDGET.get(this.env.BUDGET.idFromName("all"))
      .add(owed)
      .then((free) => this.answer(mac, free), () => this.paused(seat(mac) as Mac));
    return report ? answer : why;
  }

  // The budget's answer: a change of pause tells the computer, and a pause cuts every phone stream.
  private answer(mac: WebSocket, free: boolean) {
    const was = seat(mac) as Mac;
    if (!was.ok) return null;
    const s = { ...was, free };
    mac.serializeAttachment(s satisfies Mac);
    const why = this.paused(s);
    if (why !== this.paused(was)) mac.send(this.usage(s));
    if (why) this.cut(why);
    return why;
  }

  // Why this room's phones can't pass now: its ceiling this month, or the relay's budget (or FREE_OPEN off).
  private paused(s: Mac) {
    if (paid(s.room)) return null;
    if (this.env.FREE_OPEN === "0" || !s.free) return "budget";
    const c = this.ceiling();
    return c && s.used >= c ? "ceiling" : null;
  }

  private usage(s: Mac) {
    const ceiling = paid(s.room) ? 0 : this.ceiling();
    return JSON.stringify({ t: "usage", month: s.month, used: s.used, ceiling, until: nextMonth(), paused: this.paused(s) });
  }

  // 0: no ceiling (a user's own relay).
  private ceiling() {
    return Number(this.env.CEILING) || 0;
  }

  // Every phone stream ends with the paused code, told until when first (0: no date); the computer hears each close.
  private cut(why: "ceiling" | "budget") {
    const paused = JSON.stringify({ t: "paused", until: why === "ceiling" ? nextMonth() : 0 });
    for (const phone of this.ctx.getWebSockets("phone")) {
      if (!seat(phone).ok) continue;
      phone.send(paused);
      void this.gone(phone, PAUSED);
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
