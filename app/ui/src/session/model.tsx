import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { ErrorLine } from "../components/error-line";
import { type ModelChoice, type ModelGroup, ModelPicker } from "../components/composer/model-picker";
import type { Row } from "../daemon";
import { useStart } from "../home/start";
import { errorText, run } from "../onboarding/api";
import { SetUpAgentDialog } from "./set-up";
import { newId } from "./store";

/** A session's row with what its next turn runs on, from Rust's fold [D129]; `picked` is another agent the next message goes to. */
type ModelRow = Row & {
  model?: string | null;
  effort?: string | null;
  picked?: { backend: string; model: string; effort: string | null } | null;
  /** The last `set` Rust took, by the app's op id [D30]. */
  setup_op?: string | null;
};

type Rust = { provider: string; label: string; mark: string | null; unavailable: "install" | "sign-in" | null; models: { id: string; name: string; efforts: string[]; default_effort: string | null }[] };

/** Rust's groups in the kit picker's shape. */
export const asGroups = (groups: Rust[]): ModelGroup[] =>
  groups.map((group) => ({ ...group, models: group.models.map(({ default_effort, ...model }) => ({ ...model, defaultEffort: default_effort ?? undefined })) }));

let lastGroups: ModelGroup[] | null = null;
/** Whether a session's model takes images, by the last list read; unknown counts as yes [D2022 #14]. */
export const takesImages = (provider?: string, model?: string | null) =>
  lastGroups?.find((group) => group.provider === provider)?.models.find((each) => each.id === model)?.images !== false;

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
 * The session's model pill [D129, D190]: the list from each agent's last check at once, then fresh [D128]. A pick shows
 * at once as pending and goes to Rust with its op id; the row's `setup_op` reaching that id settles it, and a refusal
 * puts the last value back with Rust's words [D30, D40]. Another agent's model asks "Switch to {name}?" first, and the
 * next message goes to it [D90]. Offline it can't be opened.
 */
export function SessionModel({ id, row, offline }: { id: string; row: ModelRow | undefined; offline: boolean }) {
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
    run(["models", "--session", id, "--fresh"]).then((reply) => land(reply, true), fail);
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
    ? { provider: picked.backend, model: picked.model, effort: picked.effort }
    : row?.model
      ? { provider: row.backend, model: row.model, effort: row.effort ?? null }
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
    const args = ["set", id, "--agent", choice.provider, "--model", choice.model, "--op", op];
    run(choice.effort ? [...args, "--effort", choice.effort] : args).catch((cause) => {
      // Only this pick's refusal undoes it; a newer pick stands.
      setPending((now) => (now?.op === op ? null : now));
      setError(errorText(cause));
    });
  };

  if (!value) return null;
  return (
    <div className="flex min-w-0 items-center justify-end gap-2">
      <ErrorLine error={error ?? listError} className="min-w-0 truncate" />
      <ModelPicker groups={groups ?? []} value={value} onChange={change} onSetUp={setSetUp} disabled={offline || starting || groups === null} asked={chooseAsked} />
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
