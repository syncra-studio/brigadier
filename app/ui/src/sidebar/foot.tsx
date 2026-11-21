import { useState } from "react";

import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Segmented } from "../components/segmented";
import { StateDot } from "../components/state-dot";
import { spacingPx } from "../components/tooltip";
import { useDaemon } from "../daemon";
import { setSetting, useSettings } from "../settings/api";
import { KEEP_AWAKE } from "../settings/general";
import { useRoutingDot } from "../settings/routing";
import { openSettings } from "../settings/shell";
import { BarChart, ChevronRight, FeedbackGlyph, Lightbulb, Settings } from "../icons";
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

/** Where a foot menu opens: beside the strip [D56]. */
export const footPlacement = { side: "right", align: "end", sideOffset: () => spacingPx() * 3 } as const;

/**
 * Keeping the computer awake: a light bulb, lit with a dot while it is; on click, how it stands and when to stay awake.
 * With the lid closed too stays away, as the old app's did where it wasn't supported: nothing here can do it yet.
 */
function KeepAwakeMenu() {
  const { rows } = useDaemon();
  // The same value as Settings › General's row [D2016].
  const mode = useSettings().value?.awake;
  const [error, setError] = useState<string | null>(null);
  const option = KEEP_AWAKE.find((each) => each.value === mode);
  const on = mode === "always" || (mode !== "off" && Boolean(rows?.some((row) => row.works)));
  const text = on ? "Awake now" : mode === "off" ? "The computer sleeps as it normally would" : "No agent is working";
  return (
    <Popover>
      <PopoverTrigger
        render={<TooltipIconButton look="foot" side="right" tooltip={`Keep awake: ${option?.label ?? ""} · ${text}`} dot={on ? "bg-foreground" : undefined} />}
      >
        <Lightbulb className={cx(on && "text-foreground")} />
      </PopoverTrigger>
      <PopoverContent {...footPlacement} padded={false} className="flex w-80 flex-col gap-3 p-3">
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
          <ErrorLine error={error} />
        </div>
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
            look="foot"
            side="right"
            tooltip={top?.limit ? `Usage · ${top.label} ${used}% used` : "Usage"}
            dot={alert === "destructive" ? "bg-destructive" : alert === "warning" ? "bg-warning" : undefined}
          />
        }
      >
        <BarChart className={alert === "destructive" ? "text-destructive" : alert === "warning" ? "text-warning" : undefined} />
      </PopoverTrigger>
      <PopoverContent {...footPlacement} className="w-90">
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
 * The strip's foot, today's strip order top to bottom: updates (only while there are some), Usage, Keep awake, Feedback,
 * Settings, lit while `settings` shows [D56 D57 D18 D19]; smaller and closer than the strip's top [D190], under a rule
 * while the top reaches it [D191].
 */
export function StripFoot({ settings = false }: { settings?: boolean }) {
  // An offer on a job is open [D386].
  const offered = useRoutingDot();
  return (
    <div data-slot="sidebar-foot" className="flex flex-col items-center gap-0.5">
      <span aria-hidden className="strip-rule strip-foot-rule mt-2 mb-1.5" />
      <UpdatesRow />
      <UsageMenu />
      <KeepAwakeMenu />
      {/* Feedback sits in the foot [new-design]. */}
      <TooltipIconButton look="foot" side="right" tooltip="Send Feedback" onClick={() => openFeedback()}>
        <FeedbackGlyph />
      </TooltipIconButton>
      <TooltipIconButton look="foot" side="right" tooltip="Settings" shortcut={keysOf("settings")[0]} pressed={settings} dot={offered ? "bg-link" : undefined} onClick={() => openSettings("general")}>
        <Settings />
      </TooltipIconButton>
    </div>
  );
}
