import { EmptyState } from "../components/empty-state";
import { useDaemon } from "../daemon";
import { CardSection } from "../panel/card";
import { openPr } from "../panel/open";
import { Note, PrLine } from "../panel/source/rows";
import { useSecond } from "../thread/words";
import { PullRequestOpen } from "./icons";
import { ago } from "./pr-words";

/**
 * The session's pull requests, when it has several [D205]: the card's PR rows on a page, open ones first, each opening
 * its PR [D175]. Straight from the watch's last read; its age and, when the last read failed, why [D1009].
 */
export function PrList({ owner }: { owner: string }) {
  const { daemon, rows } = useDaemon();
  const kept = rows?.find((row) => row.id === owner)?.prs;
  const now = useSecond(true);
  const prs = kept?.prs ?? [];
  const open = prs.filter((pr) => pr.state === "open");
  const done = prs.filter((pr) => pr.state !== "open");
  const section = (title: string, list: typeof prs) =>
    list.length > 0 && (
      <CardSection title={title}>
        {list.map((pr) => (
          <PrLine key={pr.number} pr={pr} onClick={() => openPr(owner, pr.number)} />
        ))}
      </CardSection>
    );
  return (
    <div data-slot="pr-list" className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-reading flex-col gap-3 py-5">
        <header className="flex flex-col gap-1 px-5">
          <h2 className="font-display text-base font-medium">Pull requests</h2>
          <p className="text-xs text-muted-foreground">
            {!daemon ? "Reconnecting…" : rows === undefined ? "Loading…" : kept?.okAt ? `Checked ${ago(kept.okAt, now)}` : "Not checked yet"}
          </p>
        </header>
        {kept?.error && (
          <div className="px-5">
            <Note warn text={`Couldn't check · ${kept.error.split("\n")[0]}`} />
          </div>
        )}
        {rows !== undefined && prs.length === 0 ? (
          <EmptyState variant="centered" icon={PullRequestOpen} title="No pull requests yet" detail="The ones this session opens or works on show here" />
        ) : (
          <div className="flex flex-col">
            {section("Open", open)}
            {section("Merged and closed", done)}
          </div>
        )}
      </div>
    </div>
  );
}
