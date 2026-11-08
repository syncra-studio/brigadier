import { useEffect, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { useDaemon } from "../daemon";
import { Check, Spinner } from "../icons";
import { TerminalPane } from "../terminal/terminal";
import { type Agent, checkAll, checkOne, errorText, run, useAgents } from "./api";
import { Terminal } from "./icons";
import { MAC, PILL_BUTTON, RAISED_BUTTON, StepFooter, StepHeader } from "./parts";

/** How often an agent is checked again while its install or sign-in terminal is open. */
const RECHECK_MS = 2000;
const HERE = MAC ? "this Mac" : "this computer";

type State = "checking" | "running" | "error" | "install" | "signIn" | "noModel" | "ready";

/** Installed, signed in and has a usable model are separate: only the last makes it ready [D45]. */
function stateOf(agent: Agent | undefined): State {
  if (!agent || agent.path === undefined) return "checking";
  if (agent.setup?.running) return "running";
  if (agent.error) return "error";
  if (!agent.path) return "install";
  if (agent.models?.length) return "ready";
  return agent.signed_in ? "noModel" : "signIn";
}

/** Ready first, then found on this computer, then the rest. */
const RANK: Record<State, number> = { ready: 0, noModel: 1, signIn: 1, running: 2, install: 2, error: 3, checking: 4 };

const listNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * Connecting the agents [D43, D45]: a card each, saying how it stands and offering the one thing
 * it needs next, Install (the vendor's own installer) or its own sign-in, each run in a real
 * terminal below the cards [D47]. Every word on a card comes from its adapter; nothing here names
 * a provider. Continue needs one agent with a model to pick.
 */
export function AgentsStep({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const { daemon } = useDaemon();
  const { list, checking, error } = useAgents();
  // The agent whose terminal shows below the cards, and one whose run is being started.
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  // Set once every agent has been checked, so cards don't jump as they connect.
  const [order, setOrder] = useState<string[] | null>(null);
  const online = Boolean(daemon);

  useEffect(() => {
    if (online) void checkAll();
  }, [online]);

  // Installed some other way meanwhile (a terminal): it shows when the window comes back.
  const missing = list?.some((agent) => stateOf(agent) === "install");
  useEffect(() => {
    if (!missing) return;
    const onFocus = () => void checkAll();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [missing]);

  // While a terminal is open its agent is checked again; a run that ended well closes by itself.
  const shown = list?.find((agent) => agent.name === open);
  useEffect(() => {
    if (!open || !online || starting === open) return;
    const timer = window.setInterval(() => void checkOne(open), RECHECK_MS);
    return () => clearInterval(timer);
  }, [open, online, starting]);
  const endedWell = list?.filter((agent) => agent.setup && !agent.setup.running && agent.setup.code === 0).map((agent) => agent.name).join(" ");
  useEffect(() => {
    for (const name of endedWell?.split(" ").filter(Boolean) ?? []) close(name);
  }, [endedWell]);

  const close = (name: string) => {
    setOpen((current) => (current === name ? null : current));
    run(["setup", name, "close"]).then(
      () => checkOne(name),
      (cause) => setFailed((all) => ({ ...all, [name]: errorText(cause) })),
    );
  };

  const begin = async (agent: Agent, action: "install" | "sign-in") => {
    setFailed(({ [agent.name]: _, ...rest }) => rest);
    setStarting(agent.name);
    setOpen(agent.name);
    try {
      await run(["setup", agent.name, action, "--cols", "100", "--rows", "16"]);
      void checkOne(agent.name);
    } catch (cause) {
      setOpen((current) => (current === agent.name ? null : current));
      setFailed((all) => ({ ...all, [agent.name]: errorText(cause) }));
    } finally {
      setStarting(null);
    }
  };

  const agents = list ?? [];
  const allChecked = list !== undefined && agents.every((agent) => stateOf(agent) !== "checking");
  if (allChecked && order === null) setOrder(agents.toSorted((a, b) => RANK[stateOf(a)] - RANK[stateOf(b)]).map((agent) => agent.name));
  const sorted = order ? agents.toSorted((a, b) => order.indexOf(a.name) - order.indexOf(b.name)) : agents;
  // An agent with a model stays usable while its sign-in runs (adding a key to one already working).
  const ready = agents.filter((agent) => agent.models?.length);

  const description =
    list === undefined && error
      ? "The agents couldn't be checked."
      : !allChecked && ready.length === 0
        ? `Looking for the agents on ${HERE}…`
        : ready.length === 0
          ? "Connect at least one agent to continue."
          : `${listNames(ready.map((agent) => agent.label))} ${ready.length === 1 ? "is" : "are"} ready.${ready.length < agents.length ? " Connect any others you use, or start right away." : ""}`;

  return (
    <div className="onboarding-step flex min-h-0 flex-1 flex-col">
      <StepHeader title="Connect your agents" description={description} />
      <div className="mt-12 min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto flex w-full max-w-onboarding flex-col gap-3">
          {!online && <p className="text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
          {list === undefined && error ? (
            <div className="flex flex-col items-center gap-3 py-12 text-sm">
              <p className="text-destructive">{error}</p>
              <Button size="sm" variant="outline" className={RAISED_BUTTON} disabled={!online || checking.has("*")} onClick={() => void checkAll()}>
                Try again
              </Button>
            </div>
          ) : list?.length === 0 ? (
            <p className="rounded-settings border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">No agents are available in this build.</p>
          ) : (
            <ul className="onboarding-agent-grid">
              {(list === undefined ? [undefined, undefined, undefined] : sorted).map((agent, index) => (
                <AgentCard
                  key={agent?.name ?? index}
                  agent={agent}
                  online={online}
                  starting={starting === agent?.name}
                  retrying={Boolean(agent && checking.has(agent.name))}
                  failed={agent && failed[agent.name]}
                  open={open === agent?.name}
                  onAction={(action) => agent && void begin(agent, action)}
                  onShow={() => agent && setOpen(agent.name)}
                  onRetry={() => agent && void checkOne(agent.name)}
                />
              ))}
            </ul>
          )}
          {shown && open && starting !== open && (
            <div className="flex h-64 overflow-hidden rounded-surface border border-divider">
              <TerminalPane
                key={open}
                id={`setup-${open}`}
                setup={{
                  title: `${shown.label} · ${shown.setup?.action === "install" ? "Install" : (shown.sign_in ?? "Sign in")}`,
                  onClose: () => close(open),
                }}
              />
            </div>
          )}
          <p className="text-xs text-quiet-foreground">Install and sign-in run in each agent's own terminal; Brigadier never sees your password or key.</p>
        </div>
      </div>
      <StepFooter
        onBack={onBack}
        count={list && `${ready.length} of ${agents.length} connected`}
        primary={{ label: "Continue", onClick: onContinue, disabled: ready.length === 0 }}
      />
    </div>
  );
}

function AgentCard({ agent, online, starting, retrying, failed, open, onAction, onShow, onRetry }: {
  agent: Agent | undefined;
  online: boolean;
  starting: boolean;
  retrying: boolean;
  failed: string | undefined;
  open: boolean;
  onAction: (action: "install" | "sign-in") => void;
  onShow: () => void;
  onRetry: () => void;
}) {
  const state = stateOf(agent);
  const setup = agent?.setup;
  const models = agent?.models ?? [];
  const local = models.filter((model) => model.local).length;
  // A run that ended badly stays until closed: its terminal says why.
  const runFailed = setup && !setup.running && setup.code !== 0 ? `${setup.action === "install" ? "Install" : "Sign-in"} ended with code ${setup.code ?? `signal ${setup.signal}`}` : null;
  const problem = failed ?? (state === "error" ? agent?.error : null) ?? runFailed;

  const line = starting
    ? "Starting…"
    : problem
      ? problem
      : state === "checking"
        ? "Checking…"
        : state === "running"
          ? setup?.action === "install" ? `Installing ${agent!.label}… in its terminal` : "Finish signing in, in its terminal"
          : state === "install"
            ? "Not installed"
            : state === "signIn"
              ? `Found on ${HERE} · Not signed in`
              : state === "noModel"
                ? `${agent?.how || "Signed in"} · No model available`
                : `${agent?.how || "Ready"} · ${models.length} ${models.length === 1 ? "model" : "models"}${local ? ` · ${local} local` : ""}`;

  const action = agent && (state === "install" ? (agent.install ? "install" : null) : agent.sign_in ? "sign-in" : null);
  return (
    <li
      data-state={state}
      className={cx("flex min-w-0 flex-col gap-3 rounded-settings border border-border bg-card p-4", !online && "opacity-disabled")}
    >
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="grid size-agent-mark shrink-0 place-items-center rounded-control bg-muted">
          <Terminal className="size-6" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-base font-medium">{agent?.label ?? " "}</p>
          <p
            role={problem ? "alert" : undefined}
            title={problem ?? agent?.path ?? undefined}
            className={cx("truncate text-xs", problem ? "text-destructive" : state === "ready" ? "text-muted-foreground" : "text-quiet-foreground")}
          >
            {line}
          </p>
        </div>
        {starting || (state === "checking" && agent) ? (
          <Spinner className="size-icon-sm animate-spin text-muted-foreground" />
        ) : state === "ready" ? (
          <span className="flex shrink-0 flex-col items-end gap-1">
            <Badge variant="success" className="h-7 gap-1.5 px-2.5">
              <Check />
              Connected
            </Badge>
          </span>
        ) : state === "running" ? (
          !open && (
            <Button size="sm" variant="ghost" className={PILL_BUTTON} disabled={!online} onClick={onShow}>
              Show terminal
            </Button>
          )
        ) : state === "error" ? (
          <Button size="sm" variant="outline" className={RAISED_BUTTON} disabled={!online || retrying} onClick={onRetry}>
            {retrying && <Spinner className="animate-spin" />}
            Retry
          </Button>
        ) : (
          action && (
            <Button size="sm" variant="outline" className={RAISED_BUTTON} disabled={!online} onClick={() => onAction(action)}>
              {action === "install" ? "Install" : agent?.sign_in}
            </Button>
          )
        )}
      </div>
      {/* Ready, its own sign-in still adds an account or a key (an API-key provider through its picker). */}
      {state === "ready" && agent?.sign_in && !starting && (
        <Button size="xs" variant="link-blue" className="self-start" disabled={!online} onClick={() => onAction("sign-in")}>
          {agent.sign_in}
        </Button>
      )}
    </li>
  );
}
