import { type ComponentType, useEffect, useState } from "react";
import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../components/menu";
import { NavRow } from "../components/nav";
import { SelectTrigger } from "../components/select";
import { ask, useDaemon } from "../daemon";
import { Chat, Check, CheckCircle, Comment, Dot, Eye, HandRaised, type IconProps, Pencil, X } from "../icons";
import { openPr } from "../panel/open";
import { Note } from "../panel/source/rows";
import type { Pr } from "../panel/types";
import { SearchField } from "../settings/archived-toolbar";
import { useSecond } from "../thread/words";
import { PullRequestClosed, PullRequestDraft, PullRequestMerged, PullRequestOpen } from "./icons";
import { CheckAgain } from "./pr-parts";
import { ago, FRESH_MS } from "./pr-words";

/** The side views, as GitHub's: the session's own first, then GitHub searches of its repository [D258]. */
const VIEWS: { id: string; label: string; Icon: ComponentType<IconProps>; query: string }[] = [
  { id: "session", label: "This session", Icon: Chat, query: "" },
  { id: "all", label: "All", Icon: PullRequestOpen, query: "is:pr state:open" },
  { id: "authored", label: "Authored by me", Icon: Pencil, query: "is:pr state:open author:@me" },
  { id: "assigned", label: "Assigned to me", Icon: HandRaised, query: "is:pr state:open assignee:@me" },
  { id: "involves", label: "Involves me", Icon: Comment, query: "is:pr state:open involves:@me" },
  { id: "review", label: "Review requests", Icon: Eye, query: "is:pr state:open review-requested:@me" },
];

const REVIEWS = [
  { value: "review:none", label: "No reviews" },
  { value: "review:required", label: "Review required" },
  { value: "review:approved", label: "Approved review" },
  { value: "review:changes_requested", label: "Changes requested" },
  { value: "reviewed-by:@me", label: "Reviewed by you" },
  { value: "-reviewed-by:@me", label: "Not reviewed by you" },
  { value: "user-review-requested:@me", label: "Awaiting review from you" },
];

const SORTS = [
  { value: "sort:created-desc", label: "Newest" },
  { value: "sort:created-asc", label: "Oldest" },
  { value: "sort:comments-desc", label: "Most commented" },
  { value: "sort:comments-asc", label: "Least commented" },
  { value: "sort:updated-desc", label: "Recently updated" },
  { value: "sort:updated-asc", label: "Least recently updated" },
];

const TOGGLE = "flex cursor-pointer items-center gap-1.5 rounded-control focus-visible:focus-ring";

const REVIEW_WORDS = { review_required: "Review required", approved: "Approved", changes_requested: "Changes requested" };

/** The query with `word` in place of the words it replaces (one author, one review, one sort, one state). */
function withWord(query: string, word: string): string {
  const kind = (w: string) => (w.startsWith("sort:") ? "sort" : w.startsWith("state:") ? "state" : w.startsWith("author:") ? "author" : REVIEWS.some((r) => r.value === w) ? "review" : w);
  return [...query.split(/\s+/).filter((w) => w && kind(w) !== kind(word)), word].join(" ");
}

/** What a found read is: `host <id> search`'s, kept per query [D258]. */
type Found = { query: string; okAt: number | null; error: string | null; prs: Pr[]; open: number | null; closed: number | null };

function StateIcon({ pr }: { pr: Pr }) {
  if (pr.state === "merged") return <PullRequestMerged className="size-icon-md text-pr-purple" />;
  if (pr.state === "closed") return <PullRequestClosed className="size-icon-md text-destructive" />;
  if (pr.draft) return <PullRequestDraft className="size-icon-md text-muted-foreground" />;
  return <PullRequestOpen className="size-icon-md text-success" />;
}

const CHECK_MARK = {
  pass: <Check aria-label="Checks passed" className="size-icon-sm text-success" />,
  fail: <X aria-label="Checks failed" className="size-icon-sm text-destructive" />,
  pending: <Dot aria-label="Checks running" className="size-icon-sm text-pr-yellow" />,
};

/** GitHub's list row: state, title, then #N · author opened when · review · checks n/m; comments at its end. */
function Row({ owner, pr, now }: { owner: string; pr: Pr; now: number }) {
  return (
    <li className="border-b border-border last:border-b-0">
      <button type="button" onClick={() => openPr(owner, pr)} className="flex w-full cursor-pointer items-start gap-3 px-4 py-3 text-start hover:bg-fill-subtle focus-visible:focus-ring">
        <span className="flex pt-0.5">
          <StateIcon pr={pr} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">{pr.title}</span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
            {/* One from another repository says which, short, as on the card [D213]. */}
            <span>
              {pr.repo && `${pr.repo.slice(pr.repo.indexOf("/") + 1)} `}#{pr.number}
            </span>
            {pr.author && <span>· {pr.author}</span>}
            {pr.createdAtMs && <span>opened {ago(pr.createdAtMs, now)}</span>}
            {pr.state === "open" && pr.review && <span>· {REVIEW_WORDS[pr.review]}</span>}
            {pr.checks && (
              <span className="flex items-center gap-1">
                · {CHECK_MARK[pr.checks.mark]}
                <span className="tabular-nums">
                  {pr.checks.ok}/{pr.checks.all}
                </span>
              </span>
            )}
          </span>
        </span>
        {!!pr.comments && (
          <span className="flex shrink-0 items-center gap-1 pt-0.5 text-xs text-muted-foreground tabular-nums">
            <Comment aria-label="Comments" className="size-icon-sm" />
            {pr.comments}
          </span>
        )}
      </button>
    </li>
  );
}

/** One of the bar's menus: its pill, then its choices; a pick puts its word in the query. */
function Filter({ label, value, choices, onPick }: { label: string; value?: string; choices: { value: string; label: string }[]; onPick: (word: string) => void }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger
        render={
          <SelectTrigger label={label} className="border-transparent bg-transparent">
            {label}
          </SelectTrigger>
        }
      />
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={onPick}>
          {choices.map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value} indicator={<Check className="size-icon-md" />}>
              {choice.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The Pull requests tab, as GitHub's "All pull requests" page [D258]: side views (this session's PRs, D256/D257, then
 * searches of its repository), the search in GitHub's words, Open and Closed, Author, Reviews and Sort. Each paints
 * its last read at once and reads again when older than the watch's quickest pace, and on Check again [D207, D208].
 */
export function PrList({ owner }: { owner: string }) {
  const { daemon, rows } = useDaemon();
  const kept = rows?.find((row) => row.id === owner)?.prs;
  const now = useSecond(true);
  const [view, setView] = useState("session");
  // The search's words: what the box shows, and what was last asked.
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [closed, setClosed] = useState(false);
  // Every query's last read the tab holds, the side views' brought in as it opens: a switch paints at once [D207].
  const [reads, setReads] = useState<Partial<Record<string, Found>>>({});
  const [reading, setReading] = useState<string[]>([]);
  const [listing, setListing] = useState(false);
  const session = view === "session";
  const found = reads[query] ?? null;
  const busy = session ? listing : reading.includes(query);

  const put = (list: Found[]) => setReads((was) => ({ ...was, ...Object.fromEntries(list.map((f) => [f.query, f])) }));
  // One read for all of them [D207]; a failed one keeps each last read with why.
  const read = (queries: string[]) => {
    setReading((was) => [...was, ...queries]);
    ask({ op: "run", args: ["host", owner, "search", ...queries] }, (reply) => {
      setReading((was) => was.filter((q) => !queries.includes(q)));
      const why = reply.error ?? "Couldn't search.";
      setReads((was) => ({
        ...was,
        ...Object.fromEntries(queries.map((q, i) => [q, reply.found?.[i] ?? { query: q, okAt: null, prs: [], open: null, closed: null, ...(was[q] as Found | undefined), error: why }])),
      }));
    });
  };
  // Their last reads at once, then one read of those older than the watch's quickest pace.
  const bring = (queries: string[]) =>
    ask({ op: "run", args: ["host", owner, "search", ...queries, "--kept"] }, (reply) => {
      const last: (Found | null)[] = reply.found ?? [];
      put(last.filter((f): f is Found => !!f));
      const stale = queries.filter((_, i) => Date.now() - (last[i]?.okAt ?? 0) > FRESH_MS);
      if (stale.length > 0) read(stale);
    });
  const check = () => {
    if (!session) return read([query]);
    setListing(true);
    ask({ op: "run", args: ["host", owner, "list"] }, () => setListing(false));
  };
  const search = (q: string, to = "") => {
    setView(to);
    setText(q);
    setQuery(q);
    const last = reads[q];
    if (!last) bring([q]);
    else if (Date.now() - (last.okAt ?? 0) > FRESH_MS && !reading.includes(q)) read([q]);
  };
  const pick = (id: string) => {
    const to = VIEWS.find((v) => v.id === id)!;
    if (to.id !== "session") return search(to.query, to.id);
    setView("session");
    setText("");
    setQuery("");
  };

  const loaded = rows !== undefined;
  useEffect(() => {
    if (!daemon || !loaded) return;
    if (Date.now() - (kept?.okAt ?? 0) > FRESH_MS) check();
    bring(VIEWS.slice(1).map((v) => v.query));
  }, [daemon, owner, loaded]);

  // Rust keeps the session's open first, then by recency [D256].
  const mine = kept?.prs ?? [];
  const opened = mine.filter((pr) => pr.state === "open").length;
  const prs = session ? mine.filter((pr) => (pr.state === "open") !== closed) : (found?.prs ?? []);
  const counts = session ? { open: opened, closed: mine.length - opened } : { open: found?.open ?? null, closed: found?.closed ?? null };
  const showsClosed = session ? closed : /\b(state:closed|is:closed|is:merged)\b/.test(query);
  const error = session ? kept?.error : found?.error;
  const at = session ? (kept?.okAt ?? null) : (found?.okAt ?? null);
  const words = query.split(/\s+/);
  const authors = [...new Set(prs.map((pr) => pr.author).filter((a): a is string => !!a))];
  // A filter from the session's own view asks the repository, open ones first.
  const refine = (word: string) => search(withWord(session ? "is:pr state:open" : query, word));
  const state = (to: boolean) => (session ? setClosed(to) : search(withWord(query, to ? "state:closed" : "state:open"), view));

  return (
    <div data-slot="pr-list" className="flex min-h-0 flex-1 gap-6 overflow-y-auto p-5">
      <nav aria-label="Pull request views" className="flex w-52 shrink-0 flex-col gap-0.5">
        {VIEWS.map(({ id, label, Icon }) => (
          <NavRow key={id} aria-current={view === id ? "page" : undefined} onClick={() => pick(id)}>
            <Icon className="text-muted-foreground" />
            {label}
          </NavRow>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <header className="flex items-baseline gap-3">
          <h2 className="min-w-0 flex-1 font-display text-base font-medium">{VIEWS.find((v) => v.id === view)?.label ?? "Pull requests"}</h2>
          {loaded || !daemon ? <CheckAgain at={at} busy={busy} offline={!daemon} onClick={check} /> : <span className="text-xs text-muted-foreground">Loading…</span>}
        </header>
        <form
          className="flex"
          onSubmit={(event) => {
            event.preventDefault();
            if (text.trim()) search(text.trim());
            else pick("session");
          }}
        >
          <SearchField label="Search all pull requests" value={text} onChange={setText} />
        </form>
        {error && <Note warn text={`Couldn't check · ${error.split("\n")[0]}`} />}
        <ul className="flex flex-col overflow-clip rounded-surface border border-border">
          <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border bg-fill-subtle px-4 py-1.5 text-sm">
            <button type="button" onClick={() => state(false)} className={cx(TOGGLE, showsClosed ? "text-muted-foreground hover:text-foreground" : "font-medium text-foreground")}>
              <PullRequestOpen className="size-icon-sm" /> {counts.open?.toLocaleString() ?? "–"} Open
            </button>
            <button type="button" onClick={() => state(true)} className={cx(TOGGLE, showsClosed ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
              <CheckCircle className="size-icon-sm" /> {counts.closed?.toLocaleString() ?? "–"} Closed
            </button>
            <span className="flex-1" />
            <Filter label="Author" value={words.find((w) => w.startsWith("author:"))} choices={[{ value: "author:@me", label: "You" }, ...authors.map((a) => ({ value: `author:${a}`, label: a }))]} onPick={refine} />
            <Filter label="Reviews" value={words.find((w) => REVIEWS.some((r) => r.value === w))} choices={REVIEWS} onPick={refine} />
            <Filter label={SORTS.find((s) => words.includes(s.value))?.label ?? "Newest"} value={words.find((w) => w.startsWith("sort:")) ?? "sort:created-desc"} choices={SORTS} onPick={refine} />
          </li>
          {prs.map((pr) => (
            <Row key={`${pr.repo ?? ""}#${pr.number}`} owner={owner} pr={pr} now={now} />
          ))}
          {prs.length === 0 && (
            <li className="px-4 py-10">
              {session ? (
                rows !== undefined && <EmptyState variant="centered" icon={PullRequestOpen} title={mine.length ? "None here" : "No pull requests yet"} detail={mine.length ? undefined : "The ones this session opens or works on show here"} />
              ) : found ? (
                <EmptyState variant="centered" icon={PullRequestOpen} title="No pull requests match" />
              ) : (
                <p className="text-center text-sm text-muted-foreground">{busy ? "Searching…" : "Not checked yet"}</p>
              )}
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}
