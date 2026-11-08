import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { useDaemon } from "../daemon";
import { Check, Spinner, Terminal } from "../icons";
import { type Agent, checkAll, checkOne, errorText, run, useAgents } from "./api";
import { MAC, PILL, RAISED_BUTTON, StepFooter, StepHeader } from "./parts";

/** How often an agent is checked again while its install or sign-in runs. */
const RECHECK_MS = 2000;
const HERE = MAC ? "this Mac" : "this computer";

type State = "checking" | "running" | "error" | "install" | "signIn" | "noModel" | "ready";

/** Installed, signed in and has a usable model are separate: only the last makes it ready [D45]. */
export function stateOf(agent: Agent | undefined): State {
  if (!agent || agent.path === undefined) return "checking";
  if (agent.setup?.running) return "running";
  if (agent.error) return "error";
  if (!agent.path) return "install";
  if (agent.models?.length) return "ready";
  return agent.signed_in ? "noModel" : "signIn";
}

/** Connected first, then found on this computer, then the rest. */
const RANK: Record<State, number> = { ready: 0, noModel: 1, signIn: 1, running: 2, install: 2, error: 3, checking: 4 };

const listNames = (names: string[]) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * What drives an agent's card: its install or sign-in run, checked again while it goes and closed once it ends well,
 * an install's sign-in following by itself, and why one failed. Onboarding's step and the model picker's Set up share it.
 */
export function useAgentSetup(list: Agent[] | undefined, online: boolean) {
  const [starting, setStarting] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  // Agents whose install just ended well: their sign-in follows.
  const signInNext = useRef(new Set<string>());

  // While a run goes its agent is checked again; one that ended well goes by itself.
  const runningNames = list?.filter((agent) => agent.setup?.running).map((agent) => agent.name).join(" ") ?? "";
  useEffect(() => {
    const names = runningNames.split(" ").filter(Boolean);
    if (!names.length || !online) return;
    const timer = window.setInterval(() => names.forEach((name) => void checkOne(name)), RECHECK_MS);
    return () => clearInterval(timer);
  }, [runningNames, online]);
  const endedWell = list?.filter((agent) => agent.setup && !agent.setup.running && (agent.setup.code === 0 || (agent.setup.action === "install" && agent.path)));
  const endedKey = endedWell?.map((agent) => `${agent.name}:${agent.setup!.action}`).join(" ");
  useEffect(() => {
    for (const agent of endedWell ?? []) {
      if (agent.setup!.action === "install") signInNext.current.add(agent.name);
      close(agent.name);
    }
    // endedKey names exactly what endedWell holds.
  }, [endedKey]);
  // Installed, its sign-in starts, as the old app's Install did; already usable, nothing follows.
  useEffect(() => {
    for (const agent of list ?? []) {
      if (!signInNext.current.has(agent.name) || agent.setup) continue;
      const state = stateOf(agent);
      if (state === "checking") continue;
      signInNext.current.delete(agent.name);
      if ((state === "signIn" || state === "noModel") && agent.sign_in) void begin(agent, "sign-in");
    }
  }, [list]);

  const close = (name: string) =>
    run(["setup", name, "close"]).then(
      () => checkOne(name),
      (cause) => setFailed((all) => ({ ...all, [name]: errorText(cause) })),
    );

  const begin = async (agent: Agent, action: "install" | "sign-in") => {
    setFailed(({ [agent.name]: _, ...rest }) => rest);
    setStarting(agent.name);
    try {
      // Wide, so a link it prints stays on one line.
      await run(["setup", agent.name, action, "--cols", "500", "--rows", "40"]);
      await checkOne(agent.name);
    } catch (cause) {
      setFailed((all) => ({ ...all, [agent.name]: errorText(cause) }));
    } finally {
      setStarting(null);
    }
  };

  return { starting, failed, begin, close };
}

/**
 * Connecting the agents, as the old app drew it [D43, D45]: a card each, two to a row, connected
 * ones first. Each card says how its agent stands and offers the one thing it needs next: Install
 * (the vendor's own installer, then its sign-in) or Sign in (its own, in the browser), the card
 * waiting meanwhile; both run unseen on a host. Every word on a card comes from its adapter;
 * nothing here names a provider. Continue needs one agent with a model to pick.
 */
export function AgentsStep({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const { daemon } = useDaemon();
  const { list, checking, error } = useAgents();
  // Set once every agent has been checked, so cards don't jump as they connect.
  const [order, setOrder] = useState<string[] | null>(null);
  const online = Boolean(daemon);
  const { starting, failed, begin, close } = useAgentSetup(list, online);

  useEffect(() => {
    if (online) void checkAll(true);
  }, [online]);

  // Installed some other way meanwhile (a terminal): it shows when the window comes back.
  const missing = list?.some((agent) => stateOf(agent) === "install");
  useEffect(() => {
    if (!missing) return;
    const onFocus = () => void checkAll();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [missing]);

  const agents = list ?? [];
  const allChecked = list !== undefined && agents.every((agent) => stateOf(agent) !== "checking");
  if (allChecked && order === null) setOrder(agents.toSorted((a, b) => RANK[stateOf(a)] - RANK[stateOf(b)]).map((agent) => agent.name));
  const sorted = order ? agents.toSorted((a, b) => order.indexOf(a.name) - order.indexOf(b.name)) : agents;
  const ready = agents.filter((agent) => agent.models?.length);

  const description =
    list === undefined && error
      ? "The agents couldn't be checked."
      : ready.length === 0
        ? "Connect at least one agent to continue."
        : `${listNames(ready.map((agent) => agent.label))} ${ready.length === 1 ? "is" : "are"} ready.${ready.length < agents.length ? " Connect any others you use, or start right away." : ""}`;

  return (
    <div className="onboarding-step flex min-h-0 flex-1 flex-col">
      <StepHeader title="Connect your agents" description={description} />
      <div className="mt-12 min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto flex w-full max-w-onboarding flex-col gap-3">
          {!online && <p className="text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
          {error && (
            <div className="flex items-center gap-3 text-sm">
              <ErrorLine size="sm" error={error} />
              <Button variant={null} size={null} className={RAISED_BUTTON} disabled={!online || checking.has("*")} onClick={() => void checkAll()}>
                Try again
              </Button>
            </div>
          )}
          {list?.length === 0 ? (
            <p className="rounded-settings border border-border bg-card px-4 py-6 text-center text-sm text-muted-foreground">No agents are available in this build.</p>
          ) : (
            <ul className="onboarding-agent-grid">
              {sorted.map((agent) => (
                <AgentCard
                  key={agent.name}
                  agent={agent}
                  online={online}
                  starting={starting === agent?.name}
                  retrying={Boolean(agent && checking.has(agent.name))}
                  failed={agent && failed[agent.name]}
                  onAction={(action) => agent && void begin(agent, action)}
                  onCancel={() => agent && void close(agent.name)}
                  onRetry={() => agent && void checkOne(agent.name)}
                />
              ))}
            </ul>
          )}
          <p className="text-xs text-setup-hint">You can connect more accounts anytime in Settings.</p>
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

export function AgentCard({ agent, online, starting, retrying, failed, onAction, onCancel, onRetry }: {
  agent: Agent | undefined;
  online: boolean;
  starting: boolean;
  retrying: boolean;
  failed: string | undefined;
  onAction: (action: "install" | "sign-in") => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const state = stateOf(agent);
  const setup = agent?.setup;
  const label = agent?.label ?? "";
  const waiting = starting || state === "running";
  // A run that ended badly stays until tried again; what it printed isn't shown, as in the old app.
  const runFailed =
    setup && !setup.running && setup.code !== 0
      ? setup.action === "install"
        ? `${label} couldn't be installed. Try again.`
        : `Signing in to ${label} didn't finish. Try again.`
      : null;
  const problem = failed ?? (state === "error" ? agent?.error : null) ?? runFailed;
  const installing = (starting && state === "install") || setup?.action === "install";

  const line = problem
    ? problem
    : waiting
      ? installing
        ? `Installing ${label}…`
        : "Complete sign-in in your browser"
      : state === "checking"
        ? "Checking…"
        : state === "install"
          ? "Not installed"
          : state === "signIn"
            ? `Found on ${HERE} · Not signed in`
            : state === "noModel"
              ? `${agent?.how || "Signed in"} · No model available`
              : agent?.how || "Signed in";

  const action = agent && state !== "checking" && (state === "install" ? (agent.install ? "install" : null) : agent.sign_in ? "sign-in" : null);
  return (
    <li
      data-state={waiting ? "waiting" : state}
      className={cx("flex min-w-0 flex-col gap-3 rounded-settings border border-border bg-card p-4", !online && "opacity-disabled")}
    >
      <div className="flex min-w-0 items-center gap-3.5">
        <span className="grid size-agent-mark shrink-0 place-items-center rounded-control bg-muted">
          {agent?.mark ? (
            // Its mark, from its adapter (trusted, built in).
            <span aria-hidden className="grid size-6.5 place-items-center svg:size-full" dangerouslySetInnerHTML={{ __html: agent.mark }} />
          ) : (
            <Terminal className="size-6.5" />
          )}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <p className="truncate text-base font-medium">{agent?.label ?? " "}</p>
          <p
            role={problem ? "alert" : undefined}
            title={problem ?? agent?.path ?? undefined}
            className={cx("truncate text-xs", problem ? "text-destructive" : state === "ready" ? "text-muted-foreground" : "text-setup-hint")}
          >
            {line}
          </p>
        </div>
        {state === "ready" && !waiting ? (
          <span className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-capsule border border-transparent bg-setup-connected px-2.5 text-xs font-medium whitespace-nowrap text-success svg:size-icon-xs">
            <Check />
            Connected
          </span>
        ) : waiting ? (
          // Waiting… is the way out too: hovered or focused it reads Cancel, in the same room (the
          // wider of the two holds it), and stops the run.
          <Button
            variant={null}
            size={null}
            aria-label={`Cancel ${installing ? "installing" : "signing in to"} ${label}`}
            disabled={starting}
            onClick={onCancel}
            className={cx(PILL, "group/wait grid px-1 text-muted-foreground hover:text-foreground focus-visible:text-foreground")}
          >
            <span className="col-start-1 row-start-1 flex items-center gap-1.75 group-hover/wait:invisible group-focus-visible/wait:invisible">
              <Spinner className="size-3.25 animate-spin" />
              Waiting…
            </span>
            <span className="invisible col-start-1 row-start-1 text-center group-hover/wait:visible group-focus-visible/wait:visible">Cancel</span>
          </Button>
        ) : state === "error" ? (
          <Button variant={null} size={null} className={RAISED_BUTTON} disabled={!online || retrying} onClick={onRetry}>
            {retrying && <Spinner className="size-icon-md animate-spin" />}
            Retry
          </Button>
        ) : (
          action && (
            <Button variant={null} size={null} className={RAISED_BUTTON} disabled={!online} onClick={() => onAction(action)}>
              {action === "install" ? "Install" : agent?.sign_in}
            </Button>
          )
        )}
      </div>
      {/* The browser couldn't hand the sign-in back: the code its page shows goes in here. */}
      {state === "running" && setup?.code_page && agent && <ConnectCode agent={agent} page={setup.code_page} />}
    </li>
  );
}

/** For when the browser can't hand the sign-in back: a link to the page that shows a code, and a field to paste it into. */
function ConnectCode({ agent, page }: { agent: Agent; page: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await run(["setup", agent.name, "code", code]);
      setCode("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form data-own-enter onSubmit={(event) => void submit(event)} className="flex min-w-0 flex-col gap-1.5">
      <p className="text-xs text-muted-foreground">
        Browser didn't finish?{" "}
        <a href={page} target="_blank" rel="noreferrer" className="text-link hover:underline">
          Open the code page
        </a>
        , then paste the code it shows.
      </p>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          aria-label={`Code for ${agent.label}`}
          placeholder="Paste the code from the page"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          value={code}
          disabled={busy}
          aria-invalid={error !== null || undefined}
          onChange={(event) => setCode(event.target.value)}
        />
        <Button type="submit" size="sm" variant="outline" disabled={busy || !code.trim()}>
          Send
        </Button>
      </div>
      <ErrorLine error={error} />
    </form>
  );
}
