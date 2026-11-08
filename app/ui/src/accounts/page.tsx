import { type ReactNode, useEffect, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { RowText, SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Skeleton } from "../components/skeleton";
import { Switch } from "../components/switch";
import { useDaemon } from "../daemon";
import { Plus, Spinner } from "../icons";
import { errorText } from "../onboarding/api";
import { TerminalPane } from "../terminal/terminal";
import {
  type Account,
  type SwitchAgent,
  addAccount,
  closeSignIn,
  loadAccounts,
  removeAccount,
  setAgent,
  setAgents,
  signIn,
  signInRun,
  useAccounts,
} from "./api";

/** How often the accounts are checked again while a sign-in terminal is open. */
const RECHECK_MS = 2000;

type Ask = { kind: "auto"; agent: SwitchAgent } | { kind: "agents" } | { kind: "remove"; agent: SwitchAgent; account: Account };

const listNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * Accounts and switching [D51], as the old app's agent pages drew them (D48): each agent's accounts,
 * added through its own sign-in in a real terminal [D45, D47], and the switches. Automatic switching
 * is off until turned on, and turning it on asks first, naming whose terms or which vendors it
 * concerns. Every word about an agent comes from its adapter [D43].
 */
export function AccountsPage() {
  const { daemon } = useDaemon();
  const online = Boolean(daemon);
  const { agents, switchAgents, error, loading } = useAccounts();
  const [ask, setAsk] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<Record<string, string>>({});
  // The sign-in terminal shown, and the agent whose account is being added.
  const [open, setOpen] = useState<{ agent: string; id: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  useEffect(() => {
    if (online) void loadAccounts();
  }, [online]);
  useEffect(() => {
    if (!open || !online) return;
    const timer = window.setInterval(() => void loadAccounts(), RECHECK_MS);
    return () => clearInterval(timer);
  }, [open, online]);
  // A sign-in that ended well closes by itself.
  const signing = open && agents?.find((a) => a.name === open.agent)?.accounts?.list.find((a) => a.id === open.id);
  const endedWell = signing && signing.sign_in && !signing.sign_in.running && signing.sign_in.code === 0;
  useEffect(() => {
    if (endedWell && open) close(open.id);
  }, [endedWell]);

  const fail = (key: string, cause: unknown) => setFailed((all) => ({ ...all, [key]: errorText(cause) }));
  const clear = (key: string) => setFailed(({ [key]: _, ...rest }) => rest);
  const act = async (key: string, work: () => Promise<unknown>) => {
    clear(key);
    try {
      await work();
    } catch (cause) {
      fail(key, cause);
    }
  };
  const close = (id: string) => {
    setOpen((current) => (current?.id === id ? null : current));
    void act(id, () => closeSignIn(id));
  };
  const add = (agent: SwitchAgent) =>
    act(agent.name, async () => {
      setAdding(agent.name);
      try {
        const id = await addAccount(agent.name);
        setOpen({ agent: agent.name, id });
      } finally {
        setAdding(null);
      }
    });
  // The terminal attaches once the sign-in run exists; until then its button shows it starting.
  const reSignIn = (agent: SwitchAgent, account: Account) =>
    act(account.id, async () => {
      setStarting(account.id);
      try {
        await signIn(account.id);
        setOpen({ agent: agent.name, id: account.id });
      } finally {
        setStarting(null);
      }
    });

  const confirm = async () => {
    if (!ask) return;
    setBusy(true);
    const key = ask.kind === "remove" ? ask.account.id : ask.kind === "auto" ? `${ask.agent.name}:auto` : "agents";
    clear(key);
    try {
      if (ask.kind === "auto") await setAgent(ask.agent.name, "auto", true);
      else if (ask.kind === "agents") await setAgents(true);
      else {
        const note = await removeAccount(ask.account.id);
        if (note) fail(ask.agent.name, new Error(note));
      }
    } catch (cause) {
      fail(key, cause);
    } finally {
      setBusy(false);
      setAsk(null);
    }
  };

  const targets = (agents ?? []).filter((a) => a.installed && !a.released).map((a) => a.label);

  return (
    <main className="fixed inset-0 flex flex-col">
      <header className="flex h-titlebar shrink-0 items-center gap-3 text-sm">
        <div className="app-drag h-full w-traffic-lights shrink-0" />
        <a href="#" className="text-muted-foreground hover:text-foreground">
          Sessions
        </a>
        <span className="app-drag flex h-full min-w-0 flex-1 items-center truncate">Accounts</span>
      </header>
      {!online && <p className="text-center text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
      <div className={`min-h-0 flex-1 overflow-y-auto ${online ? "" : "opacity-disabled"}`}>
        <div className="mx-auto flex w-full max-w-reading flex-col gap-6 px-6 py-6">
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold">Accounts and switching</h1>
            <p className="text-sm text-muted-foreground">
              Each account signs in with its agent's own sign-in, in its own folder. Brigadier never sees or shares a login.
            </p>
          </div>
          {agents === undefined && error ? (
            <SettingsCard>
              <SettingsRow label="The accounts couldn't be checked." error={error}>
                <Button size="sm" variant="outline" disabled={!online || loading} onClick={() => void loadAccounts()}>
                  {loading && <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />}
                  Try again
                </Button>
              </SettingsRow>
            </SettingsCard>
          ) : agents === undefined ? (
            <SettingsCard>
              {[0, 1, 2].map((n) => (
                <div key={n} className="flex items-center gap-3 px-4 py-3">
                  <Skeleton className="size-8 rounded-full" />
                  <Skeleton className="h-4 flex-1" />
                </div>
              ))}
            </SettingsCard>
          ) : agents.length === 0 ? (
            <SettingsCard>
              <EmptyState variant="card" title="No agents are available in this build." />
            </SettingsCard>
          ) : (
            <>
              <SettingsCard>
                <SettingsRow
                  label="Switch to another agent automatically"
                  description="When every account of an agent is at its limit, the work carries on with another agent. Off, it waits for you."
                  error={failed.agents}
                >
                  <Switch
                    checked={Boolean(switchAgents)}
                    disabled={!online}
                    aria-label="Switch to another agent automatically"
                    onCheckedChange={(on) => (on ? setAsk({ kind: "agents" }) : void act("agents", () => setAgents(false)))}
                  />
                </SettingsRow>
              </SettingsCard>
              {agents.map((agent) => (
                <AgentSection
                  key={agent.name}
                  agent={agent}
                  online={online}
                  adding={adding === agent.name}
                  starting={starting}
                  failed={failed}
                  onAdd={() => void add(agent)}
                  onSignIn={(account) => void reSignIn(agent, account)}
                  onRemove={(account) => setAsk({ kind: "remove", agent, account })}
                  onAuto={(on) => (on ? setAsk({ kind: "auto", agent }) : void act(`${agent.name}:auto`, () => setAgent(agent.name, "auto", false)))}
                  onRelease={(on) => void act(`${agent.name}:release`, () => setAgent(agent.name, "release", on))}
                >
                  {open?.agent === agent.name && (
                    <div className="flex h-64 overflow-hidden rounded-surface border border-divider">
                      <TerminalPane
                        key={open.id}
                        id={signInRun(agent.name, open.id)}
                        setup={{ title: `${agent.label} · Sign in`, onClose: () => close(open.id) }}
                      />
                    </div>
                  )}
                </AgentSection>
              ))}
            </>
          )}
        </div>
      </div>
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
    </main>
  );
}

function AgentSection({
  agent,
  online,
  adding,
  starting,
  failed,
  onAdd,
  onSignIn,
  onRemove,
  onAuto,
  onRelease,
  children,
}: {
  agent: SwitchAgent;
  online: boolean;
  adding: boolean;
  starting: string | null;
  failed: Record<string, string>;
  onAdd: () => void;
  onSignIn: (account: Account) => void;
  onRemove: (account: Account) => void;
  onAuto: (on: boolean) => void;
  onRelease: (on: boolean) => void;
  children?: ReactNode;
}) {
  const accounts = agent.accounts;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex items-center gap-2 px-1 text-label font-medium">
        {agent.label}
        {!agent.installed && <Badge variant="secondary">Not installed</Badge>}
      </h2>
      <SettingsCard>
        {accounts?.list.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            online={online}
            error={failed[account.id]}
            starting={starting === account.id}
            onSignIn={() => onSignIn(account)}
            onRemove={() => onRemove(account)}
          />
        ))}
        {accounts && (
          <div className="flex flex-col">
            <Button
              size={null}
              variant="link-blue"
              className="flex gap-2 self-start px-4 py-3 text-label font-medium"
              disabled={!online || !agent.installed || adding}
              onClick={onAdd}
            >
              {adding ? <Spinner className="size-icon-sm animate-spin motion-reduce:animate-none" /> : <Plus aria-hidden className="size-icon-sm" />}
              {accounts.list.some((a) => a.check.signed_in === true) ? `Add another ${agent.label} account` : `Add a ${agent.label} account`}
            </Button>
            <ErrorLine error={failed[agent.name]} className="px-4 pb-3" />
          </div>
        )}
        {accounts && (
          <SettingsRow
            label="Switch accounts automatically"
            description={`At a usage limit, work moves on to the next signed-in ${agent.label} account with room. Off, you pick each time.`}
            error={failed[`${agent.name}:auto`]}
          >
            <Switch checked={accounts.auto} disabled={!online || agent.released} aria-label={`Switch ${agent.label} accounts automatically`} onCheckedChange={onAuto} />
          </SettingsRow>
        )}
        <SettingsRow
          label={`Release ${agent.label}`}
          description={`Takes ${agent.label} out of automatic switching: no work moves away from it or to it by itself.`}
          error={failed[`${agent.name}:release`]}
        >
          <Switch checked={agent.released} disabled={!online} aria-label={`Release ${agent.label}`} onCheckedChange={onRelease} />
        </SettingsRow>
      </SettingsCard>
      {children}
    </section>
  );
}

function AccountRow({
  account,
  online,
  error,
  starting,
  onSignIn,
  onRemove,
}: {
  account: Account;
  online: boolean;
  error?: string;
  starting: boolean;
  onSignIn: () => void;
  onRemove: () => void;
}) {
  const c = account.check;
  const own = account.id === "";
  const signedIn = c.signed_in === true;
  const line = c.error
    ? c.error
    : !c.installed
      ? "Not installed"
      : account.sign_in?.running
        ? "Signing in…"
        : signedIn && c.kept_apart === false
          ? `${c.how} · this sign-in kind isn't kept apart, so it's never used`
          : signedIn
            ? c.how || "Signed in"
            : "Not signed in";
  return (
    <div className="flex flex-col gap-1 px-4 py-3">
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-fill text-label font-medium">
          {(own ? "This computer" : account.name).slice(0, 1).toUpperCase()}
        </span>
        <RowText title={own ? "This computer's login" : account.name} line={line} truncate />
        {account.limited_at && Date.now() - account.limited_at < 5 * 3600 * 1000 && <Badge variant="warning">Hit its limit</Badge>}
        {!own && !signedIn && !account.sign_in?.running && (
          <Button size="sm" variant="soft" disabled={!online || !c.installed || starting} onClick={onSignIn}>
            {starting && <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />}
            Sign in
          </Button>
        )}
        {!own && (
          <Button size="sm" variant="ghost" disabled={!online || Boolean(account.sign_in?.running)} onClick={onRemove}>
            Remove
          </Button>
        )}
      </div>
      <ErrorLine error={error} />
    </div>
  );
}
