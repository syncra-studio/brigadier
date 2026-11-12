import { useEffect, useRef, useState } from "react";

import { cx } from "../components/cx";
import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { ErrorLine } from "../components/error-line";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { showToast } from "../components/toast";
import { StateDot } from "../components/state-dot";
import { Switch } from "../components/switch";
import { ChevronRight } from "../icons";
import { stateOf, type useAgentSetup } from "../onboarding/agents";
import { type Agent, changeAgentPath, checkOne, setEnabled, setModelOn } from "../onboarding/api";
import { SettingsPage, SettingsSection } from "../settings/parts";
import { AccountRows } from "./account-rows";
import { type Account, type SwitchAgent, loadAccounts } from "./api";
import { AgentMark, CheckAgainButton, OVERVIEW_ROWS, PlanChip, ROW_LINE, ROW_TITLE, SetupLine, standing, versionText } from "./parts";

/**
 * An agent's page under Providers, the old app's [D2053]: Providers to go back, its mark, name and how it stands,
 * Enabled and Check again; then where its CLI is installed (its version, Install when it needs it, where it runs
 * from), its accounts, and, while it's on, its models.
 */
export function AgentPage({
  agent,
  accounts,
  online,
  checking,
  setup,
  failed,
  act,
  onSwitchAccounts,
  onRemove,
}: {
  agent: Agent;
  accounts: SwitchAgent | undefined;
  online: boolean;
  checking: boolean;
  setup: ReturnType<typeof useAgentSetup>;
  failed: Record<string, string>;
  act: (key: string, work: () => Promise<unknown>) => Promise<void>;
  onSwitchAccounts: (agent: SwitchAgent, on: boolean) => void;
  onRemove: (agent: SwitchAgent, account: Account) => void;
}) {
  const state = stateOf(agent);
  const { tone, line } = standing(agent, accounts, true);
  const on = agent.enabled !== false;
  const key = `check:${agent.name}`;
  const enabledKey = `${agent.name}:enabled`;
  return (
    <SettingsPage
      back={{ label: "Providers", href: "#settings/providers" }}
      mark={<AgentMark agent={agent} size="lg" idle={state === "install"} dim={!on} />}
      title={
        <span className="flex items-center gap-2.5">
          {agent.label}
          {agent.plan && <PlanChip plan={agent.plan} large />}
        </span>
      }
      description={
        <span className="flex flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.75">
            <StateDot tone={tone} />
            <span className={cx("truncate", tone === "needs" && "text-warning")}>{line}</span>
          </span>
          <ErrorLine error={failed[enabledKey] ?? failed[key]} />
        </span>
      }
      actions={
        <>
          <span className="flex items-center gap-2.5 text-label text-quiet-foreground">
            Enabled
            <Switch checked={on} disabled={!online} aria-label={`Use ${agent.label}`} onCheckedChange={(next) => void act(enabledKey, () => setEnabled(agent.name, next))} />
          </span>
          <CheckAgainButton
            busy={checking}
            label={`Check ${agent.label} and its accounts again`}
            onClick={() => void act(key, () => Promise.all([checkOne(agent.name), loadAccounts()]))}
          />
        </>
      }
    >
      <div className={cx("flex flex-col gap-10", !online && "opacity-disabled")}>
        <SettingsSection title="Installation" setting="Installation">
          <Installation agent={agent} oneHome={accounts !== undefined && !accounts.accounts} online={online} setup={setup} failed={failed} act={act} />
        </SettingsSection>
        <SettingsSection title="Accounts" setting="Accounts">
          <SettingsCard>
            {accounts?.accounts && (
              <SettingsRow label={OVERVIEW_ROWS.switchAccounts.label} description={OVERVIEW_ROWS.switchAccounts.description} error={failed[`${agent.name}:auto`]}>
                <Switch
                  checked={accounts.accounts.auto}
                  disabled={!online}
                  aria-label={`Switch ${agent.label} accounts automatically`}
                  onCheckedChange={(on) => onSwitchAccounts(accounts, on)}
                />
              </SettingsRow>
            )}
            <AccountRows agent={agent} accounts={accounts} online={online} setup={setup} onRemove={(account) => accounts && onRemove(accounts, account)} />
          </SettingsCard>
          <ErrorLine error={failed[`${agent.name}:remove`]} className="px-1" />
        </SettingsSection>
        {on && <Models agent={agent} online={online} failed={failed} act={act} />}
      </div>
    </SettingsPage>
  );
}

type Act = (key: string, work: () => Promise<unknown>) => Promise<void>;

/**
 * The Installation card: the CLI's version and its one action (Install; Sign in while it isn't signed in; else Update:
 * its own updater as a setup run, checked again once it ends) with its line under it [D27], then where it runs from,
 * with Change to run another CLI file [D2082]. An agent that keeps its logins in one home shows its sign-in's line in
 * Accounts, where adding another login runs it too.
 */
function Installation({
  agent,
  oneHome,
  online,
  setup,
  failed,
  act,
}: {
  agent: Agent;
  oneHome: boolean;
  online: boolean;
  setup: ReturnType<typeof useAgentSetup>;
  failed: Record<string, string>;
  act: Act;
}) {
  const [choosing, setChoosing] = useState(false);
  const state = stateOf(agent);
  // An update that went through says so once, in its CLI's last words ("already up to date"), and goes by itself.
  const updating = useRef(false);
  useEffect(() => {
    const run = agent.setup;
    if (run?.action !== "update") return;
    if (run.running) updating.current = true;
    else if (updating.current && run.code !== null) {
      updating.current = false;
      if (run.code === 0) showToast(run.reason ?? `${agent.label} updated`);
    }
  }, [agent.setup, agent.label]);
  // Not installed, its install running or not: the old card's Install stays, waiting [D2078].
  const missing = state === "install" || (state === "running" && !agent.path);
  const busy = !online || setup.starting === agent.name || Boolean(agent.setup?.running);
  const version = state === "checking" ? "Checking…" : missing ? "Not installed" : (versionText(agent) ?? "Version unknown");
  const action =
    state === "checking" ? null : missing ? (
      <Button variant="soft" size="sm" disabled={busy || !agent.install} onClick={() => void setup.begin(agent, "install")}>
        Install
      </Button>
    ) : (state === "signIn" || agent.setup?.action === "sign-in") && agent.sign_in ? (
      <Button variant="soft" size="sm" disabled={busy} onClick={() => void setup.begin(agent, "sign-in")}>
        {agent.sign_in}
      </Button>
    ) : (
      <Button variant="soft" size="sm" disabled={busy || !agent.update} title={agent.update ?? undefined} onClick={() => void setup.begin(agent, "update")}>
        {agent.setup?.running && agent.setup.action === "update" ? "Updating…" : "Update"}
      </Button>
    );
  const pathKey = `${agent.name}:path`;
  const change = async () => {
    setChoosing(true);
    await act(pathKey, () => changeAgentPath(agent));
    setChoosing(false);
  };
  return (
    <SettingsCard>
      <div className="flex flex-col px-4 py-3">
        <div className="flex items-center gap-6">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className={ROW_TITLE}>{agent.label}</span>
            <span className={ROW_LINE}>{version}</span>
          </div>
          {action}
        </div>
        {!(oneHome && agent.setup?.action === "sign-in") && (
          <SetupLine
            agent={agent}
            failed={setup.failed[agent.name]}
            onRetry={() => void setup.begin(agent, agent.setup?.action ?? (missing ? "install" : "sign-in"))}
            onCancel={() => void setup.close(agent.name)}
            className="pt-3"
          />
        )}
      </div>
      {!missing && (
        <div className="flex items-center gap-6 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className={ROW_TITLE}>Location</span>
            <span className={cx(ROW_LINE, "truncate font-mono")} title={agent.path ?? undefined}>
              {agent.path ?? "Checking…"}
            </span>
            <ErrorLine error={failed[pathKey]} />
          </div>
          <Button variant="soft" size="sm" disabled={!online || choosing} onClick={() => void change()}>
            Change
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}

/**
 * The Models section: a row each, with its switch; one off is left out of new sessions' pickers [D2082]. Older models
 * fold under Older models, as the old app's.
 */
function Models({ agent, online, failed, act }: { agent: Agent; online: boolean; failed: Record<string, string>; act: Act }) {
  const state = stateOf(agent);
  const models = agent.models ?? [];
  const current = models.filter((model) => !model.legacy);
  const older = models.filter((model) => model.legacy);
  const onCount = current.filter((model) => !agent.models_off.includes(model.id)).length;
  const aside = models.length > 0 ? [`${onCount} on`, older.length > 0 && `${older.length} older`].filter(Boolean).join(" · ") : undefined;
  const row = (model: (typeof models)[number]) => {
    const key = `${agent.name}:model:${model.id}`;
    return (
      <div key={model.id} className="flex items-center gap-6 px-4 py-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.25">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className={ROW_TITLE}>{model.name ?? model.id}</span>
            {model.name && model.name !== model.id && <span className="font-mono text-xs whitespace-pre text-quiet-foreground">{model.id}</span>}
          </span>
          <ErrorLine error={failed[key]} />
        </div>
        <Switch
          checked={!agent.models_off.includes(model.id)}
          disabled={!online}
          aria-label={`Use ${model.name ?? model.id}`}
          onCheckedChange={(next) => void act(key, () => setModelOn(agent.name, model.id, next))}
        />
      </div>
    );
  };
  return (
    <SettingsSection title="Models" setting="Models" aside={aside}>
      <SettingsCard>
        {models.length === 0 ? (
          <p className="px-4 py-3 text-sm text-quiet-foreground">
            {state === "checking"
              ? "Checking…"
              : state === "install"
                ? `Install ${agent.label} to see its models.`
                : state === "signIn"
                  ? `Sign in to ${agent.label} to see its models.`
                  : "No model available."}
          </p>
        ) : (
          current.map(row)
        )}
        {older.length > 0 && (
          <Collapsible className="settings-rows flex flex-col">
            <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-2.5 px-4 py-3 text-label text-quiet-foreground outline-none hover:text-foreground focus-visible:focus-ring">
              <ChevronRight aria-hidden className="size-icon-sm transition-transform group-data-panel-open:rotate-90 motion-reduce:transition-none" />
              Older models · {older.length}
            </CollapsibleTrigger>
            <CollapsibleContent className="settings-rows flex flex-col">{older.map(row)}</CollapsibleContent>
          </Collapsible>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
