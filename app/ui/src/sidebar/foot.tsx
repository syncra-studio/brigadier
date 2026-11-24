import { createContext, useContext, useId, useState } from "react";

import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Segmented } from "../components/segmented";
import { StateDot } from "../components/state-dot";
import { Switch } from "../components/switch";
import { spacingPx } from "../components/tooltip";
import { useDaemon } from "../daemon";
import { lidHint, loadLid, setLid, setSetting, useLid, useSettings } from "../settings/api";
import { KEEP_AWAKE } from "../settings/general";
import { useRoutingDot } from "../settings/routing";
import { openSettings } from "../settings/shell";
import { BarChart, ChevronRight, Lightbulb, Settings, ThumbMixed } from "../icons";
import { openFeedback } from "../feedback/dialog";
import { keysOf } from "../shortcuts";
import { UpdatesRow } from "./updates";
import { type Limit, type SwitchAgent, loadAccounts, useAccounts } from "../accounts/api";
import { agentHref } from "../accounts/providers";
import { Share, countdown, tightest } from "../accounts/usage";
import { Button } from "../components/button";
import { ProviderMark } from "../components/composer/model-picker";
import { stateOf } from "../onboarding/agents";
import { type Agent, errorText, useAgents } from "../onboarding/api";

// Whether the foot lies as the expanded sidebar's row, or stands in the strip [D226].
const FootRow = createContext(false);
/** Where a foot menu and its tooltips open: beside the strip [D56], or above the expanded sidebar's row. */
export function useFootPlacement() {
  const row = useContext(FootRow);
  return { row, side: row ? "top" : "right", align: row ? "start" : "end", sideOffset: () => spacingPx() * (row ? 2 : 3) } as const;
}

/**
 * Keeping the computer awake: a light bulb, lit with a dot while it is; on click, how it stands, when to stay awake, and
 * with the lid closed too, as the old app's [D333].
 */
function KeepAwakeMenu() {
  const { rows } = useDaemon();
  // The same values as Settings › General's rows [D2016].
  const settings = useSettings().value;
  const mode = settings?.awake;
  const lid = useLid();
  const lidId = useId();
  const [error, setError] = useState<string | null>(null);
  const option = KEEP_AWAKE.find((each) => each.value === mode);
  const { row, ...placement } = useFootPlacement();
  const on = mode === "always" || (mode !== "off" && Boolean(rows?.some((row) => row.works)));
  const text = on ? `Awake now${settings?.awake_lid && lid.state === "on" ? ", even with the lid closed" : ""}` : mode === "off" ? "The computer sleeps as it normally would" : "No agent is working";
  return (
    <Popover onOpenChange={(open) => open && loadLid()}>
      <PopoverTrigger
        render={<TooltipIconButton look="rail" side={placement.side} tooltip={`Keep awake: ${option?.label ?? ""} · ${text}`} dot={on ? "bg-foreground" : undefined} />}
      >
        <Lightbulb className={cx(on && "text-foreground")} />
      </PopoverTrigger>
      <PopoverContent {...placement} padded={false} className="flex w-80 flex-col gap-3 p-3">
        <div className="flex items-start gap-2.5">
          <Lightbulb aria-hidden className={cx("mt-0.5 size-icon-md shrink-0", on ? "text-foreground" : "text-muted-foreground")} />
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className="text-sm font-medium">Keep awake</span>
            <span className={cx("flex items-center gap-1.5 text-xs", on ? "text-foreground" : "text-muted-foreground")}>
              <StateDot {...(on ? { color: "bg-foreground" } : { tone: "off" as const })} />
              {text}
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Segmented
            fill
            label="When to keep the computer awake"
            value={mode ?? "work"}
            options={KEEP_AWAKE}
            disabled={!mode}
            onChange={(value) => {
              setError(null);
              setSetting("awake", value).catch((cause: unknown) => setError(errorText(cause)));
            }}
          />
          <p className="text-xs text-muted-foreground">{option?.hint}</p>
        </div>
        {settings && (
          <div className="flex items-start gap-3 border-t border-divider pt-3">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span id={`${lidId}-label`} className="text-sm">
                With the lid closed too
              </span>
              <span id={`${lidId}-hint`} className="min-h-8 text-xs text-muted-foreground">
                {lidHint(settings, lid)}
              </span>
            </span>
            <Switch
              className="mt-0.5"
              aria-labelledby={`${lidId}-label`}
              aria-describedby={`${lidId}-hint`}
              checked={settings.awake_lid}
              disabled={lid.settingUp}
              onCheckedChange={(next) => {
                setError(null);
                setLid(next).catch((cause: unknown) => setError(errorText(cause)));
              }}
            />
          </div>
        )}
        <ErrorLine error={error} />
      </PopoverContent>
    </Popover>
  );
}

/** One agent in Usage: its account in use's tightest limit, or none while it needs signing in. */
type UsageEntry = { name: string; label: string; mark: string | null; limit: Limit | null };

/** The agents on and set up that report usage or need signing in: those needing the user first, then the most used. */
function usageEntries(accounts: readonly SwitchAgent[], agents: readonly Agent[]): UsageEntry[] {
  const entries = accounts.flatMap((each): UsageEntry[] => {
    const agent = agents.find((card) => card.name === each.name);
    if (!each.installed || agent?.enabled === false) return [];
    const base = { name: each.name, label: each.label, mark: agent?.mark ?? null };
    const inUse = each.accounts?.list.find((account) => account.id === each.accounts?.use);
    if (inUse?.check.signed_in === false || stateOf(agent) === "signIn") return [{ ...base, limit: null }];
    const limit = inUse?.check.signed_in ? tightest(inUse.check.usage ?? []) : null;
    return limit ? [{ ...base, limit }] : [];
  });
  return entries.toSorted((a, b) => (b.limit?.used ?? Infinity) - (a.limit?.used ?? Infinity));
}

/**
 * Usage, the old app's [D41]: one row per agent, the tightest limit of its account in use (the one new work starts on), most
 * used first; its icon tinted with a dot from 80% used. The accounts Settings › Providers reads, read again as it opens. A
 * row opens its agent's page; one that needs signing in says so with Sign in.
 */
function UsageMenu() {
  const [open, setOpen] = useState(false);
  const accounts = useAccounts().agents;
  const agents = useAgents().list;
  const entries = usageEntries(accounts ?? [], agents ?? []);
  const top = entries.find((entry) => entry.limit);
  const used = top?.limit?.used ?? 0;
  const alert = used >= 90 ? "destructive" : used >= 80 ? "warning" : null;
  const now = Date.now();
  const { row, ...placement } = useFootPlacement();
  const go = (name: string) => {
    setOpen(false);
    window.location.hash = agentHref(name);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void loadAccounts();
      }}
    >
      <PopoverTrigger
        render={
          <TooltipIconButton
            look="rail"
            side={placement.side}
            tooltip={top?.limit ? `Usage · ${top.label} ${used}% used` : "Usage"}
            dot={alert === "destructive" ? "bg-destructive" : alert === "warning" ? "bg-warning" : undefined}
          />
        }
      >
        <BarChart className={alert === "destructive" ? "text-destructive" : alert === "warning" ? "text-warning" : undefined} />
      </PopoverTrigger>
      <PopoverContent {...placement} className="w-90">
        <div className="flex items-center justify-between px-2 py-1.5">
          <span className="font-mono text-2xs font-medium tracking-wide text-muted-foreground uppercase">Usage</span>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              openSettings("providers");
            }}
            className="flex cursor-pointer items-center gap-1 text-xs font-medium text-link hover:underline"
          >
            Providers
            <ChevronRight className="size-icon-xs" />
          </button>
        </div>
        {entries.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-muted-foreground">No agent has reported usage yet.</p>
        ) : (
          entries.map(({ name, label, mark, limit }) =>
            limit ? (
              <button key={name} type="button" onClick={() => go(name)} className={cx(USAGE_ROW, "cursor-pointer text-start outline-none hover:bg-fill focus-visible:focus-ring")}>
                <ProviderMark mark={mark} className="size-icon-md" />
                <span className="truncate">{label}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {[limit.used >= 100 ? "At limit" : limit.name, limit.resets !== null && `resets in ${countdown(limit.resets, now)}`].filter(Boolean).join(" · ")}
                </span>
                <Share limit={limit} />
              </button>
            ) : (
              <div key={name} className={USAGE_ROW}>
                <ProviderMark mark={mark} className="size-icon-md" />
                <span className="truncate">{label}</span>
                <span className="flex min-w-0 flex-1 items-center gap-1.5">
                  <StateDot tone="needs" />
                  <span className="truncate text-xs text-warning">Not signed in</span>
                </span>
                <Button variant="outline" size="xs" onClick={() => go(name)}>
                  Sign in
                </Button>
              </div>
            ),
          )
        )}
      </PopoverContent>
    </Popover>
  );
}

const USAGE_ROW = "flex h-control-sm w-full items-center gap-2 rounded-menu-item px-2 text-sm";

/**
 * The foot, in the strip top to bottom: updates (only while there are some), Usage, Keep awake, Feedback, Settings, lit
 * while `settings` shows [D56 D57 D18 D19]; the top's size, closer together [D190 D204], under a rule while the top
 * reaches it [D191]. As the expanded sidebar's `row` the same reversed, Settings first, as the old app's [D226].
 */
export function StripFoot({ settings = false, row = false }: { settings?: boolean; row?: boolean }) {
  // An offer on a job is open [D386].
  const offered = useRoutingDot();
  const side = row ? "top" : "right";
  const items = [
    <UpdatesRow key="updates" />,
    <UsageMenu key="usage" />,
    <KeepAwakeMenu key="awake" />,
    // Feedback sits in the foot [new-design].
    <TooltipIconButton key="feedback" look="rail" side={side} tooltip="Send Feedback" onClick={() => openFeedback()}>
      <ThumbMixed />
    </TooltipIconButton>,
    <TooltipIconButton key="settings" look="rail" side={side} tooltip="Settings" shortcut={keysOf("settings")[0]} pressed={settings} dot={offered ? "bg-link" : undefined} onClick={() => openSettings("general")}>
      <Settings />
    </TooltipIconButton>,
  ];
  return (
    <FootRow.Provider value={row}>
      <div data-slot="sidebar-foot" className={row ? "flex shrink-0 items-center gap-0.5 px-2 pt-1 pb-2" : "flex flex-col items-center gap-0.5"}>
        {!row && <span aria-hidden className="strip-rule strip-foot-rule mt-2 mb-1.5" />}
        {row ? items.toReversed() : items}
      </div>
    </FootRow.Provider>
  );
}
