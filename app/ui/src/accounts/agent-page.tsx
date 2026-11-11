import { cx } from "../components/cx";
import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { StateDot } from "../components/state-dot";
import { Switch } from "../components/switch";
import { stateOf, type useAgentSetup } from "../onboarding/agents";
import { type Agent, checkOne } from "../onboarding/api";
import { SettingsPage, SettingsSection } from "../settings/parts";
import { AccountRows } from "./account-rows";
import { type Account, type SwitchAgent, loadAccounts } from "./api";
import { AgentMark, CheckAgainButton, ConnectStatus, OVERVIEW_ROWS, ROW_LINE, ROW_TITLE, standing, versionText } from "./parts";

/**
 * An agent's page under Providers, the old app's [D2053]: Providers to go back, its mark, name and how it stands,
 * Enabled and Check again; then where its CLI is installed (its version, Install or Sign in when it needs one,
 * where it runs from), its accounts, and its models.
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
  const { tone, line } = standing(agent, accounts);
  const key = `check:${agent.name}`;
  return (
    <SettingsPage
      back={{ label: "Providers", href: "#settings/providers" }}
      mark={<AgentMark agent={agent} size="lg" idle={state === "install"} />}
      title={agent.label}
      description={
        <span className="flex flex-col gap-1">
          <span className="flex min-w-0 items-center gap-1.75">
            <StateDot tone={tone} />
            <span className={cx("truncate", tone === "needs" && "text-warning")}>{line}</span>
          </span>
          <ErrorLine error={failed[key]} />
        </span>
      }
      actions={
        <>
          <span className="flex items-center gap-2.5 text-label text-quiet-foreground">
            Enabled
            {/* Drawn only: turning an agent off waits for Rust [D388]. */}
            <Switch checked disabled aria-label={`Use ${agent.label}`} />
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
          <Installation agent={agent} online={online} setup={setup} />
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
            <AccountRows agent={agent} accounts={accounts} online={online} onRemove={(account) => accounts && onRemove(accounts, account)} />
          </SettingsCard>
          <ErrorLine error={failed[`${agent.name}:remove`]} className="px-1" />
        </SettingsSection>
        <Models agent={agent} />
      </div>
    </SettingsPage>
  );
}

/** The Installation card: the CLI's version and its one action, then where it runs from. */
function Installation({ agent, online, setup }: { agent: Agent; online: boolean; setup: ReturnType<typeof useAgentSetup> }) {
  const state = stateOf(agent);
  const busy = !online || setup.starting === agent.name || Boolean(agent.setup?.running);
  const version = state === "checking" ? "Checking…" : state === "install" ? "Not installed" : (versionText(agent) ?? "Version unknown");
  const action =
    state === "checking" ? null : state === "install" ? (
      <Button variant="soft" size="sm" disabled={busy || !agent.install} onClick={() => void setup.begin(agent, "install")}>
        Install
      </Button>
    ) : state === "signIn" && agent.sign_in ? (
      <Button variant="soft" size="sm" disabled={busy} onClick={() => void setup.begin(agent, "sign-in")}>
        Sign in
      </Button>
    ) : (
      // Drawn only: updating an agent's CLI waits for Rust [D388].
      <Button variant="soft" size="sm" disabled>
        Update
      </Button>
    );
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
        <ConnectStatus
          agent={agent}
          failed={setup.failed[agent.name]}
          onRetry={() => void setup.begin(agent, agent.setup?.action ?? (state === "install" ? "install" : "sign-in"))}
          onCancel={() => void setup.close(agent.name)}
          className="pt-3"
        />
      </div>
      {state !== "install" && (
        <div className="flex items-center gap-6 px-4 py-3">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className={ROW_TITLE}>Location</span>
            <span className={cx(ROW_LINE, "truncate font-mono")} title={agent.path ?? undefined}>
              {agent.path ?? "Checking…"}
            </span>
          </div>
          {/* Drawn only: choosing another CLI waits for Rust [D388]. */}
          <Button variant="soft" size="sm" disabled>
            Change
          </Button>
        </div>
      )}
    </SettingsCard>
  );
}

/** The Models section: a row each, with its switch (drawn only: hiding a model waits for Rust [D388]). */
function Models({ agent }: { agent: Agent }) {
  const state = stateOf(agent);
  const models = agent.models ?? [];
  return (
    <SettingsSection title="Models" setting="Models" aside={models.length > 0 ? `${models.length} on` : undefined}>
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
          models.map((model) => (
            <div key={model.id} className="flex items-center gap-6 px-4 py-3">
              <span className={cx(ROW_TITLE, "min-w-0 flex-1 truncate font-mono")}>{model.id}</span>
              <Switch checked disabled aria-label={`Use ${model.id}`} />
            </div>
          ))
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
