import { useEffect, useRef, useState } from "react";

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

/**
 * The session's model pill [D129, D190]: the list from each agent's last check at once, then fresh [D128]. A pick shows
 * at once as pending and goes to Rust with its op id; the row's `setup_op` reaching that id settles it, and a refusal
 * puts the last value back with Rust's words [D30, D40]. Another agent's model asks "Switch to {name}?" first, and the
 * next message goes to it [D90]. Offline it can't be opened.
 */
export function SessionModel({ id, row, offline }: { id: string; row: ModelRow | undefined; offline: boolean }) {
  const starting = useStart(id)?.asking === true;
  const [groups, setGroups] = useState<ModelGroup[] | null>(null);
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
    // Home opens this view before Rust has made the session and its worktree.
    if (!offline && !starting) load();
    return () => { asked.current++; };
  }, [id, offline, starting]);

  // Settled once Rust's row has taken it.
  if (pending && row?.setup_op === pending.op) setPending(null);

  const picked = row?.picked;
  const shown: ModelChoice | null = picked
    ? { provider: picked.backend, model: picked.model, effort: picked.effort }
    : row?.model
      ? { provider: row.backend, model: row.model, effort: row.effort ?? null }
      : null;
  const value = pending?.choice ?? shown;

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
      <ModelPicker groups={groups ?? []} value={value} onChange={change} onSetUp={setSetUp} disabled={offline || groups === null} />
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
