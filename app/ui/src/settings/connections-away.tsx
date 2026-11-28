import { useState } from "react";

import { current, nearly, nearlyLine, pausedLine, type Usage, used } from "../../../shared/away";
import { CONNECTION_WORDS } from "../../../shared/words";
import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { type Choice, Segmented } from "../components/segmented";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { UsageBar } from "../components/usage-bar";
import { run } from "../onboarding/api";
import { useSave } from "./general";
import { SettingsSection } from "./parts";

/** `remote status`'s relay: what is chosen, the address the gateway was given, and how its socket is. `closed` is null until it closes once; `usage` until the relay first says it. */
export type Relay = { mode: Mode; url: string | null; ready: boolean; room: string | null; seen: number; closed: number | null; usage: Usage | null };

type Mode = "off" | "hosted" | "own";

export const AWAY_ROW = { label: "Away from home", description: "Reach this computer through a relay when your phone isn't on the same Wi-Fi", section: "Away from home" } as const;

const MODES: readonly Choice<Mode>[] = [
  { value: "off", label: "Off" },
  { value: "hosted", label: "Brigadier's relay" },
  { value: "own", label: "Your own relay" },
];

/** The relay's close codes the computer can do something about; 0 is the gateway's own, for no answer. */
const CLOSED: Record<number, string> = {
  0: "Can't reach the relay",
  4402: "The relay has paused this computer's connections",
  4403: "This relay doesn't admit this computer yet",
  4409: "Another computer used this computer's relay room",
};

const DEPLOY = "https://deploy.workers.cloudflare.com/?url=https://github.com/syncra-studio/brigadier/tree/main/relay";

/** This month's relayed bytes against the ceiling, and the notice from 80% and at the ceiling (or a spent budget). */
function UsageRow({ usage: last }: { usage: Usage }) {
  const usage = current(last);
  const paused = usage.paused !== null;
  const share = usage.ceiling ? Math.min(100, (usage.used / usage.ceiling) * 100) : 0;
  const notice = paused ? pausedLine(usage.paused === "budget" ? 0 : usage.until) : nearly(usage) ? nearlyLine(usage) : null;
  return (
    <SettingsRow
      label={used(usage)}
      description={notice && <span className={cx(paused && "text-warning")}>{notice}</span>}
    >
      {usage.ceiling > 0 && <UsageBar value={share} fill={paused || share >= 80 ? "bg-warning" : "bg-foreground"} label="Used this month" className="w-40" />}
    </SettingsRow>
  );
}

/** Settings › Connections › Away from home: no relay, Brigadier's, or one the user deployed; how its socket is, and its room. `offline`: the daemon's status can't be read now, so the last one isn't shown as current. */
export function AwaySection({ relay, paired, load, offline }: { relay: Relay; paired: boolean; load: () => Promise<unknown>; offline: boolean }) {
  // A choice shown before the daemon has it: "own" stays picked until its address is used.
  const [picked, setPicked] = useState<Mode | null>(null);
  // The field follows the daemon's address until it is edited.
  const [edit, setEdit] = useState<string | null>(null);
  const address = edit ?? (relay.mode === "own" ? (relay.url ?? "") : "");
  const [asking, setAsking] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const save = useSave();
  const mode = picked ?? relay.mode;
  const apply = (args: string[]) => {
    setAsking(null);
    setPicked(args[0] as Mode);
    setBusy(true);
    save.run(() =>
      run(["remote", "relay", ...args])
        .then(load)
        .then(
          () => {
            setPicked(null);
            setEdit(null);
          },
          (cause: unknown) => {
            // A refused address keeps its field to fix; anything else goes back to the daemon's choice.
            if (args[0] !== "own") setPicked(null);
            throw cause;
          },
        )
        .finally(() => setBusy(false)),
    );
  };
  // Paired phones learn a new relay only from this computer directly, so they're told first.
  const ask = (args: string[]) => (paired && args[0] !== "off" ? setAsking(args) : apply(args));
  const choose = (next: Mode) => (next === "own" || next === relay.mode ? setPicked(next === relay.mode ? null : next) : ask([next]));
  const url = address.trim();
  const shown = picked === null && relay.mode !== "off" && !offline;
  const state = busy ? CONNECTION_WORDS.connecting : relay.ready ? CONNECTION_WORDS.ready : relay.closed === null ? CONNECTION_WORDS.connecting : (CLOSED[relay.closed] ?? `The relay closed the connection (${relay.closed})`);
  return (
    <SettingsSection title={AWAY_ROW.label} description={AWAY_ROW.description} setting={AWAY_ROW.label}>
      <SettingsCard>
        <SettingsRow
          label="Relay"
          description={
            shown || busy ? (
              <span data-slot="relay-state" className={cx(!busy && !relay.ready && relay.closed !== null && "text-warning")}>
                {state}
                {relay.room && ` · Room ${relay.room.slice(0, 12)}…`}
              </span>
            ) : mode === "off" ? (
              "Your phone reaches this computer only on the same Wi-Fi"
            ) : undefined
          }
          error={mode === "own" ? null : save.error}
        >
          <Segmented label="Relay" value={mode} options={MODES} disabled={busy || offline} onChange={choose} />
        </SettingsRow>
        {shown && relay.usage && <UsageRow usage={relay.usage} />}
        {mode === "own" && (
          <div className="flex flex-col gap-3 px-4 py-3">
            <ol className="flex list-decimal flex-col gap-1.5 ps-5 text-label">
              <li>
                <a href={DEPLOY} target="_blank" rel="noreferrer" className="text-link hover:underline">
                  Deploy the relay
                </a>{" "}
                to your Cloudflare account.
              </li>
              <li>Copy the address it shows when it's done.</li>
              <li>Paste it here.</li>
            </ol>
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (url) ask(["own", url]);
              }}
            >
              <Input aria-label="Your relay's address" placeholder="wss://….workers.dev" value={address} aria-invalid={Boolean(save.error) || undefined} onChange={(event) => setEdit(event.target.value)} />
              <Button type="submit" size="sm" disabled={!url || busy || offline || (relay.mode === "own" && url === relay.url)}>
                Use
              </Button>
            </form>
            <ErrorLine error={save.error} />
          </div>
        )}
      </SettingsCard>
      <ConfirmDialog
        open={asking !== null}
        onOpenChange={(open) => !open && setAsking(null)}
        title="Change the relay?"
        description="Phones paired before this change use the new relay after they have been on the same Wi-Fi as this computer once."
        confirm="Change"
        onConfirm={() => asking && apply(asking)}
      />
    </SettingsSection>
  );
}
