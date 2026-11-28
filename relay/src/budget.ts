import { DurableObject } from "cloudflare:workers";
import type { Env } from "./wire";

// Cloudflare's Workers Paid prices (plan §5), per deploy: PRICE_REQUESTS dollars a million requests, PRICE_GB_S a
// million GB-s, today's figures when unset. In dollars: a request, and a handled message: an incoming WebSocket
// message, billed at 20:1, plus its time awake at 128 MB. That time is a fixed slice per message, since a Worker's
// clock stands still while its code runs and idle time between messages may hibernate, which isn't billed.
const SLICE_S = 0.01;
export function prices(env: Env) {
  const request = (Number(env.PRICE_REQUESTS) || 0.15) / 1e6;
  const second = ((Number(env.PRICE_GB_S) || 12.5) / 1e6) * 0.125;
  return { request, message: request / 20 + second * SLICE_S };
}
// A room reports its cost at least this often, so the budget overshoots by at most this much per active room.
export const COST_STEP = 0.001;

// The calendar month in UTC ("2026-11"), and the unix second the next one starts: when a ceiling's pause ends.
export const month = () => new Date().toISOString().slice(0, 7);
export const nextMonth = () => {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
};

// R9's seam: whether this room has a licence. Until R9 none does, so nothing is unlimited.
export const paid = (_room: string) => false;

// The whole relay's estimated cost this month, against BUDGET_USD.
export class Budget extends DurableObject<Env> {
  // Adds one room's new cost; the answer is whether free traffic is still open.
  async add(cost: number): Promise<boolean> {
    const m = month();
    const held = await this.ctx.storage.get<{ month: string; spent: number }>("spent");
    const spent = (held?.month === m ? held.spent : 0) + cost;
    await this.ctx.storage.put("spent", { month: m, spent });
    return spent < Number(this.env.BUDGET_USD);
  }
}
