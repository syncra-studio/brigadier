import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import type { ModelChoice, ModelGroup } from "../components/composer/model-picker";
import { ModelPill, ModelStrip, useModelStrip } from "../components/composer/model-strip";
import type { Quota } from "../components/composer/quota-lines";
import { SwitchDivider } from "../components/thread/cards";
import { ChangeLine } from "../components/thread/line";
import { showToast } from "../components/toast";
import { type Row, threadSource } from "../daemon";
import { useStart } from "../home/start";
import { errorText, run, store } from "../onboarding/api";
import { readRouting } from "../settings/routing";
import { SetUpAgentDialog } from "./set-up";
import { newId } from "./store";

/** A session's row with what its next turn runs on, from Rust's fold [D129]; `picked` is another agent the next message goes to. */
type ModelRow = Row & {
  model?: string | null;
  effort?: string | null;
  /** On its model's fast tier. */
  fast?: boolean;
  /** `now`: the user said Switch now, so the turn stops for it [D557]. */
  picked?: { backend: string; model: string; effort: string | null; fast?: boolean; now?: boolean } | null;
  running?: boolean;
  /** The last `set` Rust took, by the app's op id [D30]. */
  setup_op?: string | null;
};

type Rust = {
  provider: string;
  label: string;
  short: string | null;
  mark: string | null;
  unavailable: "install" | "sign-in" | null;
  models: { id: string; name: string; efforts: string[]; default_effort: string | null; fast: string | null; legacy: boolean }[];
  usage?: Quota[] | null;
};

/** Rust's groups in the kit picker's shape. */
export const asGroups = (groups: Rust[]): ModelGroup[] =>
  groups.map((group) => ({ ...group, models: group.models.map(({ default_effort, ...model }) => ({ ...model, defaultEffort: default_effort ?? undefined })) }));

let lastGroups: ModelGroup[] | null = null;
/** Whether a session's model takes images, by the last list read; unknown counts as yes [D2022 #14]. */
export const takesImages = (provider?: string, model?: string | null) =>
  lastGroups?.find((group) => group.provider === provider)?.models.find((each) => each.id === model)?.images !== false;

/** The levels a model runs at, by `groups` (else the last list read): no Auto where its CLI says it has none. */
export const levelsOf = <Level extends string>(levels: readonly Level[], provider?: string, model?: string | null, groups = lastGroups) => {
  const listed = groups?.find((group) => group.provider === provider)?.models.find((each) => each.id === model);
  return listed?.auto === false ? levels.filter((level) => level !== "auto") : levels;
};

/** A model's pick, by session, until Rust's line for it is in [D76]: `agent` names another agent picked. */
type Pick = { op: string; from: string | null; to: string; agent?: string };
const picks = store<ReadonlyMap<string, Pick>>(new Map());
const pick = (id: string, line: Pick | null) => {
  const next = new Map(picks.get());
  if (line) next.set(id, line);
  else next.delete(id);
  picks.set(next);
};

export const useModelPick = (id: string) => picks.use().has(id);

/**
 * A pick Rust took: its pending line goes for good once Rust's row with its op is in the thread, so a row paged out later
 * never brings it back at the bottom [D92].
 */
function settle(id: string, op: string) {
  const has = () => threadSource.get()?.items.some((item) => "op" in item && item.op === op) === true;
  const done = () => {
    stop();
    clearTimeout(timer);
    if (picks.get().get(id)?.op === op) pick(id, null);
  };
  const stop = threadSource.subscribe(() => has() && done());
  // shortcut: a pick Rust draws no row for (no model known before it) goes after 3s; drop once `set` says whether it drew one.
  const timer = setTimeout(done, 3000);
  if (has()) done();
}

/** The divider a model pick leaves, drawn at once where the user is until Rust's row with its op takes its place [D76, D124]. */
export function PendingModelLine({ id }: { id: string }) {
  const line = picks.use().get(id);
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  if (!line || session?.id !== id || session.items.some((item) => "op" in item && item.op === line.op)) return null;
  return (
    <div className="pt-2">
      {line.agent ? (
        <SwitchDivider change={{ id: line.op, turnId: "", kind: "switch", state: "switching", reason: "picked", from: line.from, to: line.agent, model: line.to, handoff: true, automatic: false, text: "" }} />
      ) : (
        <ChangeLine item={{ id: line.op, turnId: "", kind: "line", reason: "model", why: "changed", from: line.from, to: line.to, live: true }} />
      )}
    </div>
  );
}

/** Opens a session's model picker: a notice's "Choose another model" (D487). */
export const askModel = new EventTarget();

/** The session's model, by name, and what its CLI says of its retiring, for the rail (D487); none when it says nothing. */
export type Retiring = { name: string; at: number | null; to: string | null };
const retiring = new Map<string, Retiring>();
const told = new EventTarget();
export const useRetiring = (id: string): Retiring | undefined =>
  useSyncExternalStore(
    (listener) => {
      told.addEventListener("change", listener);
      return () => told.removeEventListener("change", listener);
    },
    () => retiring.get(id),
  );

/**
 * The session's model pill and its strip on the rail [D129, D190, D83]: the list from each agent's last check at once,
 * then fresh [D128]. A pick shows at once as pending and goes to Rust with its op id; the row's `setup_op` reaching that
 * id settles it, and a refusal puts the last value back with Rust's words [D30, D40]. Another agent's model asks
 * "Switch to {name}?" first, and the next message goes to it [D90]. Offline it can't be opened.
 */
/** `locked`: shown, never changed, as a worker's in its own tab [D293]. */
export function useSessionModel(id: string, row: ModelRow | undefined, offline: boolean, locked = false): { pill: ReactNode; strip: ReactNode } {
  const [chooseAsked, setChooseAsked] = useState(0);
  useEffect(() => {
    const ask = () => setChooseAsked((n) => n + 1);
    askModel.addEventListener("ask", ask);
    return () => askModel.removeEventListener("ask", ask);
  }, []);
  const starting = useStart(id)?.asking === true;
  // The last list any session read names this one's model in its first frame (a fork's), until its own lands.
  const [groups, setGroups] = useState<ModelGroup[] | null>(lastGroups);
  if (groups) lastGroups = groups;
  const [listError, setListError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ op: string; choice: ModelChoice } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setUp, setSetUp] = useState<string | null>(null);
  const asked = useRef(0);

  const load = () => {
    const mine = ++asked.current;
    const land = (reply: Record<string, any>, fresh: boolean) => {
      if (mine !== asked.current) return;
      setGroups((now) => fresh || now === null ? asGroups(reply.groups) : now);
      if (fresh) setListError(null);
    };
    const fail = (cause: unknown) => mine === asked.current && setListError(errorText(cause));
    // Cache fills an empty picker only; it never replaces a list already shown.
    run(["models", "--session", id]).then((reply) => land(reply, false), () => {});
    run(["models", "--session", id, "--fresh"]).then((reply) => {
      land(reply, true);
      // A new model list can make an offer; Rust works them out on a read [D386].
      readRouting().catch(() => {});
    }, fail);
  };
  useEffect(() => {
    // Home opens this view before Rust has made the session and its worktree: until then the last list names its model.
    if (!offline && starting) run(["models"]).then((reply) => setGroups((now) => now ?? asGroups(reply.groups)), () => {});
    if (!offline && !starting) load();
    return () => { asked.current++; };
  }, [id, offline, starting]);
  // Signed in or installed some other way meanwhile (a terminal): it shows when the window comes back, the list kept meanwhile.
  const missing = groups?.some((group) => group.unavailable);
  useEffect(() => {
    if (!missing || offline || starting) return;
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, [missing, id, offline, starting]);

  // Settled once Rust's row has taken it.
  if (pending && row?.setup_op === pending.op) setPending(null);

  const picked = row?.picked;
  const shown: ModelChoice | null = picked
    ? { provider: picked.backend, model: picked.model, effort: picked.effort, fast: picked.fast === true }
    : row?.model
      ? { provider: row.backend, model: row.model, effort: row.effort ?? null, fast: row.fast === true }
      : null;
  const value = pending?.choice ?? shown;

  // What the list says of the model it runs, for the rail; another of its models names the suggested one.
  const models = groups?.find((group) => group.provider === shown?.provider)?.models;
  const current = models?.find((model) => model.id === shown?.model);
  const named = current?.retiring ? { name: current.name, at: current.retiring.at, to: models?.find((model) => model.id === current.retiring?.to)?.name ?? current.retiring.to } : undefined;
  useEffect(() => {
    const was = retiring.get(id);
    if (was?.name === named?.name && was?.at === named?.at && was?.to === named?.to) return;
    if (named) retiring.set(id, named);
    else retiring.delete(id);
    told.dispatchEvent(new Event("change"));
  });

  const change = (choice: ModelChoice) => {
    const op = newId();
    setPending({ op, choice });
    setError(null);
    // Named as the picker names them; another agent, or this one picked back, as a switch.
    const group = (provider?: string) => groups?.find((each) => each.provider === provider);
    const name = (provider?: string, model?: string | null) => group(provider)?.models.find((each) => each.id === model)?.name ?? model ?? null;
    const to = name(choice.provider, choice.model) ?? choice.model;
    const agent = choice.provider !== row?.backend || picked ? (group(choice.provider)?.label ?? choice.provider) : undefined;
    if (agent || choice.model !== shown?.model) pick(id, { op, from: agent ? (group(shown?.provider)?.label ?? null) : name(shown?.provider, shown?.model), to, agent });
    const args = ["set", id, "--agent", choice.provider, "--model", choice.model, "--op", op];
    if (choice.effort) args.push("--effort", choice.effort);
    if (choice.fast) args.push("--fast");
    run(args).then(() => settle(id, op), (cause) => {
      // Only this pick's refusal undoes it; a newer pick stands.
      setPending((now) => (now?.op === op ? null : now));
      if (picks.get().get(id)?.op === op) pick(id, null);
      setError(errorText(cause));
    });
  };

  const disabled = offline || starting || groups === null || locked;
  const strip = useModelStrip({ disabled, asked: chooseAsked });
  if (!value) return { pill: null, strip: null };
  return {
    pill: (
      <div className="flex min-w-0 items-center justify-end gap-2">
        <ErrorLine error={error ?? listError} className="min-w-0 truncate" />
        {picked && row?.running ? <SwitchAfter key={row.setup_op ?? ""} id={id} name={groups?.find((group) => group.provider === picked.backend)?.label ?? picked.backend} now={picked.now === true} /> : null}
        <ModelPill strip={strip} groups={groups ?? []} value={value} disabled={disabled} />
        <SetUpAgentDialog
          name={setUp}
          onClose={() => {
            setSetUp(null);
            load();
          }}
        />
      </div>
    ),
    strip: <ModelStrip strip={strip} groups={groups ?? []} value={value} onChange={change} onSetUp={setSetUp} />,
  };
}

/**
 * Another agent picked while a turn runs: "Codex after this turn", it takes over as the turn ends; Switch now stops the
 * turn and it carries on from the conversation, "Switching to Codex…" till Rust's row has it there [D557]. Keyed by its
 * pick's op, so a newer pick starts afresh.
 */
function SwitchAfter({ id, name, now }: { id: string; name: string; now: boolean }) {
  const [asked, setAsked] = useState(false);
  const going = now || asked;
  const go = () => {
    setAsked(true);
    run(["set", id, "--now", "--op", newId()]).catch((cause) => {
      setAsked(false);
      showToast(`Couldn't switch now: ${errorText(cause)}`, { tone: "error" });
    });
  };
  return (
    <span className="flex min-w-0 items-center gap-1 text-sm text-muted-foreground">
      <span className="truncate">{going ? `Switching to ${name}…` : `${name} after this turn`}</span>
      {!going && (
        <Button size="xs" variant="ghost" onClick={go}>
          Switch now
        </Button>
      )}
    </span>
  );
}
