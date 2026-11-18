import { counted, type ListedSource, latestSession, openProfile, type ProfileImportResult, restartApp } from "../browser/imports";
import { ProfileDisc } from "../browser/profile-mark";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { DialogFooter } from "../components/dialog";
import { useDaemon } from "../daemon";
import { Check, X } from "../icons";
import { FlowHeader } from "./browser-import";

type Mark = "yes" | "no" | "part";

function Tick({ mark }: { mark: Mark }) {
  if (mark === "no") return <X aria-hidden className="size-icon-sm shrink-0 text-destructive" />;
  return <Check aria-hidden className={cx("size-icon-sm shrink-0", mark === "part" ? "text-warning" : "text-success")} />;
}

/** How many profiles came across and how many didn't, for the heading [D746]. */
export function resultSummary(results: readonly ProfileImportResult[]): string {
  const failed = results.filter((result) => result.outcome.type === "failed").length;
  const done = results.length - failed;
  const lines = [done === 0 ? "Nothing was imported." : `${counted(done, "profile", "profiles")} imported.`];
  if (failed > 0) lines.push(`${counted(failed, "profile", "profiles")} couldn't be.`);
  return lines.join(" ");
}

/** What happened to one profile, in one line [D747]. */
function statusOf({ outcome }: ProfileImportResult): { mark: Mark; line: string } {
  if (outcome.type === "failed") return { mark: "no", line: `Couldn't import: ${outcome.message}` };
  if (outcome.siteStorage === "nextStart") return { mark: "part", line: "Finishes when Brigadier restarts" };
  return { mark: "yes", line: "Imported" };
}

function ProfileResult({ result }: { result: ProfileImportResult }) {
  const { profile, choice, replaced } = result;
  const { mark, line } = statusOf(result);
  return (
    <div data-slot="import-result" data-mark={mark} className="flex items-center gap-2.5 px-4 py-3 not-last:border-b not-last:border-divider">
      <ProfileDisc profile={profile} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-label">
          <span className="font-medium">{profile.name}</span>
          <span className="text-quiet-foreground"> ← {choice.name}</span>
        </p>
        <p className={cx("flex items-center gap-1.5 text-xs", mark === "no" ? "text-destructive" : "text-quiet-foreground")}>
          <Tick mark={mark} />
          <span className="min-w-0">{line}</span>
        </p>
      </div>
      <Badge variant="secondary" className="shrink-0 font-normal">
        {replaced ? "Replaced" : "New"}
      </Badge>
    </div>
  );
}

/** Each profile and what happened to it, and a restart when site storage waits for one [D746 D747]. */
export function ProfileImportResults({ source, results, onDone }: { source: ListedSource; results: readonly ProfileImportResult[]; onDone: () => void }) {
  const session = latestSession(useDaemon().rows);
  const first = results.find((result) => result.outcome.type === "done");
  const waiting = results.some(({ outcome }) => outcome.type === "done" && outcome.siteStorage === "nextStart");
  return (
    <>
      <FlowHeader source={source} title={`Imported from ${source.name}`} description={resultSummary(results)} />
      <div data-slot="import-results" className="flex max-h-import-results flex-col overflow-y-auto rounded-settings border border-divider bg-card">
        {results.map((result) => (
          <ProfileResult key={result.choice.id} result={result} />
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
        <Button variant={waiting ? "ghost" : undefined} onClick={onDone}>
          {waiting ? "Later" : "Done"}
        </Button>
        {waiting && <Button onClick={restartApp}>Restart Brigadier</Button>}
      </DialogFooter>
    </>
  );
}
