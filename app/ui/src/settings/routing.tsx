import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import type { ModelGroup } from "../components/composer/model-picker";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Select } from "../components/select";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Switch } from "../components/switch";
import { useDaemon } from "../daemon";
import { errorText, run } from "../onboarding/api";
import { asGroups } from "../session/model";
import { SettingsPage, SettingsSection } from "./parts";
import { type Answer, Jobs } from "./routing-jobs";
import { type Results, YourResults } from "./routing-results";
import { Rules } from "./routing-rules";

/** One place in a job's order (C5); `effort` null is the model's own default. */
export type Entry = { agent: string; model: string; effort: string | null };
/** A rule, added from menus and exact [D338, D341]: never a model, or never above an effort (on one agent, or every one). */
export type Rule = { never: "model"; agent: string; model: string } | { never: "above"; effort: string; agent: string | null };
/** A job: its name, the line agents read to pick it, and the models it tries in order [D383, D387]. */
export type Job = { name: string; for: string; entries: Entry[] };
/** Brigadier's offer, from facts it can see [D383, D386]; `job` null is the quiet line under Jobs. */
export type Offer = { id: string; job: string | null; kind: "newer" | "results" | "mark" | "alias"; title: string; facts: string; done: string };
/** What each job would run now, by its name: its row's line, and each model's quota or why it can't run, by `agent/model`. */
export type Now = Readonly<Record<string, { runs: string; entries: Readonly<Record<string, { text: string | null; off: boolean }>> }>>;
/** Rust's routing table (C5): the jobs in your order, the rules, the review switch, the model images go to first (null: automatic), the open offers and the page's grey lines. */
type Routing = { jobs: Job[]; rules: Rule[]; review: boolean; images?: { agent: string; model: string } | null; offers: Offer[]; notes: { review: string; rules: string }; now?: Now };

/** The page's rows, for Settings search; the page draws these words. */
export const ROUTING_ROWS = {
  jobs: { label: "Jobs", description: "Your agents start each worker on the job that fits. Each job tries its models in your order: the next runs only when one is out of quota or can't run." },
  review: {
    label: "Adversarial review",
    description: "Another company's agent tries to break work that needs it before you get it: a worker's changes that touch security, data, build or dependency files, remove tests, are large, took many tries, or that its author flags; and each plan before it's acted on. Small, ordinary changes, docs, lockfiles and generated files go through without one, and each result says why.",
  },
  images: { label: "Images", description: "Images your agents are asked to make or edit go to this model first, else to another that makes images." },
  rules: { label: "Rules", description: "Every model Brigadier starts follows these" },
  results: { label: "Your results", description: "Per job, how much of each model's work was merged and kept. Credited to the model that really ran." },
} as const;

// Whether an offer on a job is open: the dot on Routing and on the sidebar's Settings [D386]. One reader, no polling.
let offered = false;
const heard = new Set<() => void>();
// The last table, models and results read, so the page paints at once and refreshes quietly [D262, D321].
const kept: { table: Routing | null; groups: ModelGroup[]; results: Results | null } = { table: null, groups: [], results: null };
function note(table: Routing): Routing {
  kept.table = table;
  const now = table.offers.some((offer) => offer.job !== null);
  if (now !== offered) {
    offered = now;
    for (const listener of heard) listener();
  }
  return table;
}
/** Reads the table, keeping the dot; the app calls it at launch and after each model-list refresh. */
export const readRouting = (): Promise<Routing> => run(["routing"]).then((table) => note(table as Routing));
const readModels = () => run(["models", "--all"]).then((models) => (kept.groups = asGroups(models.groups)));
/** At launch: the table and the models the page names, kept for its first paint [D321]. */
export const preloadRouting = () => void Promise.all([readRouting(), readModels()]).catch(() => {});
export const useRoutingDot = (): boolean =>
  useSyncExternalStore(
    (listener) => {
      heard.add(listener);
      return () => heard.delete(listener);
    },
    () => offered,
  );

/**
 * Settings › Routing [D383–D388]: your jobs, each its order always open, Brigadier's offers on them; the adversarial
 * review switch; the rules; your results per job. Pure props: a change shows at once and settles on the table
 * `onChange` or `onOffer` returns, or goes back with Rust's words [D30]. `value` null is loading; `results` null too.
 */
function RoutingPage({
  value,
  groups,
  onChange,
  onOffer,
  error,
  offline = false,
  results,
}: {
  value: Routing | null;
  groups: ModelGroup[];
  onChange: (next: Routing) => Promise<Routing>;
  onOffer: (id: string, answer: Answer) => Promise<Routing>;
  /** What reading the table failed with. */
  error?: string | null;
  /** Brigadier isn't running: the page shows the last table, dimmed. */
  offline?: boolean;
  results: Results | null;
}) {
  // A change in flight, or settled, on the table it was made from; a new table from Rust replaces it.
  const [mine, setMine] = useState<{ base: Routing; shown: Routing } | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Job | null>(null);
  // The editor open: `true` the new job's, a name that job's, null none. A refusal belongs to the one it came from:
  // it goes once another opens or that one closes, not when a failed save puts its editor back [D384, D387].
  const at = draft !== null || editing;
  const [failed, setFailed] = useState<{ text: string; at: typeof at } | null>(null);
  const [seen, setSeen] = useState(at);
  if (seen !== at) {
    setSeen(at);
    if (failed && failed.at !== at) setFailed(null);
  }
  const ops = useRef(0);
  const shown = mine && mine.base === value ? mine.shown : value;
  // True once Rust took it.
  const settle = (next: Routing, send: () => Promise<Routing>): Promise<boolean> => {
    if (!value) return Promise.resolve(false);
    const op = ++ops.current;
    const base = value;
    setMine({ base, shown: next });
    setFailed(null);
    return send().then(
      (back) => {
        if (op === ops.current) setMine({ base, shown: back });
        return true;
      },
      (cause: unknown) => {
        if (op === ops.current) {
          setMine(null);
          setFailed({ text: errorText(cause), at });
        }
        return false;
      },
    );
  };
  const change = (next: Routing) => settle(next, () => onChange(next));
  // The editor shows a refusal in its place; anything else shows over the page.
  const editorOpen = draft !== null || shown?.jobs.some((job) => job.name === editing);
  return (
    <SettingsPage title="Routing" description="Which models do which job, the rules every model follows, and how their work went. Changes apply to new work only.">
      {!shown ? (
        <SettingsCard>
          <SettingsRow label={ROUTING_ROWS.jobs.label} description={error ? undefined : "Loading…"} error={error} />
        </SettingsCard>
      ) : (
        <div className={cx("flex flex-col gap-10", offline && "pointer-events-none opacity-disabled")}>
          <ErrorLine error={(editorOpen ? null : failed?.text) ?? error} />
          <Jobs
            jobs={shown.jobs}
            now={shown.now}
            offers={shown.offers}
            groups={groups}
            failed={editorOpen ? (failed?.text ?? null) : null}
            editing={editing}
            draft={draft}
            onEditing={setEditing}
            onDraft={setDraft}
            onSave={(jobs) => change({ ...shown, jobs })}
            onAnswer={(offer, answer) => settle({ ...shown, offers: shown.offers.filter((other) => other !== offer) }, () => onOffer(offer.id, answer))}
          />
          <SettingsSection setting={ROUTING_ROWS.review.label}>
            <SettingsCard>
              <SettingsRow label={ROUTING_ROWS.review.label} description={ROUTING_ROWS.review.description}>
                <Switch aria-label={ROUTING_ROWS.review.label} checked={shown.review} onCheckedChange={(on) => void change({ ...shown, review: on })} />
              </SettingsRow>
            </SettingsCard>
            <Note>{shown.notes.review}</Note>
          </SettingsSection>
          <SettingsSection setting={ROUTING_ROWS.images.label}>
            <SettingsCard>
              <SettingsRow label={ROUTING_ROWS.images.label} description={ROUTING_ROWS.images.description}>
                <Select
                  label={ROUTING_ROWS.images.label}
                  value={shown.images ? `${shown.images.agent}/${shown.images.model}` : ""}
                  options={[{ value: "", label: "Automatic" }, ...drawing(groups)]}
                  onChange={(key) => {
                    const at = key.indexOf("/");
                    void change({ ...shown, images: key ? { agent: key.slice(0, at), model: key.slice(at + 1) } : null });
                  }}
                />
              </SettingsRow>
            </SettingsCard>
          </SettingsSection>
          <Rules rules={shown.rules} groups={groups} note={shown.notes.rules} onSave={(rules) => void change({ ...shown, rules })} />
          <YourResults results={results} groups={groups} />
        </div>
      )}
    </SettingsPage>
  );
}

/** Only the models that make images, by `agent/model` [D298]. */
const drawing = (groups: ModelGroup[]) =>
  groups.flatMap((group) => group.models.filter((model) => model.draws).map((model) => ({ value: `${group.provider}/${model.id}`, label: model.name, hint: group.label })));

/** A grey line under a card. */
export function Note({ children }: { children: string }) {
  return <p className="px-1 text-label text-quiet-foreground">{children}</p>;
}

/** The page in Settings: Rust's table and models, a change or an offer's answer sent through the routing op, in order [C5, D30]. */
export function RoutingSettings() {
  const online = Boolean(useDaemon().daemon);
  const [value, setValue] = useState<Routing | null>(kept.table);
  const [groups, setGroups] = useState<ModelGroup[]>(kept.groups);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Results | null>(kept.results);
  useEffect(() => {
    if (!online) return;
    setError(null);
    // Your results read every worker's log, so the table never waits on them [D2038].
    run(["routing", "results"]).then((back) => setResults((kept.results = back as Results)), (cause) => setError(errorText(cause)));
    Promise.all([readRouting(), readModels()]).then(
      ([table, models]) => {
        setValue(table);
        setGroups(models);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [online]);
  // One send at a time, in edit order, as settings' own; only the latest one's reply, or the last
  // reply before it when that one fails, becomes the table, so an older one never covers a newer edit.
  const saving = useRef({ chain: Promise.resolve() as Promise<unknown>, latest: 0, kept: null as Routing | null });
  const send = (args: string[]) => {
    const mine = saving.current;
    const n = ++mine.latest;
    const sent = mine.chain.then(() => run(args).then((back) => note(back as Routing)));
    mine.chain = sent.then(
      (back) => (mine.kept = back),
      () => undefined,
    );
    void mine.chain.then(() => n === mine.latest && mine.kept && setValue(mine.kept));
    return sent;
  };
  return (
    <RoutingPage
      value={value}
      groups={groups}
      onChange={(next) => send(["routing", "set", JSON.stringify({ jobs: next.jobs, rules: next.rules, review: next.review, images: next.images ?? null })])}
      onOffer={(id, answer) => send(["routing", "offer", id, answer])}
      error={error}
      offline={!online}
      results={results}
    />
  );
}
