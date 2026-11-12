import { type MouseEvent, useEffect, useState } from "react";

import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { RowText, SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Skeleton } from "../components/skeleton";
import { StateDot } from "../components/state-dot";
import { Switch } from "../components/switch";
import { useDaemon } from "../daemon";
import { ChevronRight, Plus } from "../icons";
import { stateOf, useAgentSetup } from "../onboarding/agents";
import { type Agent, checkAll, setEnabled, useAgents } from "../onboarding/api";
import { SettingsPage, SettingsSection } from "../settings/parts";
import { AgentPage } from "./agent-page";
import { type Account, type SwitchAgent, loadAccounts, removeAccount, setAgents, setAuto, useAccounts } from "./api";
import { AgentMark, CheckAgainButton, ConnectStatus, OVERVIEW_ROWS, PlanChip, ROW_TITLE, standing, useFailed } from "./parts";

/** The page's rows, for Settings search. */
export const PROVIDERS_ROWS = {
  switch: OVERVIEW_ROWS.switch,
  agents: { label: "Agents", description: "The coding agents Brigadier runs: how each stands, and its switch" },
  notSetUp: { label: "Not set up", description: `${OVERVIEW_ROWS.notSetUp}, with Set up` },
  addAgent: { label: "Add another agent", description: "Set up another agent Brigadier can run" },
  installation: { label: "Installation", description: "Each agent's CLI: its version, and where it runs from" },
  accounts: { label: "Accounts", description: "Each agent's accounts: who is signed in, Sign in and Remove" },
  switchAccounts: OVERVIEW_ROWS.switchAccounts,
  add: { label: "Add account", description: "Sign in to another account of any agent" },
  models: { label: "Models", description: "Each agent's models" },
} as const;

/** What turning a switch on, or removing an account, asks first [D51]. */
export type Ask = { kind: "auto"; agent: SwitchAgent } | { kind: "agents" } | { kind: "remove"; agent: SwitchAgent; account: Account };

const listNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/** An agent's page's route, under Providers. */
export const agentHref = (name: string) => `#settings/providers/${encodeURIComponent(name)}`;

/**
 * Settings › Providers, the old app's [D2053, D2054]: the agents at a glance (Fallback, Agents, Not set up), and a
 * page for each (its installation, accounts and models) that a row opens and Providers goes back from. `detail`
 * is the open agent's name. Install and sign-in are onboarding's, through Rust [D45]; switching is D51's.
 */
export function ProvidersPage({ detail }: { detail?: string }) {
  const { daemon } = useDaemon();
  const online = Boolean(daemon);
  const { list, checking, error: checkError } = useAgents();
  const accounts = useAccounts();
  const setup = useAgentSetup(list, online);
  const { failed, act } = useFailed();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!online) return;
    void checkAll(true);
    void loadAccounts();
  }, [online]);

  const checkAgain = () => void act("check", () => Promise.all([checkAll(), loadAccounts()]));
  const switchAgentsTo = (on: boolean) => (on ? setAsk({ kind: "agents" }) : void act("agents", () => setAgents(false)));
  const switchAccountsTo = (agent: SwitchAgent, on: boolean) => (on ? setAsk({ kind: "auto", agent }) : void act(`${agent.name}:auto`, () => setAuto(agent.name, false)));

  const confirm = async () => {
    if (!ask) return;
    setBusy(true);
    const key = ask.kind === "remove" ? `${ask.agent.name}:remove` : ask.kind === "auto" ? `${ask.agent.name}:auto` : "agents";
    await act(key, async () => {
      if (ask.kind === "auto") await setAuto(ask.agent.name, true);
      else if (ask.kind === "agents") await setAgents(true);
      else {
        const note = await removeAccount(ask.account.id);
        if (note) throw new Error(note);
      }
    });
    setBusy(false);
    setAsk(null);
  };

  const agent = detail ? list?.find((each) => each.name === detail) : undefined;
  const targets = (list ?? []).filter((each) => each.path).map((each) => each.label);

  return (
    <>
      {detail ? (
        agent ? (
          <AgentPage
            agent={agent}
            accounts={accounts.agents?.find((each) => each.name === agent.name)}
            online={online}
            checking={checking.has(agent.name) || checking.has("*")}
            setup={setup}
            failed={failed}
            act={act}
            onSwitchAccounts={switchAccountsTo}
            onRemove={(owner, account) => setAsk({ kind: "remove", agent: owner, account })}
          />
        ) : (
          <SettingsPage title={list ? "No such agent" : "Checking…"} back={{ label: "Providers", href: "#settings/providers" }}>
            <ErrorLine error={checkError} />
          </SettingsPage>
        )
      ) : (
        <SettingsPage
          title="Providers"
          description="The coding agents Brigadier runs, the accounts you use with them, and which models do what."
          actions={<CheckAgainButton busy={checking.has("*") || accounts.loading} label="Check the agents and accounts again" onClick={checkAgain} />}
        >
          {!online && <p className="text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
          <ErrorLine error={failed.check ?? checkError ?? accounts.error} />
          <Overview list={list} online={online} switchAgents={Boolean(accounts.switchAgents)} failed={failed} act={act} onSwitchAgents={switchAgentsTo} setup={setup} />
        </SettingsPage>
      )}
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(next) => !next && setAsk(null)}
        busy={busy}
        destructive={ask?.kind === "remove"}
        title={
          ask?.kind === "auto"
            ? `Switch ${ask.agent.label} accounts automatically?`
            : ask?.kind === "agents"
              ? "Switch to another agent automatically?"
              : ask?.kind === "remove"
                ? `Remove ${ask.account.name}?`
                : null
        }
        description={
          ask?.kind === "auto"
            ? `Switching ${ask.agent.label} accounts automatically to keep working past a usage limit may breach ${ask.agent.accounts?.vendor}'s terms. You turn it on at your own risk.`
            : ask?.kind === "agents"
              ? `When an agent's accounts are all at their limit, the conversation goes to another vendor's agent${targets.length ? ` (${listNames(targets)})` : ""}, and that agent sees the whole thread, including what it read. You turn it on at your own risk.`
              : ask?.kind === "remove"
                ? `${ask.agent.label} signs it out with its own sign-out, then its folder is deleted. Your history stays.`
                : ""
        }
        confirm={ask?.kind === "remove" ? "Remove" : "Turn on"}
        onConfirm={() => void confirm()}
      />
    </>
  );
}

type Setup = ReturnType<typeof useAgentSetup>;

/** The first page: the fallback switch, the agents set up (a row opens each), then those not set up with Set up. */
function Overview({
  list,
  online,
  switchAgents,
  failed,
  act,
  onSwitchAgents,
  setup,
}: {
  list: Agent[] | undefined;
  online: boolean;
  switchAgents: boolean;
  failed: Record<string, string>;
  act: (key: string, work: () => Promise<unknown>) => Promise<void>;
  onSwitchAgents: (on: boolean) => void;
  setup: Setup;
}) {
  const accounts = useAccounts().agents;
  const installed = (list ?? []).filter((agent) => stateOf(agent) !== "install");
  const missing = (list ?? []).filter((agent) => stateOf(agent) === "install");
  const settingUp = (agent: Agent) => setup.starting === agent.name || Boolean(agent.setup?.running);
  return (
    <div className={cx("flex flex-col gap-10", !online && "opacity-disabled")}>
      <SettingsSection title="Fallback" setting="Fallback">
        <SettingsCard>
          <SettingsRow label={OVERVIEW_ROWS.switch.label} description={OVERVIEW_ROWS.switch.description} error={failed.agents}>
            <Switch checked={switchAgents} disabled={!online} aria-label={OVERVIEW_ROWS.switch.label} onCheckedChange={onSwitchAgents} />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Agents" setting="Agents">
        <SettingsCard>
          {list === undefined ? (
            [0, 1, 2].map((n) => (
              <div key={n} className="flex items-center gap-3.5 px-4 py-3">
                <Skeleton className="size-8.5 rounded-nav" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))
          ) : installed.length === 0 ? (
            <p className="px-4 py-3 text-sm text-quiet-foreground">No agent is installed yet.</p>
          ) : (
            installed.map((agent) => (
              <AgentRow
                key={agent.name}
                agent={agent}
                accounts={accounts?.find((each) => each.name === agent.name)}
                online={online}
                error={failed[`${agent.name}:enabled`]}
                onEnable={(on) => void act(`${agent.name}:enabled`, () => setEnabled(agent.name, on))}
              />
            ))
          )}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="Not set up" setting="Not set up" aside={OVERVIEW_ROWS.notSetUp}>
        <SettingsCard>
          {missing.map((agent) => (
            <div key={agent.name} className="flex flex-col">
              <div className="flex items-center gap-3.5 px-4 py-3">
                <AgentMark agent={agent} idle />
                <RowText title={agent.label} line="Not installed" />
                <Button size="sm" aria-label={`Set up ${agent.label}`} disabled={!online || !agent.install || settingUp(agent)} onClick={() => void setup.begin(agent, "install")}>
                  Set up
                </Button>
              </div>
              <ConnectStatus
                agent={agent}
                failed={setup.failed[agent.name]}
                onRetry={() => void setup.begin(agent, "install")}
                onCancel={() => void setup.close(agent.name)}
                className="px-4 pb-3"
              />
            </div>
          ))}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              disabled={list === undefined}
              className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-label font-medium text-link hover:underline focus-visible:focus-ring"
            >
              <Plus aria-hidden className="size-icon-sm" />
              Add another agent
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {(list ?? []).map((agent) => {
                const added = installed.includes(agent);
                return (
                  <DropdownMenuItem key={agent.name} disabled={added || !agent.install || settingUp(agent)} onClick={() => void setup.begin(agent, "install")}>
                    <AgentMark agent={agent} idle />
                    <span className="flex-1">{agent.label}</span>
                    {added && <span className="text-xs text-muted-foreground">Added</span>}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </SettingsCard>
      </SettingsSection>
    </div>
  );
}

/** One agent: its mark and name, how it stands, its switch and ›. A press opens its page. */
function AgentRow({
  agent,
  accounts,
  online,
  error,
  onEnable,
}: {
  agent: Agent;
  accounts: SwitchAgent | undefined;
  online: boolean;
  error: string | undefined;
  onEnable: (on: boolean) => void;
}) {
  const { tone, line } = standing(agent, accounts);
  const on = agent.enabled !== false;
  const open = (event: MouseEvent) => {
    // The row's switch toggles the agent; it doesn't open its page.
    if (event.target instanceof Element && event.target.closest('[data-slot="switch"]')) return;
    window.location.hash = agentHref(agent.name);
  };
  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the button over it is the keyboard's and a screen reader's
    <div data-setting={agent.label} onClick={open} className="relative flex cursor-pointer items-center gap-3.5 px-4 py-3 transition-colors hover:bg-fill-subtle">
      {/* What opens the page for the keyboard and a screen reader; the pointer goes through it to the row. */}
      <a href={agentHref(agent.name)} aria-label={`${agent.label}: open its accounts and models`} className="pointer-events-none absolute inset-0 focus-visible:focus-ring" />
      <AgentMark agent={agent} dim={!on} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className={cx(ROW_TITLE, !on && "text-quiet-foreground")}>{agent.label}</span>
          {agent.plan && <PlanChip plan={agent.plan} />}
        </span>
        <span className="flex min-w-0 items-center gap-1.75">
          <StateDot tone={tone} />
          <span className={cx("truncate text-xs", tone === "needs" ? "text-warning" : "text-quiet-foreground")}>{line}</span>
        </span>
        <ErrorLine error={error} />
      </div>
      {/* The old row's busiest-limit slot, empty: reading usage waits for Rust [D388]. */}
      <div className="flex w-45 shrink-0 items-center justify-end" />
      <span aria-hidden className="w-2 shrink-0" />
      <Switch checked={on} disabled={!online} aria-label={`Use ${agent.label}`} onCheckedChange={onEnable} />
      <ChevronRight aria-hidden className="size-icon-md shrink-0 text-muted-foreground" />
    </div>
  );
}
