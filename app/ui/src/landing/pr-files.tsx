import { memo, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";

import { Button } from "../components/button";
import { ConfirmForm } from "../components/confirm-dialog";
import { Dialog, DialogContent } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { NavRow } from "../components/nav";
import { Radio, RadioGroup } from "../components/radio";
import { Segmented } from "../components/segmented";
import { Skeleton } from "../components/skeleton";
import { Textarea } from "../components/textarea";
import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { ChevronDown, ChevronRight, Folder } from "../icons";
import { FileIcon } from "../icons/file-types";
import type { Sides } from "../review/diff-view";
import { FileSection } from "../review/file-section";
import type { DiffComment } from "../review/types";
import { SearchField } from "../settings/archived-toolbar";
import { Markdown } from "../thread/markdown";
import { useHost } from "./host";
import type { PrFiles as Files, PullRequest } from "./pull-requests";
import { FRESH_MS } from "./pr-words";

const NONE = () => {};
const LOOK = { numbered: true, split: false, wrap: true, words: true, columns: true };
const COUNT = "rounded-capsule bg-muted px-1.5 text-xs text-muted-foreground tabular-nums";

type File = Files["files"][number];
type Event = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** A review being written: its line comments, the commit they were made on, and its words, until it's submitted. */
export type Draft = { comments: readonly DiffComment[]; head?: string; body: string };
// shortcut: kept while the app runs, not through a restart; keep it in the session's folder if that's missed.
export const drafts = new Map<string, Draft>();
const NO_COMMENTS: readonly DiffComment[] = [];
// Files drawn at first and on each Load more, a page at a time [D657]: 524 diffs at once took 4 s to draw.
const PAGE = 25;

/**
 * A PR's Files changed, any PR's, as GitHub's page [D231, D262]: its file tree with a filter on the left, each file's
 * diff in a card, a page at a time with Load more at the end [D657]; Submit review sits in the tab's bar. Read from its
 * host through Rust: when the tab is first opened, its last read kept beside the page's and painted at once on the
 * next, read again when the head moved, when it's older than the watch's pace, on Check again (`tick`) and on Refresh.
 * A file's folded lines open from both its sides, read when first opened. A line's + leaves a comment that goes with
 * the review; a list the host cut says so, with the rest on the host.
 */
export function PrFiles({
  owner,
  target,
  pr,
  tick,
  draft,
  onDraft,
  onOpen,
}: {
  owner: string;
  target: string;
  pr: PullRequest;
  tick: number;
  draft: Draft;
  /** Stable: the file cards keep it. */
  onDraft: (next: SetStateAction<Draft>) => void;
  onOpen: () => void;
}) {
  const { daemon } = useDaemon();
  const host = useHost(owner);
  const [files, setFiles] = useState<Files | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = useRef<Files | null>(null);
  const seen = useRef(tick);
  const at = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const land = (next: Files) => {
    shown.current = next;
    setFiles(next);
  };
  const read = () => {
    const mine = ++at.current;
    ask({ op: "run", args: ["host", host, "files", target] }, (reply) => {
      if (at.current !== mine) return;
      if (reply.ok) {
        land(reply.files);
        setError(null);
      } else if (reply.error !== "disconnected") {
        // The last read stays on screen with why [D1009].
        setError(String(reply.error));
      }
    });
  };
  const fresh = (got: Files | null) => got && got.head === pr.head && Date.now() - got.checkedAtMs < FRESH_MS;
  useEffect(() => {
    if (!daemon) return;
    const forced = seen.current !== tick;
    seen.current = tick;
    if (shown.current) return void ((forced || !fresh(shown.current)) && read());
    ask({ op: "run", args: ["host", host, "files", target, "kept"] }, (reply) => {
      const kept: Files | null = reply.ok ? reply.files : null;
      if (kept && !shown.current) land(kept);
      if (!fresh(shown.current)) read();
    });
  }, [daemon, host, target, pr.head, tick]);

  // The same for every card, so a toggle draws only the card it changed.
  const acts = useMemo<Acts>(
    () => ({
      toggle: (path) => setFolded((now) => (now.has(path) ? new Set([...now].filter((each) => each !== path)) : new Set(now).add(path))),
      sides: (path) =>
        new Promise<Sides>((resolve, reject) =>
          ask({ op: "run", args: ["host", host, "sides", target, path] }, (reply) => {
            if (reply.ok) return resolve(reply.sides);
            showToast(`Couldn't open ${path}'s other lines: ${String(reply.error)}`, { tone: "error" });
            reject(new Error(String(reply.error)));
          }),
        ),
      // A review's line comments are pinned to the commit the first was made on, whatever the diff reads after.
      comment: (comment) => onDraft((now) => ({ ...now, head: now.comments.length ? now.head : shown.current?.head, comments: [...now.comments, comment] })),
      remove: (id) => onDraft((now) => ({ ...now, comments: now.comments.filter((comment) => comment.id !== id) })),
    }),
    [host, target, onDraft],
  );
  const byPath = useMemo(() => Map.groupBy(draft.comments, (comment) => comment.path), [draft.comments]);
  // A file past the pages drawn so far brings the pages up to it, the ones it skips folded: one diff drawn, not hundreds.
  const go = (path: string) => {
    const all = files?.files ?? [];
    const at = all.findIndex((file) => file.path === path);
    const to = at >= limit ? Math.ceil((at + 1) / PAGE) * PAGE : limit;
    flushSync(() => {
      setCurrent(path);
      setFolded((now) => new Set([...now, ...all.slice(limit, to).map((file) => file.path)].filter((each) => each !== path)));
      setLimit(to);
    });
    const card = () => list.current?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start" });
    card();
    // Again once the cards it passed have drawn, which moves it.
    requestAnimationFrame(() => requestAnimationFrame(card));
  };
  const cut = files && files.total > files.files.length;

  return (
    <div data-slot="pr-files" className="flex min-h-0 flex-1 gap-4 px-5 pt-3">
      <FileTree files={files?.files ?? []} current={current} onPick={go} />
      <div className="flex min-w-0 flex-1 flex-col">
        <ErrorLine size="sm" error={error} className="shrink-0 pb-3" />
        <div ref={list} data-slot="pr-diffs" className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto pb-5">
          {!files ? (
            !error && <FilesLoading />
          ) : files.files.length === 0 ? (
            <p className="text-sm text-muted-foreground">No changes</p>
          ) : (
            files.files
              .slice(0, limit)
              .map((file) => <PrFile key={file.path} file={file} collapsed={folded.has(file.path)} connected={Boolean(daemon)} comments={byPath.get(file.path) ?? NO_COMMENTS} acts={acts} />)
          )}
          {files && limit < files.files.length && (
            <Button variant="soft" size="sm" className="self-start" onClick={() => setLimit((now) => now + PAGE)}>
              Load more
            </Button>
          )}
          {cut && (
            <p className="text-sm text-muted-foreground">
              Showing {files.files.length} of {files.total} files ·{" "}
              <button type="button" className="cursor-pointer underline-offset-2 hover:underline" onClick={onOpen}>
                See the rest on {pr.host}
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

type Acts = { toggle: (path: string) => void; sides: (path: string) => Promise<Sides>; comment: (comment: DiffComment) => void; remove: (id: string) => void };

/** One file's card, drawn again only when its own fold, comments or connection change. */
const PrFile = memo(function PrFile({ file, collapsed, connected, comments, acts }: { file: File; collapsed: boolean; connected: boolean; comments: readonly DiffComment[]; acts: Acts }) {
  return (
    <FileSection
      card
      file={file}
      contents={file}
      look={LOOK}
      collapsed={collapsed}
      onToggle={() => acts.toggle(file.path)}
      connected={connected}
      onRetry={NONE}
      onSides={() => acts.sides(file.path)}
      comments={comments}
      onComment={acts.comment}
      onRemoveComment={acts.remove}
    />
  );
});

function FilesLoading() {
  return (
    <div data-slot="pr-files-loading" className="flex flex-col gap-3">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-24 w-full" />
      ))}
    </div>
  );
}

type Node = { name: string; path: string; file?: File; children: Node[] };

/** The files as GitHub's tree: folders first, a folder holding one folder alone shown as one row (`a/b`). */
function treeOf(files: readonly File[]): Node[] {
  const root: Node = { name: "", path: "", children: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let at = root;
    parts.forEach((name, index) => {
      const path = parts.slice(0, index + 1).join("/");
      if (index === parts.length - 1) return void at.children.push({ name, path, file, children: [] });
      let next = at.children.find((child) => !child.file && child.path === path);
      if (!next) at.children.push((next = { name, path, children: [] }));
      at = next;
    });
  }
  const squash = (node: Node): Node => {
    const children = node.children.map(squash).sort((a, b) => Number(Boolean(a.file)) - Number(Boolean(b.file)) || a.name.localeCompare(b.name));
    const only = children.length === 1 && !children[0].file ? children[0] : null;
    return only && node.name ? { ...only, name: `${node.name}/${only.name}` } : { ...node, children };
  };
  return squash(root).children;
}

/** The changed files as a tree, folders folding, the filter narrowing it to the paths that hold its words; a file's row brings its diff into view. */
function FileTree({ files, current, onPick }: { files: readonly File[]; current: string | null; onPick: (path: string) => void }) {
  const [filter, setFilter] = useState("");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const words = filter.trim().toLowerCase();
  const tree = useMemo(() => treeOf(words ? files.filter((file) => file.path.toLowerCase().includes(words)) : files), [files, words]);
  const rows = (nodes: Node[]) =>
    nodes.map((node) => {
      if (node.file) {
        return (
          <NavRow key={node.path} data-active={current === node.path || undefined} title={node.path} onClick={() => onPick(node.path)}>
            <FileIcon name={node.path} />
            <span className="truncate">{node.name}</span>
          </NavRow>
        );
      }
      // A filter shows every folder that holds what it found.
      const open = Boolean(words) || !closed.has(node.path);
      return (
        <div key={node.path}>
          <NavRow aria-expanded={open} title={node.path} onClick={() => setClosed((now) => (now.has(node.path) ? new Set([...now].filter((each) => each !== node.path)) : new Set(now).add(node.path)))}>
            {open ? <ChevronDown /> : <ChevronRight />}
            <Folder />
            <span className="truncate">{node.name}</span>
          </NavRow>
          {open && <div className="ps-3">{rows(node.children)}</div>}
        </div>
      );
    });
  return (
    <nav aria-label="Changed files" className="flex w-64 shrink-0 flex-col gap-2 pb-5">
      <div className="flex shrink-0">
        <SearchField label="Filter files…" value={filter} onChange={setFilter} />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {files.length > 0 && tree.length === 0 ? <p className="px-2 py-1 text-sm text-muted-foreground">No files match</p> : rows(tree)}
      </div>
    </nav>
  );
}

const EVENTS: { value: Event; label: string; open: string; landed: string }[] = [
  { value: "COMMENT", label: "Comment", open: "Submit general feedback without explicit approval.", landed: "Submit general feedback without explicit approval." },
  { value: "APPROVE", label: "Approve", open: "Submit feedback and approve merging these changes.", landed: "Submit feedback and record your approval of these merged changes." },
  {
    value: "REQUEST_CHANGES",
    label: "Request changes",
    open: "Submit feedback that must be addressed before merging.",
    landed: "Submit feedback suggesting follow-up changes.",
  },
];

/**
 * Submit review, as GitHub's: its words (Write or Preview), Comment, Approve or Request changes, and the line
 * comments left on the diff, sent together through the user's gh [D262]. The dialog stays while it's sent and says
 * why it wasn't; once sent, the page is read again.
 */
export function SubmitReview({
  owner,
  target,
  pr,
  head,
  draft,
  onDraft,
  onReviewed,
}: {
  owner: string;
  target: string;
  pr: PullRequest;
  /** The commit the review is pinned to: its line comments' when it has some, else the PR's as read. */
  head: string | null;
  draft: Draft;
  onDraft: (draft: Draft) => void;
  onReviewed: () => void;
}) {
  const { daemon } = useDaemon();
  const host = useHost(owner);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"write" | "preview">("write");
  const [event, setEvent] = useState<Event>("COMMENT");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const n = draft.comments.length;
  // GitHub refuses a comment or a change request with nothing in it.
  const empty = event !== "APPROVE" && !draft.body.trim() && n === 0;
  const submit = () => {
    if (!head) return;
    setBusy(true);
    setError(null);
    const review = { event, body: draft.body.trim(), head, comments: draft.comments };
    ask({ op: "run", args: ["host", host, "review", target, JSON.stringify(review)] }, (reply) => {
      setBusy(false);
      if (!reply.ok) return setError(reply.error === "disconnected" ? "Brigadier isn't running. Try again once it's back." : String(reply.error));
      onDraft({ comments: [], body: "" });
      setOpen(false);
      showToast(`Review submitted on #${pr.number}`, { tone: "success" });
      onReviewed();
    });
  };
  return (
    <>
      <Button size="sm" disabled={!head} onClick={() => setOpen(true)}>
        Submit review
        {n > 0 && <span className={COUNT}>{n}</span>}
      </Button>
      <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
        <DialogContent>
          <ConfirmForm
            title="Finish your review"
            description={n > 0 ? `Sent to ${pr.host} as you, with ${n} line ${n === 1 ? "comment" : "comments"}.` : `Sent to ${pr.host} as you.`}
            confirm="Submit review"
            busy={busy}
            disabled={empty || !daemon || !head}
            onConfirm={submit}
            onCancel={() => setOpen(false)}
          >
            <div className="flex flex-col gap-2">
              <Segmented
                label="Write or preview"
                value={tab}
                options={[
                  { value: "write", label: "Write" },
                  { value: "preview", label: "Preview" },
                ]}
                onChange={setTab}
              />
              {tab === "write" ? (
                <Textarea aria-label="Leave a comment" placeholder="Leave a comment" rows={4} value={draft.body} onChange={(change) => onDraft({ ...draft, body: change.target.value })} />
              ) : (
                <div className="min-h-24 rounded-surface border border-border px-3 py-2 text-sm">
                  {draft.body.trim() ? <Markdown text={draft.body} keep={`review-${owner}-${target}`} /> : <span className="text-muted-foreground">Nothing to preview</span>}
                </div>
              )}
            </div>
            <RadioGroup value={event} onValueChange={(value) => setEvent(value as Event)} className="flex flex-col gap-3">
              {EVENTS.map((each) => (
                <label key={each.value} className="flex cursor-pointer items-start gap-2.5">
                  <Radio value={each.value} className="mt-0.5" />
                  <span className="flex flex-col">
                    <span className="text-sm text-foreground">{each.label}</span>
                    <span className="text-xs text-muted-foreground">{pr.state === "merged" ? each.landed : each.open}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
            <div role="alert">
              <ErrorLine size="sm" error={error} />
            </div>
          </ConfirmForm>
        </DialogContent>
      </Dialog>
    </>
  );
}
