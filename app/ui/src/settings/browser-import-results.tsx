import { counted, type ImportWhat, type ListedSource, latestSession, openProfile, passwordsRetryable, type ProfileImportResult, signInOn } from "../browser/imports";
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

function PartRow({ mark, name, line, onRetry }: { mark: Mark; name: string; line: string; onRetry?: (() => void) | undefined }) {
  return (
    <div data-slot="import-part" data-mark={mark} className="flex items-center gap-2 py-1">
      <Tick mark={mark} />
      <span className="w-28 shrink-0 text-label">{name}</span>
      <span className={cx("min-w-0 flex-1 text-xs", mark === "no" ? "text-destructive" : "text-quiet-foreground")}>{line}</span>
      {onRetry && (
        <Button variant="ghost" size="xs" className="-my-1" onClick={onRetry}>
          Try again
        </Button>
      )}
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

/** What didn't come across, for the heading: "Passwords for Side project", in the person's words. */
export function resultSummary(results: readonly ProfileImportResult[]): string {
  const ready = results.filter((result) => result.outcome.type === "done");
  const lines = [ready.length === 0 ? "Nothing came across." : `${counted(ready.length, "profile is", "profiles are")} ready.`];
  for (const { profile, outcome } of results) {
    if (outcome.type === "failed") lines.push(`${profile.name} couldn't be imported.`);
    else {
      const parts = [outcome.passwordsError && "Passwords", outcome.bookmarksError && "Bookmarks", outcome.historyError && "History"].filter(Boolean);
      if (parts.length > 0) lines.push(`${parts.join(" and ")} for ${profile.name} didn't come across.`);
    }
  }
  const sites = ready.reduce((sum, { outcome }) => sum + (outcome as Done).record.skippedDomainCount, 0);
  if (sites > 0) lines.push(`${counted(sites, "site needs", "sites need")} a fresh sign-in.`);
  return lines.join(" ");
}

function ProfileResult({ result, source, session, onRetry }: { result: ProfileImportResult; source: ListedSource; session: string | null; onRetry: (part: keyof ImportWhat) => void }) {
  const { profile, replaced, what, outcome } = result;
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
      {what.signIns && (
        <>
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
          {outcome.siteStorage === "nextStart" && (
            <p data-slot="import-next-start" className="ps-6 text-xs text-quiet-foreground">
              Sites that keep their sign-in in page storage catch up when Brigadier next starts.
            </p>
          )}
        </>
      )}
      {what.history && (
        <PartRow mark={outcome.historyError ? "no" : "yes"} name="History" line={outcome.historyError ?? counted(record.history, "page", "pages")} onRetry={outcome.historyError ? () => onRetry("history") : undefined} />
      )}
      {what.bookmarks && (
        <PartRow
          mark={outcome.bookmarksError ? "no" : "yes"}
          name="Bookmarks"
          line={outcome.bookmarksError ?? counted(record.bookmarks, "bookmark", "bookmarks")}
          onRetry={outcome.bookmarksError ? () => onRetry("bookmarks") : undefined}
        />
      )}
      {what.passwords && (
        <PartRow
          mark={outcome.passwordsError ? "no" : record.passwordsKept || record.passwordsSkipped > 0 ? "part" : "yes"}
          name="Passwords"
          line={
            outcome.passwordsError ??
            (record.passwordsKept ? `None from ${source.name} could be used, so this profile kept its own` : undefined) ??
            `${counted(record.passwords, "password", "passwords")}${record.passwordsSkipped > 0 ? ` · ${counted(record.passwordsSkipped, "left out", "left out")}` : ""}`
          }
          onRetry={outcome.passwordsError && passwordsRetryable(source.family) ? () => onRetry("passwords") : undefined}
        />
      )}
    </div>
  );
}

/** What each profile brought, part by part: what failed with Try again, each site to sign in to again. */
export function ProfileImportResults({ source, results, onRetry, onDone }: { source: ListedSource; results: readonly ProfileImportResult[]; onRetry: (index: number, part: keyof ImportWhat) => void; onDone: () => void }) {
  const session = latestSession(useDaemon().rows);
  const first = results.find((result) => result.outcome.type === "done");
  return (
    <>
      <FlowHeader source={source} title={`Imported from ${source.name}`} description={resultSummary(results)} />
      <div data-slot="import-results" className="flex max-h-import-results flex-col overflow-y-auto rounded-settings border border-divider bg-card">
        {results.map((result, index) => (
          <ProfileResult key={result.choice.id} result={result} source={source} session={session} onRetry={(part) => onRetry(index, part)} />
        ))}
      </div>
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
        <Button onClick={onDone}>Done</Button>
      </DialogFooter>
    </>
  );
}
