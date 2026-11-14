import { type ModelGroup, ProviderMark } from "../components/composer/model-picker";
import { named } from "../components/composer/model-keys";
import { SettingsCard } from "../components/settings-card";
import { UsageBar } from "../components/usage-bar";
import { SettingsSection } from "./parts";
import { ROUTING_ROWS } from "./routing";

/**
 * Your own outcomes (4.8): per model, how many of its workers succeeded; the adversarial reviews' counts [D2038,
 * D3026]. PROPOSED to W5, whose `["routing", "results"]` serves them.
 */
export type Results = {
  models: { agent: string; model: string; succeeded: number; of: number }[];
  reviews: { count: number; findings: number; fixed: number; rejected: number } | null;
};

/**
 * Your results, in the old Model strength's place and look: each model's success over its sample, then the reviews.
 * Nothing reorders from it; suggestions wait for a few hundred outcomes [D2038]. `results` null is loading.
 */
export function YourResults({ results, groups }: { results: Results | null; groups: readonly ModelGroup[] }) {
  const empty = results && results.models.length === 0 && !results.reviews;
  return (
    <SettingsSection title={ROUTING_ROWS.results.label} description={ROUTING_ROWS.results.description}>
      <SettingsCard inset data-slot="your-results">
        {!results && <p className="py-3 text-xs text-muted-foreground">Reading your results…</p>}
        {empty && <p className="py-3 text-xs text-muted-foreground">No results yet</p>}
        {results?.models.map(({ agent, model, succeeded, of }) => {
          const name = named(groups, agent, model);
          const share = of > 0 ? Math.round((succeeded / of) * 100) : 0;
          const group = groups.find((each) => each.provider === agent);
          return (
            <div key={`${agent}/${model}`} data-slot="result-row" className="flex items-center gap-3.5 py-3">
              <span className="flex min-w-0 flex-1 items-center gap-2.5">
                <ProviderMark mark={group?.mark ?? null} className="size-3.75" />
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-label font-medium text-foreground">
                    {group?.short ?? group?.label ?? agent} · {name}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {succeeded} of {of} succeeded
                  </span>
                </span>
              </span>
              <UsageBar value={share} fill="bg-placeholder" label={`${name}: ${share}% succeeded`} className="w-105 shrink" />
              <span className="w-10 shrink-0 text-end font-mono text-xs font-medium text-foreground">{share}%</span>
            </div>
          );
        })}
        {results?.reviews && (
          <p data-slot="reviews-line" className="py-3 text-label text-foreground">
            {results.reviews.count} reviews · {results.reviews.findings} findings · {results.reviews.fixed} fixed · {results.reviews.rejected} rejected
          </p>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
