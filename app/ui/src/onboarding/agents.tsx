import { type FormEvent, useEffect, useState } from "react";

import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { useDaemon } from "../daemon";
import { ArrowUpRight, Plug, Spinner, Terminal, Warning } from "../icons";
import { type Agent, checkAll, checkOne, errorText, run, store, useAgents } from "./api";
import { HERE, PILL, RAISED_BUTTON, StepFooter, StepHeader } from "./parts";

/** How often an agent is checked again while its install or sign-in runs. */
const RECHECK_MS = 2000;

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

type SetupAction = "install" | "sign-in" | "update";
/** Each agent whose run was asked for and hasn't answered yet, with which: one window-wide, so a view drawn again (the sidebar collapsed) or another of the same agent still knows. */
const startingRuns = store<Readonly<Record<string, SetupAction>>>({});

/**
 * What drives an agent's card: its install or sign-in run, checked again while it goes and closed once it ends well,
 * and why one failed; a finished install waits for its Sign in to be pressed. Onboarding's step and the model picker's Set up share it.
 */
export function useAgentSetup(list: Agent[] | undefined, online: boolean) {
  const starting = startingRuns.use();
  const [failed, setFailed] = useState<Record<string, string>>({});

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
    for (const agent of endedWell ?? []) close(agent.name);
    // endedKey names exactly what endedWell holds.
  }, [endedKey]);

  const close = (name: string) =>
    run(["setup", name, "close"]).then(
      () => checkOne(name),
      (cause) => setFailed((all) => ({ ...all, [name]: errorText(cause) })),
    );

  const begin = async (agent: Agent, action: SetupAction) => {
    setFailed(({ [agent.name]: _, ...rest }) => rest);
    startingRuns.set({ ...startingRuns.get(), [agent.name]: action });
    try {
      // Wide, so a link it prints stays on one line; fewer rows than its pane, as a picker drawn taller and then
      // shrunk to the pane shows its top lines twice, while one grown redraws clean.
      await run(["setup", agent.name, action, "--cols", "500", "--rows", "10"]);
      await checkOne(agent.name);
      return true;
    } catch (cause) {
      setFailed((all) => ({ ...all, [agent.name]: errorText(cause) }));
      return false;
    } finally {
      const { [agent.name]: _, ...rest } = startingRuns.get();
      startingRuns.set(rest);
    }
  };

  return { starting, failed, begin, close };
}

/**
 * Connecting the agents, as the old app drew it [D43, D45]: a card each, two to a row, connected
 * ones first. Each card says how its agent stands and offers the one thing it needs next: Install
 * (the vendor's own installer) or Sign in (its own, in the browser), the card
 * waiting meanwhile; both run unseen on a host. Every word on a card comes from its adapter;
 * nothing here names a provider. Continue needs one agent with a model to pick.
 */
/**
 * Each agent that answered its test prompt, as it stood then: kept for the rest of onboarding, so Back then Continue
 * doesn't ask it again; a new install, sign-in or account asks again [D626].
 */
const passed = new Map<string, string>();
const standing = (agent: Agent) => JSON.stringify([agent.path, agent.version, agent.signed_in, agent.how, agent.plan, agent.logins]);

export function AgentsStep({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const { daemon } = useDaemon();
  const { list, checking, error } = useAgents();
  // Set once every agent has been checked, so cards don't jump as they connect.
  const [order, setOrder] = useState<string[] | null>(null);
  const online = Boolean(daemon);
  const { starting, failed, begin, close } = useAgentSetup(list, online);
  // Continue's test prompt [D617]: out now, answered, and each that didn't answer, which stays until it's signed in again.
  const [testing, setTesting] = useState<ReadonlySet<string>>(new Set());
  const [untested, setUntested] = useState<Record<string, TestFailure>>({});
  // An install started here goes on to its sign-in by itself once it has ended and closed [D616].
  const [thenSignIn, setThenSignIn] = useState<ReadonlySet<string>>(new Set());

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

  // An agent turned off in Settings › Providers isn't offered here [D2079].
  const agents = (list ?? []).filter((agent) => agent.enabled);
  const allChecked = list !== undefined && agents.every((agent) => stateOf(agent) !== "checking");
  if (allChecked && order === null) setOrder(agents.toSorted((a, b) => RANK[stateOf(a)] - RANK[stateOf(b)]).map((agent) => agent.name));
  const sorted = order ? agents.toSorted((a, b) => order.indexOf(a.name) - order.indexOf(b.name)) : agents;
  const ready = agents.filter((agent) => agent.models?.length && !untested[agent.name]);

  useEffect(() => {
    for (const agent of agents) {
      const state = stateOf(agent);
      if (!thenSignIn.has(agent.name) || agent.setup || state === "checking" || state === "install") continue;
      setThenSignIn((names) => new Set([...names].filter((name) => name !== agent.name)));
      if (state === "signIn") void begin(agent, "sign-in");
    }
  }, [list, thenSignIn]);

  const act = (agent: Agent, action: "install" | "sign-in") => {
    setUntested(({ [agent.name]: _, ...rest }) => rest);
    passed.delete(agent.name);
    if (action === "install") setThenSignIn((names) => new Set(names).add(agent.name));
    void begin(agent, action);
  };

  // Every ready agent not yet answered is asked at once; all answered goes on, else their cards say why, and Continue
  // again goes on with those that did.
  const testThenContinue = async () => {
    const asked = ready.filter((agent) => passed.get(agent.name) !== standing(agent));
    if (!asked.length) return onContinue();
    setTesting(new Set(asked.map((agent) => agent.name)));
    const answers = await Promise.all(
      asked.map((agent) =>
        run(["agents", "test", agent.name]).then(
          (reply) => ({ agent, reply }),
          (cause) => ({ agent, reply: { passed: false, reason: errorText(cause), login: null } }),
        ),
      ),
    );
    setTesting(new Set());
    const failures = answers.filter(({ reply }) => !reply.passed);
    for (const { agent, reply } of answers) if (reply.passed) passed.set(agent.name, standing(agent));
    setUntested((all) => ({
      ...all,
      ...Object.fromEntries(failures.map(({ agent, reply }) => [agent.name, { label: agent.label, reason: String(reply.reason ?? ""), login: (reply.login as string | null) ?? null }])),
    }));
    if (!failures.length) onContinue();
  };

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
                  starting={Boolean(agent && starting[agent.name])}
                  retrying={Boolean(agent && checking.has(agent.name))}
                  failed={failed[agent.name] ?? untested[agent.name]?.reason}
                  testing={testing.has(agent.name)}
                  onAction={(action) => act(agent, action)}
                  onCancel={() => agent && void close(agent.name)}
                  onRetry={() => agent && void checkOne(agent.name)}
                />
              ))}
            </ul>
          )}
          <TestFailed failures={Object.values(untested)} />
          <p className="text-xs text-setup-hint">You can connect more accounts anytime in Settings.</p>
        </div>
      </div>
      <StepFooter
        onBack={onBack}
        count={testing.size ? "Sending a test prompt…" : list && `${ready.length} of ${agents.length} connected`}
        primary={{ label: "Continue", onClick: () => void testThenContinue(), busy: testing.size > 0, disabled: ready.length === 0 }}
      />
    </div>
  );
}

/** A card's button: solid, so it reads on any agent's surface. */
export const CARD_BUTTON = cx(PILL, "gap-1.75 border border-border bg-background px-3 text-foreground enabled:hover:bg-muted");

/**
 * An agent's card, our shape [D616]: its mark at the top, then its name (with its docs) over how it
 * stands, and the one thing it needs next. Installed, it takes its own surface, by the name its adapter gives.
 */
export function AgentCard({ agent, online, starting, retrying, failed, testing = false, onAction, onCancel, onRetry }: {
  agent: Agent | undefined;
  online: boolean;
  starting: boolean;
  retrying: boolean;
  failed: string | undefined;
  /** Its test prompt is out [D617]. */
  testing?: boolean;
  onAction: (action: "install" | "sign-in") => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const state = stateOf(agent);
  const setup = agent?.setup;
  const label = agent?.label ?? "";
  const waiting = starting || state === "running";
  const problem = failed ?? (state === "error" ? agent?.error : null) ?? runFailure(setup, label);
  const installing = (starting && state === "install") || setup?.action === "install";
  const connected = state === "ready" && !waiting && !problem;
  const brand = agent?.brand && state !== "install" && state !== "checking" && !installing ? agent.brand : null;

  const line = problem ? (
    <>
      <Warning className="size-icon-sm shrink-0" />
      <span className="truncate">{problem}</span>
    </>
  ) : testing ? (
    <>
      <Spinner className="size-icon-sm shrink-0 animate-spin" />
      <span className="truncate">Sending a test prompt…</span>
    </>
  ) : connected ? (
    <>
      <Plug className="size-icon-md shrink-0" />
      <span className="truncate font-medium">Connected</span>
      {(agent?.plan || agent?.how) && (
        <span className="truncate opacity-70">· {agent.plan ? `${agent.plan.charAt(0).toUpperCase()}${agent.plan.slice(1)} plan` : agent.how}</span>
      )}
    </>
  ) : (
    <span className="truncate opacity-70">
      {waiting
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
                : agent?.signed_in === false
                  ? "No sign-in needed"
                  : "Signed in"}
    </span>
  );

  const action = agent && state !== "checking" && (state === "install" ? (agent.install ? "install" : null) : agent.sign_in ? "sign-in" : null);
  return (
    <li
      data-state={waiting ? "waiting" : state}
      data-brand={brand ?? undefined}
      className={cx(
        "agent-card flex min-h-36 min-w-0 flex-col gap-4 rounded-settings border p-5",
        brand ? "border-transparent" : "border-border bg-card",
        !online && "opacity-disabled",
      )}
    >
      <span className={cx("grid size-8 place-items-center", state === "checking" && "animate-pulse")}>
        {agent?.mark ? (
          // Its mark, from its adapter (trusted, built in).
          <span aria-hidden className="grid size-full place-items-center svg:size-full" dangerouslySetInnerHTML={{ __html: agent.mark }} />
        ) : (
          <Terminal className="size-full" />
        )}
      </span>
      <div className="mt-auto flex min-w-0 items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="flex min-w-0 items-center gap-1.5 text-lg font-medium">
            <span className="truncate">{agent?.label ?? " "}</span>
            {agent?.docs && (
              <a href={agent.docs} target="_blank" rel="noreferrer" aria-label={`Open ${label} docs`} className="shrink-0 opacity-50 hover:opacity-100">
                <ArrowUpRight className="size-icon-md" />
              </a>
            )}
          </p>
          <p role={problem ? "alert" : undefined} title={problem ?? agent?.path ?? undefined} className="flex min-w-0 items-center gap-1.5 text-xs">
            {line}
          </p>
        </div>
        {waiting ? (
          // While it runs: a spinner, which reads Cancel under the pointer [D616].
          <Button
            variant={null}
            size={null}
            aria-label={`Cancel ${installing ? "installing" : "signing in to"} ${label}`}
            disabled={starting}
            onClick={onCancel}
            className={cx(CARD_BUTTON, "group")}
          >
            <span className="grid">
              <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.75 group-enabled:group-hover:invisible">
                <Spinner className="size-3.25 animate-spin" />
                {installing ? "Installing…" : "Signing in…"}
              </span>
              <span aria-hidden className="invisible col-start-1 row-start-1 group-enabled:group-hover:visible">
                Cancel
              </span>
            </span>
          </Button>
        ) : state === "error" ? (
          <Button variant={null} size={null} className={CARD_BUTTON} disabled={!online || retrying} onClick={onRetry}>
            {retrying && <Spinner className="size-icon-md animate-spin" />}
            Retry
          </Button>
        ) : (
          action &&
          !connected && (
            <Button variant={null} size={null} className={CARD_BUTTON} disabled={!online || testing} onClick={() => onAction(action)}>
              {action === "install" ? "Install" : agent?.sign_in}
            </Button>
          )
        )}
      </div>
      {/* A device code to enter on its page; or, when the browser couldn't hand the sign-in back, the code its page shows goes in here. */}
      {state === "running" && agent && <SetupCode agent={agent} run={setup} />}
    </li>
  );
}

/** An agent whose test prompt failed [D617]: its CLI's own words, and its sign-in as typed in a terminal. */
type TestFailure = { label: string; reason: string; login: string | null };

/** Under the cards: what to do about each agent that didn't answer its test prompt. */
function TestFailed({ failures }: { failures: TestFailure[] }) {
  if (!failures.length) return null;
  return (
    <div role="alert" className="flex flex-col gap-4 rounded-settings border border-border bg-card p-4 text-sm">
      {failures.map((failure) => (
        <div key={failure.label} className="flex min-w-0 gap-2.5">
          <Warning className="mt-0.5 size-icon-md shrink-0 text-destructive" />
          <div className="flex min-w-0 flex-col gap-2">
            <p className="font-medium">{failure.label} didn't answer its test prompt</p>
            <p className="font-mono text-xs break-words text-muted-foreground">{failure.reason}</p>
            {failure.login && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                Sign in again on its card, or run this in a terminal:
                <span className="flex h-control-sm items-center gap-1 rounded-control border border-fill-hover bg-fill-subtle ps-2.5 pe-0.5">
                  <span className="font-mono text-foreground">{failure.login}</span>
                  <CopyButton text={failure.login} tooltip="Copy command" size="icon-xs" className="text-muted-foreground" />
                </span>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

/** An install, update or sign-in run, as Rust reads it (an added account's sign-in too). */
export type Run = NonNullable<Agent["setup"]>;

/**
 * Why a run ended badly, or null: the last line its CLI printed when there is one, else a sign-in's own error words
 * where the agent gives them, else ours [D2078, D1324, D2077]. It stays until tried again.
 */
export function runFailure(run: Run | null | undefined, label: string): string | null {
  if (!run || run.running || run.code === 0) return null;
  if (run.reason) return run.reason;
  if (run.action === "update") return run.code === null ? "The update was stopped." : `The update stopped with code ${run.code}.`;
  if (run.action === "install") return `${label} couldn't be installed. Try again.`;
  return run.error ? `${label}: ${run.error}` : `Signing in to ${label} didn't finish. Try again.`;
}

/**
 * While a sign-in runs: the device code to enter on its page, or, for when the browser can't hand the sign-in back, a
 * field for the code its page shows. `account`: an added account's sign-in. Nothing otherwise.
 */
export function SetupCode({ agent, run, account }: { agent: Agent; run: Run | null | undefined; account?: string }) {
  if (!run?.running || !run.code_page) return null;
  return run.device_code ? <DeviceCode page={run.code_page} code={run.device_code} /> : <ConnectCode agent={agent} page={run.code_page} account={account} />;
}

/** A device code sign-in: its one-time code in a mono chip with Copy, and the page to enter it on, as the old app's GitHub sign-in. */
export function DeviceCode({ page, code }: { page: string; code: string }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="flex h-control-md items-center gap-1.5 rounded-control border border-fill-hover bg-fill-subtle ps-3 pe-1">
        <span className="font-mono text-base font-medium tracking-widest">{code}</span>
        <CopyButton text={code} tooltip="Copy code" size="icon-xs" className="text-muted-foreground" />
      </span>
      <Button variant="ghost" size="sm" nativeButton={false} render={<a href={page} target="_blank" rel="noreferrer" />}>
        Open the sign-in page
        <ArrowUpRight className="size-icon-sm text-muted-foreground" />
      </Button>
    </div>
  );
}

/** For when the browser can't hand the sign-in back: a link to the page that shows a code, and a field to paste it into. */
function ConnectCode({ agent, page, account }: { agent: Agent; page: string; account?: string }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await run(["setup", agent.name, "code", code, ...(account ? ["--account", account] : [])]);
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
