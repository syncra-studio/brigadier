import { DurableObject } from "cloudflare:workers";
import type { Env } from "./wire";

const ROOMS_A_DAY = 5;
const DAY = 86_400_000;

// New rooms one address may make in a day. Counted here, because the rate-limit binding is per location
// and has no period longer than a minute.
export class Quota extends DurableObject<Env> {
  async take(): Promise<boolean> {
    const day = Math.floor(Date.now() / DAY);
    const held = await this.ctx.storage.get<{ day: number; n: number }>("count");
    const n = held?.day === day ? held.n : 0;
    if (n >= ROOMS_A_DAY) return false;
    await this.ctx.storage.put("count", { day, n: n + 1 });
    await this.ctx.storage.setAlarm((day + 1) * DAY);
    return true;
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
