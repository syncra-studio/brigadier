import { UsageBar } from "../components/usage-bar";
import { cx } from "../components/cx";
import type { Limit } from "./api";

/** The limit nearest its end. */
export const tightest = (limits: readonly Limit[]) => limits.reduce<Limit | null>((top, each) => (top && top.used >= each.used ? top : each), null);

/** Usage's text and bar colours, the old app's: normal below 80% used, warning from 80%, danger from 90%. */
function tone(used: number) {
  if (used >= 90) return { text: "text-destructive", fill: "bg-destructive" };
  if (used >= 80) return { text: "text-warning", fill: "bg-warning" };
  return { text: "text-foreground", fill: "bg-placeholder" };
}

/** A closed account row's figure: its tightest limit's name, a short bar and the share used. */
export function TightestUsage({ limit }: { limit: Limit }) {
  const { text, fill } = tone(limit.used);
  return (
    <span className="flex min-w-0 items-center gap-2 text-xs tabular-nums" title={`${limit.name}: ${limit.used}% used`}>
      <span className="truncate text-muted-foreground">{limit.name}</span>
      <UsageBar value={limit.used} fill={fill} label={limit.name} className="w-10" />
      <span className={cx("font-medium", text)}>{limit.used}%</span>
    </span>
  );
}

/** An open account row's limit: its name, a bar, the share used and when it resets. */
export function LimitLine({ limit, now }: { limit: Limit; now: number }) {
  const { text, fill } = tone(limit.used);
  return (
    <span className="flex items-center gap-3 text-xs tabular-nums">
      <span className="w-33 shrink-0 truncate text-foreground">{limit.name}</span>
      <UsageBar value={limit.used} fill={fill} label={limit.name} className="max-w-85 min-w-16 flex-1 shrink" />
      <span className={cx("w-18 shrink-0 text-right font-medium", text)}>{limit.used}% used</span>
      <span className="w-36 shrink-0 truncate text-muted-foreground">{limit.resets !== null && resetsWords(limit.resets, now)}</span>
    </span>
  );
}

/** The sidebar's Usage row's figure, the old app's Share: a short bar and the share used. */
export function Share({ limit }: { limit: Limit }) {
  const { text, fill } = tone(limit.used);
  return (
    <>
      <UsageBar value={limit.used} fill={fill} label={limit.name} className="w-11" />
      <span className={cx("w-16 shrink-0 text-end text-xs font-medium tabular-nums", text)}>{limit.used}% used</span>
    </>
  );
}

/** The overview row's figure: the in-use account's tightest limit over its bar. */
export function UsageMeter({ limit, now }: { limit: Limit; now: number }) {
  const { text, fill } = tone(limit.used);
  const resets = limit.resets !== null ? `, resets in ${countdown(limit.resets, now)}` : "";
  return (
    <div className="flex w-45 min-w-0 flex-col gap-1.5" title={`${limit.name}: ${limit.used}% used${resets}`}>
      <span className="flex items-baseline justify-between gap-2 text-xs whitespace-nowrap tabular-nums">
        <span className="truncate text-muted-foreground">{limit.name} · in use</span>
        <span className={cx("font-medium", text)}>{limit.used}% used</span>
      </span>
      <UsageBar value={limit.used} fill={fill} label={limit.name} />
    </div>
  );
}

const DAY_MS = 86_400_000;
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** When a limit resets: "Resets in 2h 14m" within a day, else its day and time ("Resets Tue 9:00 AM"). */
function resetsWords(resets: number, now: number): string {
  if (resets - now < DAY_MS) return `Resets in ${countdown(resets, now)}`;
  return `Resets ${WEEKDAY.format(resets)} ${TIME.format(resets)}`;
}

/** "now", "42m", "2h 5m", "3d 4h": the time left until `ms`. */
export function countdown(ms: number, now: number): string {
  const minutes = Math.ceil((ms - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}
