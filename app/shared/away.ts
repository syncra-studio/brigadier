// Away from home's words for both apps: the relay's monthly meter and its pause (relay-wire rev 3).

/** The relay's last `usage` for this computer: bytes this month (UTC), its ceiling (0: none), when the month ends (unix s), why phones are paused. */
export type Usage = { month: string; used: number; ceiling: number; until: number; paused: "ceiling" | "budget" | null };

const day = new Intl.DateTimeFormat(undefined, { month: "long", day: "numeric", timeZone: "UTC" });
const mb = (bytes: number) => (bytes < 10e6 ? (bytes / 1e6).toFixed(1) : String(Math.round(bytes / 1e6)));

/** "Used 112 of 150 MB this month". */
export const used = (u: Usage) => (u.ceiling ? `Used ${mb(u.used)} of ${mb(u.ceiling)} MB this month` : `Used ${mb(u.used)} MB this month`);

/** From 80% of the ceiling until it is reached. */
export const nearly = (u: Usage) => u.ceiling > 0 && !u.paused && u.used >= 0.8 * u.ceiling;

/** The usage as it stands now: one from an earlier UTC month has reset, and its pause (ceiling or budget) with it. */
export function current(u: Usage, now = Date.now()): Usage {
  const d = new Date(now);
  const month = d.toISOString().slice(0, 7);
  if (u.month === month) return u;
  return { ...u, month, used: 0, paused: null, until: Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000 };
}

export const nearlyLine = (u: Usage) => `Away-from-home connections pause at ${mb(u.ceiling)} MB until ${day.format(u.until * 1000)}.`;

/**
 * The pause in the computer's words, or the phone's with the computer's `name`. `until`: unix s, 0 when the
 * relay's budget is spent for everyone.
 */
export function pausedLine(until: number, name?: string) {
  const when = until ? `until ${day.format(until * 1000)}` : "for everyone";
  const who = name ? `Away from home, ${name}'s connection is` : "Away-from-home connections are";
  return `${who} paused ${when}. On the same Wi-Fi it still works.`;
}
