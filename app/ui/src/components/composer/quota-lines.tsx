import { countdown, tightest } from "../../accounts/usage";
import type { Limit } from "../../accounts/api";

/** One signed-in account's limits as Rust serves them on a model group (C1): `used` and `resets` null where unknown. */
export type Quota = { account: string; name: string; limits: { name: string; used: number | null; resets: number | null }[] };

/**
 * One quiet line per account under the agent's models, in the usage popover's words [D337, D2039]: its tightest
 * limit ("Personal · 5-hour 40% used · resets in 2h 14m"), only the window's name once its reset has passed [D379],
 * "Not reported yet" while every window is unknown.
 */
export function QuotaLines({ usage }: { usage: readonly Quota[] }) {
  const now = Date.now();
  return (
    <div data-slot="model-picker-quota" className="flex shrink-0 flex-col gap-0.5 text-xs text-muted-foreground tabular-nums">
      {usage.map((account) => (
        <p key={account.account} className="truncate">
          {quotaWords(account, now)}
        </p>
      ))}
    </div>
  );
}

function quotaWords({ name, limits }: Quota, now: number): string {
  const over = (limit: Quota["limits"][number]) => limit.resets !== null && limit.resets <= now;
  const passed = limits.find(over);
  const top = tightest(limits.filter((limit): limit is Limit => limit.used !== null && !over(limit)));
  if (!top) return `${name} · ${passed ? passed.name : "Not reported yet"}`;
  return [name, `${top.name} ${top.used}% used`, top.resets !== null && `resets in ${countdown(top.resets, now)}`].filter(Boolean).join(" · ");
}
