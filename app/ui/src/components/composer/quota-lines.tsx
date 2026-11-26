import { countdown, tightest } from "../../accounts/usage";
import type { Limit } from "../../accounts/api";
import { UsageBar } from "../usage-bar";

/** One signed-in account's limits as Rust serves them on a model group (C1): `used` and `resets` null where unknown. */
export type Quota = { account: string; name: string; limits: { name: string; used: number | null; resets: number | null }[] };

/**
 * What an account has left, as a bar of its tightest limit [D337, D2039]: only the window's name once its reset has
 * passed [D379], "No recent reading" while every window is unknown (never read, or read over an hour ago).
 */
export function QuotaLeft({ account: { name, limits } }: { account: Quota }) {
  const now = Date.now();
  const over = (limit: Quota["limits"][number]) => limit.resets !== null && limit.resets <= now;
  const top = tightest(limits.filter((limit): limit is Limit => limit.used !== null && !over(limit)));
  if (!top) return <p className="text-xs text-muted-foreground">{name} · {limits.find(over)?.name ?? "No recent reading"}</p>;
  const left = 100 - top.used;
  const resets = top.resets === null ? null : countdown(top.resets, now);
  return (
    <div className="flex flex-col gap-1 text-xs tabular-nums" title={resets === null ? top.name : `${top.name}, resets in ${resets}`}>
      <span className="flex justify-between gap-2">
        <span className="truncate text-muted-foreground">{name} · {top.name}</span>
        <span className="shrink-0">{left}% left</span>
      </span>
      <UsageBar value={left} fill={left < 20 ? "bg-warning" : "bg-foreground"} label={`${name} ${top.name} left`} />
      {resets !== null && <span className="text-placeholder">Resets in {resets}</span>}
    </div>
  );
}
