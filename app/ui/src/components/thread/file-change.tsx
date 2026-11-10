import { useDaemon, useThread } from "../../daemon";
import { openReview } from "../../panel/open";
import type { FileChange, Progress } from "../../thread/item";
import { CodeBlock } from "../../thread/code";
import { CopyButton } from "../copy-button";
import { cx } from "../cx";
import { OpeningRow, ROW, StepIcon, Words } from "./activity-row";

export const FILE_VERBS: Record<FileChange["change"], [string, string, string]> = {
  added: ["Creating", "Created", "create"],
  modified: ["Editing", "Edited", "edit"],
  deleted: ["Deleting", "Deleted", "delete"],
  renamed: ["Renaming", "Renamed", "rename"],
};

/** A diff past this many lines isn't drawn. */
const MAX_DIFF_LINES = 5000;

export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * One changed file: "Edited blocks.ts", then its counts (+7 −2, coloured while hovered) and a dot for a
 * created (blue) or deleted (red) file. A finished one opens to its diff; one without a diff doesn't open. A declined change reads "Rejected".
 */
export function FileChangeRow({ keep, change, progress }: { keep: string; change: FileChange; progress: Progress }) {
  const { added, removed } = change;
  const running = progress === "running" || progress === "pending";
  const name = fileName(change.path);
  const [doing, done, waiting] = FILE_VERBS[change.change];
  const object = change.change === "renamed" && change.from ? `${fileName(change.from)} to ${name}` : name;
  const head = (
    <>
      <StepIcon kind="edit" />
      {progress === "pending" ? (
        <Words verb={`Waiting to ${waiting}`} object={object} />
      ) : progress === "cancelled" ? (
        <Words verb="Rejected" object={name} />
      ) : (
        <Words verb={running ? doing : done} object={progress === "failed" ? `${object} — failed` : object} live={progress === "running"} />
      )}
    </>
  );
  if (running) return <div className={ROW}>{head}</div>;
  const trail = (
    <>
      {added !== null && removed !== null && <Counts added={added} removed={removed} quiet />}
      {change.change === "added" && <span className="size-1.5 rounded-capsule bg-link" />}
      {change.change === "deleted" && <span className="size-1.5 rounded-capsule bg-destructive" />}
    </>
  );
  if (change.diff === null)
    return (
      <div className={ROW}>
        {head}
        <span className="ms-1 flex shrink-0 items-center gap-1.5">{trail}</span>
      </div>
    );
  return (
    <OpeningRow keep={keep} trail={trail} detail={<DiffCard keep={keep} change={change} diff={change.diff} />}>
      {head}
    </OpeningRow>
  );
}

/** "+7 −2". Quiet: grey until its row is hovered; a zero stays grey. */
function Counts({ added, removed, quiet = false }: { added: number; removed: number; quiet?: boolean }) {
  const plus = added === 0 ? undefined : quiet ? "group-hover:text-success" : "text-success";
  const minus = removed === 0 ? undefined : quiet ? "group-hover:text-destructive" : "text-destructive";
  return (
    <span className={cx("shrink-0 tabular-nums", quiet ? "font-mono text-xs" : "text-xs text-muted-foreground")}>
      <span className={plus}>+{added}</span> <span className={minus}>−{removed}</span>
    </span>
  );
}

/**
 * A file's diff: its name, which opens it in the Review tab, counts and copy over the lines, added green, removed red. The thread's code block
 * draws it (coloured once it settles, folded past 14 lines), in the diff card's frame.
 */
export function DiffCard({ keep, change, diff: text }: { keep: string; change: FileChange; diff: string }) {
  const { added, removed } = change;
  const diff = text.replace(/\n$/, "");
  const count = diff ? diff.split("\n", MAX_DIFF_LINES + 1).length : 0;
  const id = useThread()?.id;
  // A chat with no project has no checkout to review in.
  const session = useDaemon().rows?.find((row) => row.id === id)?.project ? id : undefined;
  // Its name opens the file's diff in the Review tab [D1038].
  const title = (
    <>
      <button type="button" title={`Review ${change.path}`} disabled={!session} onClick={() => session && openReview(session, change.path)} className="min-w-0 cursor-pointer truncate rounded-control hover:underline focus-visible:focus-ring disabled:cursor-default disabled:no-underline">
        {fileName(change.path)}
      </button>
      {added !== null && removed !== null && <Counts added={added} removed={removed} />}
    </>
  );
  const empty = count === 0 ? (change.change === "deleted" ? "Contents deleted" : "No changes") : count > MAX_DIFF_LINES ? "Diff too large to preview" : null;
  if (empty === null) return <CodeBlock code={diff} language="diff" keep={`${keep}:diff`} title={title} look="diff" />;
  return (
    <div className="mt-1 flex min-w-0 flex-col overflow-clip rounded-shell border border-border">
      <div className="flex min-h-8 items-center gap-2 bg-fill-subtle ps-3 pe-1 text-sm text-action-hover">
        {title}
        {count > 0 && <CopyButton text={text} tooltip="Copy diff" size="icon-xs" className="ms-auto" />}
      </div>
      <p className="px-3 py-2 text-sm text-muted-foreground">{empty}</p>
    </div>
  );
}
