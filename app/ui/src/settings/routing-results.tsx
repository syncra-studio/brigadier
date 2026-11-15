import { type ModelGroup, ProviderMark } from "../components/composer/model-picker";
import { SettingsCard } from "../components/settings-card";
import { UsageBar } from "../components/usage-bar";
import { SettingsSection } from "./parts";
import { Note, ROUTING_ROWS } from "./routing";

/** Runs from which a share is drawn: fewer are too few to compare (spec §8). */
const COMPARED = 20;

type Model = { agent: string; model: string; name: string; kept: number | null; of: number; finished: number; retried: number };
/**
 * Your own outcomes per job, then per model, credited to the model that really ran (C5): `job` null is Named model;
 * `kept` null, a job whose workers make no commits. The adversarial reviews' counts [D2038, D3026].
 */
export type Results = {
  jobs: { job: string | null; models: Model[] }[];
  reviews: { count: number; findings: number | null; fixed: number | null; rejected: number | null } | null;
};

/** Your results, grouped by job (spec §8): a share from 20 runs, counts below it. Nothing reorders from it [D2038]. `results` null is loading. */
export function YourResults({ results, groups }: { results: Results | null; groups: readonly ModelGroup[] }) {
  const empty = results && results.jobs.length === 0 && !results.reviews;
  return (
    <SettingsSection title={ROUTING_ROWS.results.label} description={ROUTING_ROWS.results.description} setting={ROUTING_ROWS.results.label}>
      <SettingsCard inset data-slot="your-results">
        {!results && <p className="py-3 text-xs text-muted-foreground">Reading your results…</p>}
        {empty && <p className="py-3 text-xs text-muted-foreground">No results yet</p>}
        {results?.jobs.map(({ job, models }) => (
          <div key={job ?? ""} data-slot="result-job" className="flex flex-col pt-3.5 pb-1.5">
            <p className="text-xs font-medium text-quiet-foreground">{job ?? "Named model"}</p>
            {models.map((each) => (
              <ResultRow key={`${each.agent}/${each.model}`} {...each} group={groups.find((group) => group.provider === each.agent)} />
            ))}
          </div>
        ))}
        {results?.reviews && (
          <p data-slot="reviews-line" className="py-3 text-label text-foreground">
            {reviewsLine(results.reviews)}
          </p>
        )}
      </SettingsCard>
      <Note>Kept: finished with commits that are in its parent's branch, never retried or reverted. A percentage shows from 20 runs. Jobs get different work, so compare models within a job.</Note>
    </SettingsSection>
  );
}

/** "✻ Claude · Opus 5.5  21 of 24 kept ▬▬▬ 88%"; below 20 runs, "5 of 7 kept · too few to compare"; no commits, "9 finished · 1 retried". */
function ResultRow({ agent, name, kept, of, finished, retried, group }: Model & { group: ModelGroup | undefined }) {
  const share = kept !== null && of >= COMPARED ? Math.round((kept / of) * 100) : null;
  const counts =
    kept === null ? [finished > 0 && `${finished} finished`, retried > 0 && `${retried} retried`].filter(Boolean).join(" · ") : `${kept} of ${of} kept${share === null ? " · too few to compare" : ""}`;
  return (
    <div data-slot="result-row" className="flex items-center gap-3.5 py-2">
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <ProviderMark mark={group?.mark ?? null} className="size-3.75" />
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-label font-medium text-foreground">
            {group?.short ?? group?.label ?? agent} · {name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{counts}</span>
        </span>
      </span>
      {share !== null && (
        <>
          <UsageBar value={share} fill="bg-placeholder" label={`${name}: ${share}% kept`} className="w-60 shrink" />
          <span className="w-10 shrink-0 text-end font-mono text-xs font-medium text-foreground">{share}%</span>
        </>
      )}
    </div>
  );
}

/** "2 reviews · 5 findings · 3 fixed": a count no review said is left out, never 0 [D74]. */
function reviewsLine({ count, findings, fixed, rejected }: NonNullable<Results["reviews"]>) {
  const n = (v: number | null, one: string, many = one) => (v === null ? null : `${v} ${v === 1 ? one : many}`);
  return [n(count, "review", "reviews"), n(findings, "finding", "findings"), n(fixed, "fixed"), n(rejected, "rejected")].filter(Boolean).join(" · ");
}
