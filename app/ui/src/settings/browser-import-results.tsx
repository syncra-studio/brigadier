import { counted, type ListedSource, latestSession, openProfile, type ProfileImportResult, restartApp, signInOn } from "../browser/imports";
import { ProfileDisc } from "../browser/profile-mark";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { DialogFooter } from "../components/dialog";
import { useDaemon } from "../daemon";
import { Check, X } from "../icons";
import { FlowHeader } from "./browser-import";

type Done = Extract<ProfileImportResult["outcome"], { type: "done" }>;
type Mark = "yes" | "no" | "part";

function Tick({ mark }: { mark: Mark }) {
  if (mark === "no") return <X aria-hidden className="size-icon-sm shrink-0 text-destructive" />;
  return <Check aria-hidden className={cx("size-icon-sm shrink-0", mark === "part" ? "text-warning" : "text-success")} />;
}

function PartRow({ mark, name, line }: { mark: Mark; name: string; line: string }) {
  return (
    <div data-slot="import-part" data-mark={mark} className="flex items-center gap-2 py-1">
      <Tick mark={mark} />
      <span className="w-28 shrink-0 text-label">{name}</span>
      <span className={cx("min-w-0 flex-1 text-xs", mark === "no" ? "text-destructive" : "text-quiet-foreground")}>{line}</span>
    </div>
  );
}

function SiteRow({ site, why, onSignIn }: { site: string; why: string; onSignIn: (() => void) | null }) {
  return (
    <div data-slot="import-site" className="flex items-center gap-2 py-1 ps-6">
      <span className="min-w-0 flex-1 truncate text-label">
        {site} <span className="text-xs text-quiet-foreground">· {why}</span>
      </span>
      {onSignIn && (
        <Button variant="soft" size="xs" onClick={onSignIn}>
          Sign in
        </Button>
      )}
    </div>
  );
}

/** What didn't come across, for the heading, in the person's words. */
export function resultSummary(results: readonly ProfileImportResult[]): string {
  const ready = results.filter((result) => result.outcome.type === "done");
  const lines = [ready.length === 0 ? "Nothing came across." : `${counted(ready.length, "profile is", "profiles are")} ready.`];
  for (const { profile, outcome } of results) {
    if (outcome.type === "failed") lines.push(`${profile.name} couldn't be imported.`);
  }
  const sites = ready.reduce((sum, { outcome }) => sum + (outcome as Done).record.skippedDomainCount, 0);
  if (sites > 0) lines.push(`${counted(sites, "site needs", "sites need")} a fresh sign-in.`);
  return lines.join(" ");
}

function ProfileResult({ result, source, session }: { result: ProfileImportResult; source: ListedSource; session: string | null }) {
  const { profile, replaced, outcome } = result;
  const header = (
    <div className="mb-2 flex items-center gap-2.5">
      <ProfileDisc profile={profile} />
      <span className="text-label font-medium">{profile.name}</span>
      <Badge variant="secondary" className="font-normal">
        {replaced ? "Replaced" : "New"}
      </Badge>
    </div>
  );
  if (outcome.type === "failed") {
    return (
      <div data-slot="import-result" className="px-4 py-3 not-last:border-b not-last:border-divider">
        {header}
        <PartRow mark="no" name="Everything" line={outcome.message} />
      </div>
    );
  }
  const { record } = outcome;
  const appBound = new Set(record.appBoundDomains);
  const more = record.skippedDomainCount - record.skippedDomains.length;
  return (
    <div data-slot="import-result" className="px-4 py-3 not-last:border-b not-last:border-divider">
      {header}
      <PartRow
        mark={record.skippedDomainCount > 0 ? "part" : "yes"}
        name="Sign-ins"
        line={`${counted(record.imported, "cookie", "cookies")}${record.skippedDomainCount > 0 ? ` · ${counted(record.skippedDomainCount, "site", "sites")} left out` : ""}`}
      />
      {record.skippedDomains.map((site) => (
        <SiteRow
          key={site}
          site={site}
          why={appBound.has(site) ? `tied to ${source.name} on this device` : "its sign-in couldn't be copied"}
          onSignIn={session ? () => signInOn(session, profile.id, site) : null}
        />
      ))}
      {more > 0 && <p className="ps-6 text-xs text-quiet-foreground">and {counted(more, "more site", "more sites")}</p>}
    </div>
  );
}

/** What each profile brought, each site to sign in to again, and a restart when site storage waits for one. */
export function ProfileImportResults({ source, results, onDone }: { source: ListedSource; results: readonly ProfileImportResult[]; onDone: () => void }) {
  const session = latestSession(useDaemon().rows);
  const first = results.find((result) => result.outcome.type === "done");
  const waiting = results.filter(({ outcome }) => outcome.type === "done" && outcome.siteStorage === "nextStart").map(({ profile }) => profile.name);
  return (
    <>
      <FlowHeader source={source} title={`Imported from ${source.name}`} description={resultSummary(results)} />
      <div data-slot="import-results" className="flex max-h-import-results flex-col overflow-y-auto rounded-settings border border-divider bg-card">
        {results.map((result) => (
          <ProfileResult key={result.choice.id} result={result} source={source} session={session} />
        ))}
      </div>
      {waiting.length > 0 && (
        <p data-slot="import-next-start" className="text-xs text-warning">
          {new Intl.ListFormat("en", { type: "conjunction" }).format(waiting)} {waiting.length === 1 ? "was" : "were"} open, so some sign-ins finish when Brigadier restarts. Your
          sessions keep running.
        </p>
      )}
      <DialogFooter>
        {first && session && (
          <Button
            variant="ghost"
            onClick={() => {
              onDone();
              openProfile(session, first.profile.id);
            }}
          >
            Open {first.profile.name}
          </Button>
        )}
        <Button variant={waiting.length > 0 ? "ghost" : undefined} onClick={onDone}>
          {waiting.length > 0 ? "Later" : "Done"}
        </Button>
        {waiting.length > 0 && <Button onClick={restartApp}>Restart Brigadier</Button>}
      </DialogFooter>
    </>
  );
}
