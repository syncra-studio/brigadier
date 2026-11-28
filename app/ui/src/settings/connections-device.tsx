import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { RowText } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Switch } from "../components/switch";
import { ChevronRight } from "../icons";
import { errorText, run } from "../onboarding/api";
import { ago, clock } from "../panel/words";
import { useSave } from "./general";

/** A paired device, as `remote status` lists it. `powers` is null until the daemon checks them (M3). */
export type Device = {
  id: string;
  name: string;
  model: string;
  os: string;
  paired: number;
  seen: number | null;
  powers: Record<Power, boolean> | null;
};

type Power = "shell" | "level" | "overnight" | "settings" | "paths";

/** The five powers a phone may use with a fresh Face ID each time, switched per device on this Mac only, and what each risks (design §4.7) [D57]. */
const POWERS: readonly { power: Power; label: string; description: string }[] = [
  { power: "shell", label: "Shell", description: "One Face ID runs any command on this Mac as you." },
  { power: "level", label: "Permission level", description: "One Face ID sets a session to Full access, so its agent then acts without asking." },
  { power: "overnight", label: "Overnight", description: "One Face ID hands a session to its agent to run alone until someone turns it off." },
  { power: "settings", label: "Settings and accounts", description: "One Face ID can change which program Brigadier runs for an agent, or which account it uses." },
  { power: "paths", label: "Paths outside projects", description: "One Face ID can hand any file you can read on this Mac to an agent." },
];

const LABEL = Object.fromEntries(POWERS.map((each) => [each.power, each.label])) as Record<Power, string>;

type Entry = { at: number; power: Power; argv: string[] };

/** One device: its name, what it is and when it last connected, Revoke access; opened, its powers' switches and its Activity. */
export function DeviceRow({ device, revoke, load }: { device: Device; revoke: () => void; load: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen} data-slot="remote-device" className="flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3">
        <CollapsibleTrigger disabled={!device.powers} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-control text-start focus-visible:focus-ring disabled:cursor-default">
          <RowText title={device.name} line={`${device.os} ${device.model} · Last connected ${ago(device.seen ?? device.paired, Date.now())}`} />
          {device.powers && <ChevronRight aria-hidden className={cx("size-icon-sm shrink-0 text-quiet-foreground transition-transform", open && "rotate-90")} />}
        </CollapsibleTrigger>
        <Button variant="soft" size="sm" onClick={revoke}>
          Revoke access
        </Button>
      </div>
      {device.powers && (
        <CollapsibleContent className="flex flex-col">
          {open && <Powers device={device} powers={device.powers} load={load} />}
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

function Powers({ device, powers, load }: { device: Device; powers: Record<Power, boolean>; load: () => Promise<unknown> }) {
  const [wanted, setWanted] = useState<Partial<Record<Power, boolean>>>({});
  const [log, setLog] = useState<{ entries?: Entry[]; error?: string }>({});
  const save = useSave();
  // Read again each second while open, as the page reads its status.
  useEffect(() => {
    const read = () =>
      run(["remote", "log", device.id]).then(
        (reply) => setLog({ entries: reply.entries as Entry[] }),
        (cause: unknown) => setLog((last) => ({ ...last, error: errorText(cause) })),
      );
    void read();
    const timer = window.setInterval(() => void read(), 1000);
    return () => clearInterval(timer);
  }, [device.id]);
  const turn = (power: Power, next: boolean) => {
    setWanted((last) => ({ ...last, [power]: next }));
    save.run(() =>
      run(["remote", "device", device.id, "power", power, next ? "on" : "off"])
        .then(load)
        .finally(() => setWanted(({ [power]: _, ...rest }) => rest)),
    );
  };
  return (
    <div className="flex flex-col pb-2">
      <ErrorLine error={save.error} />
      {POWERS.map(({ power, label, description }) => (
        <SettingsRow key={power} label={label} description={description} className="ps-8">
          <Switch aria-label={`${label} from ${device.name}`} checked={wanted[power] ?? powers[power]} disabled={power in wanted} onCheckedChange={(next) => turn(power, next)} />
        </SettingsRow>
      ))}
      <div data-slot="remote-activity" className="flex flex-col gap-1.5 px-4 pt-3 ps-8">
        <div className="text-label font-medium">Activity</div>
        <ErrorLine error={log.error} />
        {log.entries?.length === 0 && <p className="text-xs text-quiet-foreground">Nothing yet. Each use of a power from this device shows here.</p>}
        {log.entries?.map((entry, index) => (
          <div key={`${entry.at}-${index}`} className="flex min-w-0 items-baseline gap-3 text-xs">
            <span className="shrink-0 text-quiet-foreground tabular-nums">
              {new Date(entry.at).toLocaleDateString([], { month: "short", day: "numeric" })} {clock(entry.at)}
            </span>
            <span className="shrink-0 text-quiet-foreground">{LABEL[entry.power] ?? "File"}</span>
            {/* Whole and unshortened, as the phone showed it before Face ID. */}
            <code className="min-w-0 font-mono break-all whitespace-pre-wrap">{entry.argv.map((arg) => (/^[\w@%+=:,./!-]+$/.test(arg) ? arg : JSON.stringify(arg))).join(" ")}</code>
          </div>
        ))}
      </div>
    </div>
  );
}
