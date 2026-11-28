import type { Row } from "../rows";
import { store } from "../store";
import type { Runner } from "./run";

// Model and effort choice, for both apps [D58]: the lists Rust sends, what a session runs on and the command a pick sends.

/** A model an agent offers, and the effort levels it takes ("low", "xhigh"…). PROPOSED. */
export type Model = {
  id: string;
  name: string;
  efforts: string[];
  defaultEffort?: string;
  /** Being retired, as its CLI's list says: when (ms) and the model it suggests instead, each null where not said. */
  retiring?: { at: number | null; to: string | null } | null;
  /** Whether it takes images, where its CLI says; unknown counts as yes [D2022 #14]. */
  images?: boolean | null;
  /** Whether it runs at the Auto level; unknown counts as yes. */
  auto?: boolean | null;
  /** Whether it makes and edits images with a tool of its own, where its CLI says [D298]. */
  draws?: boolean | null;
  /** What its fast tier offers, where it has one: the Fast switch's tip. */
  fast?: string | null;
  /** An older model its CLI still offers beside a newer one: it waits behind Show more. */
  legacy?: boolean;
};

/**
 * An agent's models, under its name and mark (one SVG from its adapter, as onboarding draws it). `unavailable`: its CLI
 * isn't installed ("install") or isn't signed in ("sign-in"), so it has no models to show yet. PROPOSED.
 */
export type ModelGroup = {
  provider: string;
  label: string;
  /** The short name it goes by ("Claude" for "Claude Code"). */
  short?: string | null;
  mark: string | null;
  models: Model[];
  unavailable?: "install" | "sign-in" | null;
  /** Each signed-in account's limits, where Rust serves them [D337]. */
  usage?: Quota[] | null;
};

/** What the session runs on; `fast` on its model's fast tier. */
export type ModelChoice = { provider: string; model: string; effort: string | null; fast?: boolean };

/**
 * The effort a picked model of `provider` takes: the one clicked, else the one in use for the model in use; within the
 * agent a new model keeps the effort when it has that level, else takes its own default.
 */
export const effortOf = (model: Model, provider: string, value: ModelChoice, inUse: boolean, clicked?: string): string | null =>
  clicked ?? (inUse ? value.effort : provider === value.provider && value.effort && model.efforts.includes(value.effort) ? value.effort : (model.defaultEffort ?? null));

/** An older model, behind Show more: unless it's the one in use or starred. */
export const isOld = (model: Model, inUse: boolean, starred: boolean): boolean => model.legacy === true && !inUse && !starred;

const FAVORITES = "favorite-models";
/** The starred models, "agent/model", kept across launches; the phone's localStorage (state.ts's) may not be there yet, and is empty then. */
export const favorites = store<readonly string[]>(JSON.parse(globalThis.localStorage?.getItem(FAVORITES) ?? "[]"));
/** Stars a model, or takes its star away. */
export function star(key: string): void {
  const now = favorites.get();
  favorites.set(now.includes(key) ? now.filter((each) => each !== key) : [...now, key]);
  localStorage.setItem(FAVORITES, JSON.stringify(favorites.get()));
}

/** One signed-in account's limits as Rust serves them on a model group (C1): `used` and `resets` null where unknown. */
export type Quota = { account: string; name: string; limits: { name: string; used: number | null; resets: number | null }[] };

/** A session's row with what its next turn runs on, from Rust's fold [D129]; `picked` is another agent the next message goes to. */
export type ModelRow = Row & {
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

export type Rust = {
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

/** One Mac's last model list, which names a session's model before its own list comes [D58]. */
export function modelState() {
  let lastGroups: ModelGroup[] | null = null;
  /** Whether a session's model takes images, by the last list read; unknown counts as yes [D2022 #14]. */
  const takesImages = (provider?: string, model?: string | null) =>
    lastGroups?.find((group) => group.provider === provider)?.models.find((each) => each.id === model)?.images !== false;

  /** The levels a model runs at, by `groups` (else the last list read): no Auto where its CLI says it has none. */
  const levelsOf = <Level extends string>(levels: readonly Level[], provider?: string, model?: string | null, groups = lastGroups) => {
    const listed = groups?.find((group) => group.provider === provider)?.models.find((each) => each.id === model);
    return listed?.auto === false ? levels.filter((level) => level !== "auto") : levels;
  };
  return { takesImages, levelsOf, keep: (groups: ModelGroup[]) => void (lastGroups = groups), last: () => lastGroups };
}

/** What the session runs on: the agent picked for its next message, else its own model; null before Rust names one. */
export const choiceOf = (row: ModelRow | undefined): ModelChoice | null =>
  row?.picked
    ? { provider: row.picked.backend, model: row.picked.model, effort: row.picked.effort, fast: row.picked.fast === true }
    : row?.model
      ? { provider: row.backend, model: row.model, effort: row.effort ?? null, fast: row.fast === true }
      : null;

/** The command a pick sends, under its op id. */
export function setArgs(id: string, choice: ModelChoice, op: string): string[] {
  const args = ["set", id, "--agent", choice.provider, "--model", choice.model, "--op", op];
  if (choice.effort) args.push("--effort", choice.effort);
  if (choice.fast) args.push("--fast");
  return args;
}

/** A pick's pending line, named as the picker names them: another agent, or this one picked back, as a switch; none when nothing changes [D76]. */
export function pickLine(groups: ModelGroup[] | null, row: ModelRow | undefined, choice: ModelChoice, op: string): { op: string; from: string | null; to: string; agent?: string } | null {
  const shown = choiceOf(row);
  const group = (provider?: string) => groups?.find((each) => each.provider === provider);
  const name = (provider?: string, model?: string | null) => group(provider)?.models.find((each) => each.id === model)?.name ?? model ?? null;
  const to = name(choice.provider, choice.model) ?? choice.model;
  const agent = choice.provider !== row?.backend || row?.picked ? (group(choice.provider)?.label ?? choice.provider) : undefined;
  return agent || choice.model !== shown?.model ? { op, from: agent ? (group(shown?.provider)?.label ?? null) : name(shown?.provider, shown?.model), to, agent } : null;
}

/**
 * A session's model list: Rust's cached one fills an empty picker only, never replacing a list shown; the fresh one
 * replaces it (`fresh`, then `refreshed`); `failed` only for the fresh one.
 */
export function loadModels(run: Runner, id: string, on: { list: (groups: ModelGroup[], fresh: boolean) => void; refreshed?: () => void; failed: (cause: unknown) => void }): void {
  run(["models", "--session", id]).then((reply) => on.list(asGroups(reply.groups), false), () => {});
  run(["models", "--session", id, "--fresh"]).then((reply) => {
    on.list(asGroups(reply.groups), true);
    on.refreshed?.();
  }, on.failed);
}

/** A project's newest session (any project's, given none), whose model a new chat there starts on [D129]. */
export const latestOf = <T extends Pick<Row, "project" | "sent">>(rows: readonly T[], project?: string): T | undefined =>
  rows.filter((row) => (project ? row.project === project : row.project)).sort((a, b) => b.sent - a.sent)[0];

/**
 * A new chat's model: the one picked, else `last`'s (never its Fast), else the first an agent offers, one on this
 * computer first. Only a fresh list can disprove a pick; cache may offer the first one, never replace it [D129].
 */
export function startModel(picked: ModelChoice | null | undefined, last: Pick<ModelRow, "backend" | "model" | "effort"> | undefined, groups: readonly ModelGroup[] | null | undefined, fresh: boolean): ModelChoice | null {
  const has = (choice: ModelChoice | null | undefined): choice is ModelChoice =>
    Boolean(choice && groups?.some((group) => !group.unavailable && group.provider === choice.provider && group.models.some((each) => each.id === choice.model)));
  const lastChoice = last?.model ? { provider: last.backend, model: last.model, effort: last.effort ?? null } : null;
  const offered = groups?.filter((group) => !group.unavailable).flatMap((group) => group.models.map((each) => ({ group, each })));
  const first = offered?.find(({ each }) => (each as { local?: boolean }).local) ?? offered?.[0];
  const firstChoice = first && { provider: first.group.provider, model: first.each.id, effort: first.each.defaultEffort ?? null };
  return fresh ? ([picked, lastChoice, firstChoice].find(has) ?? null) : (picked ?? lastChoice ?? firstChoice ?? null);
}
