import { DurableObject } from "cloudflare:workers";
import { type Env, now } from "./wire";

// What a phone gets back: the room, its Noise key, and a pass to open it.
export type Found = { room: string; m: string; key: string; until: number; sig: string };

// One typed code's lookup id, until the offer ends (`end`, which may come before the pass's own `until`).
export class Lookup extends DurableObject<Env> {
  // False when another room holds this id while it is live.
  async set(found: Found, end: number): Promise<boolean> {
    const held = await this.ctx.storage.get<{ found: Found; end: number }>("entry");
    if (held && held.found.room !== found.room && held.end > now()) return false;
    await this.ctx.storage.put("entry", { found, end });
    await this.ctx.storage.setAlarm(end * 1000);
    return true;
  }

  async remove(room: string) {
    const held = await this.ctx.storage.get<{ found: Found }>("entry");
    if (held?.found.room === room) await this.alarm();
  }

  async find(): Promise<Found | null> {
    const e = await this.ctx.storage.get<{ found: Found; end: number }>("entry");
    return e && e.end > now() ? e.found : null;
  }

  async alarm() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
