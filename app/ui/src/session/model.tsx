import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import type { ModelChoice, ModelGroup } from "../components/composer/model-picker";
import { asGroups, choiceOf, loadModels, type ModelRow, modelState, pickLine, setArgs } from "../../../shared/session/model";
import { ModelPill } from "../components/composer/model-pill";
import { SwitchDivider } from "../components/thread/cards";
import { ChangeLine } from "../components/thread/line";
import { showToast } from "../components/toast";
import { threadSource } from "../daemon";
import { useStart } from "../home/start";
import { errorText, run, store } from "../onboarding/api";
import { readRouting } from "../settings/routing";
import { SetUpAgentDialog } from "./set-up";
import { newId } from "./store";

const modelLists = modelState();
export const { takesImages, levelsOf } = modelLists;
export { asGroups } from "../../../shared/session/model";

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
 * The session's model pill [D129, D190]: the list from each agent's last check at once,
 * then fresh [D128]. A pick shows at once as pending and goes to Rust with its op id; the row's `setup_op` reaching that
 * id settles it, and a refusal puts the last value back with Rust's words [D30, D40]. Another agent's model asks
 * "Switch to {name}?" first, and the next message goes to it [D90]. Offline it can't be opened.
 */
/** `locked`: shown, never changed, as a worker's in its own tab [D293]. */
export function useSessionModel(id: string, row: ModelRow | undefined, offline: boolean, locked = false): ReactNode {
  const [chooseAsked, setChooseAsked] = useState(0);
  useEffect(() => {
    const ask = () => setChooseAsked((n) => n + 1);
    askModel.addEventListener("ask", ask);
    return () => askModel.removeEventListener("ask", ask);
  }, []);
  const starting = useStart(id)?.asking === true;
  // The last list any session read names this one's model in its first frame (a fork's), until its own lands.
  const [groups, setGroups] = useState<ModelGroup[] | null>(modelLists.last());
  if (groups) modelLists.keep(groups);
  const [listError, setListError] = useState<string | null>(null);
  const [pending, setPending] = useState<{ op: string; choice: ModelChoice } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [setUp, setSetUp] = useState<string | null>(null);
  const asked = useRef(0);

  const load = () => {
    const mine = ++asked.current;
    loadModels(run, id, {
      list(list, fresh) {
        if (mine !== asked.current) return;
        setGroups((now) => (fresh || now === null ? list : now));
        if (fresh) setListError(null);
      },
      // A new model list can make an offer; Rust works them out on a read [D386].
      refreshed: () => void readRouting().catch(() => {}),
      failed: (cause) => mine === asked.current && setListError(errorText(cause)),
    });
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
  const shown = choiceOf(row);
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
    const line = pickLine(groups, row, choice, op);
    if (line) pick(id, line);
    run(setArgs(id, choice, op)).then(() => settle(id, op), (cause) => {
      // Only this pick's refusal undoes it; a newer pick stands.
      setPending((now) => (now?.op === op ? null : now));
      if (picks.get().get(id)?.op === op) pick(id, null);
      setError(errorText(cause));
    });
  };

  const disabled = offline || starting || groups === null || locked;
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-center justify-end gap-2">
      <ErrorLine error={error ?? listError} className="min-w-0 truncate" />
      {picked && row?.running ? <SwitchAfter key={row.setup_op ?? ""} id={id} name={groups?.find((group) => group.provider === picked.backend)?.label ?? picked.backend} now={picked.now === true} /> : null}
      <ModelPill groups={groups ?? []} value={value} onChange={change} onSetUp={setSetUp} disabled={disabled} asked={chooseAsked} />
      <SetUpAgentDialog
        name={setUp}
        onClose={() => {
          setSetUp(null);
          load();
        }}
      />
    </div>
  );
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
