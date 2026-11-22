import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { threadSource, useDaemon } from "../daemon";
import { HomeDraft } from "../home/home";
import { REVIEW_DRAFT, reviewTitle, setHomeDraft } from "../home/start";
import { Chat, Minus, Spinner, X } from "../icons";
import { HostOf } from "../landing/host";
import { LivePrTab } from "../landing/live";
import { usePutBackAsked } from "../session/side";
import { HOME, setHomeTabs, useTabs } from "../shell/tab-store";
import { useStored } from "../sidebar/sidebar";
import { prName } from "./route";

/*
 * A PR on the Pull Requests page [D237]: the PR fills the main area with no tab bar, its review chat floating
 * over it at the bottom right. The chat sends without leaving the page; its header folds it between the composer alone
 * (compact) and its thread above the composer (expanded), and "—" minimises it to a round button. How it was left is kept.
 */

type Look = "compact" | "expanded" | "minimised";

export function PrPage({ target, chat, children }: { target: string; chat: string | undefined; children: ReactNode }) {
  useTabsShownOnThread(chat);
  return (
    <main className="relative flex min-h-0 flex-1 flex-col bg-background">
      {/* The titlebar's row stays empty and drags the window; the toolbar sits on the sidebar heading's row [D263]. */}
      <div className="app-drag -mt-tab-bar h-tab-bar shrink-0" />
      {/* Read by the Pull Requests page's own owner, needing no checkout [D159]; Review and Fix ask in its review chat. */}
      <HostOf.Provider value="@">
        <LivePrTab owner={chat ?? HOME} target={target} />
      </HostOf.Provider>
      <ReviewDock target={target} chat={chat}>
        {children}
      </ReviewDock>
    </main>
  );
}

/** The review chat's draft, before its first message: the composer alone, its send starting the chat here [D162 D198]. */
export function ReviewDraft({ review }: { review: string }) {
  // Its tabs its own, apart from Home's and a project's draft, which its start must not carry away [D162].
  useLayoutEffect(() => {
    setHomeDraft({ review });
    setHomeTabs(null, REVIEW_DRAFT);
  }, [review]);
  return <HomeDraft />;
}

/** The page has no tab bar [D237]: a file, attachment or link the review chat opens shows on the chat's own page, in its tabs. */
function useTabsShownOnThread(chat: string | undefined): void {
  const { tabs, active } = useTabs(chat ?? HOME);
  // Counted from when the page or its chat opened, so a tab left in front before stays put.
  const was = useRef({ chat, active });
  useEffect(() => {
    const before = was.current;
    was.current = { chat, active };
    const tab = tabs.find((each) => each.id === active);
    if (chat && before.chat === chat && active !== before.active && tab && tab.kind !== "pr") window.location.hash = `#thread/${encodeURIComponent(chat)}`;
  }, [chat, active]);
}

/** The last answer's words, plain, for the compact dock's Response ready. */
function useLastAnswer(chat: string | undefined): string {
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  if (!chat || session?.id !== chat) return "";
  const last = session.items.findLast((item) => item.kind === "message" && item.role === "assistant");
  return last?.kind === "message" ? last.text.replace(/[`*_#>[\]]/g, "").replace(/\(https?:[^)]*\)/g, "") : "";
}

function ReviewDock({ target, chat, children }: { target: string; chat: string | undefined; children: ReactNode }) {
  const [kept, setLook] = useStored<Look>("pullRequests.dock", "compact");
  // With no thread yet there's nothing to expand to.
  const look: Look = !chat && kept === "expanded" ? "compact" : kept;
  const rows = useDaemon().rows;
  const row = rows?.find((each) => each.id === chat);
  const running = row?.mark === "working";
  const answer = useLastAnswer(chat);
  // An answer that lands while the thread is out of sight is Response ready until it's looked at or dismissed.
  const [ready, setReady] = useState(false);
  const finished = row?.finished ?? 0;
  // Counted from the first read of the rows, so an answer from before this page opened isn't new.
  const seen = useRef<number | null>(rows ? finished : null);
  useEffect(() => {
    if (!rows) return;
    if (seen.current !== null && finished > seen.current && look !== "expanded") setReady(true);
    seen.current = finished;
  }, [finished, Boolean(rows)]);
  useEffect(() => void (look === "expanded" && setReady(false)), [look]);
  // Fix, Review and Add to chat put words in its composer: it comes forward to show them.
  const asked = usePutBackAsked();
  useEffect(() => {
    if (asked && asked.source === (chat ?? HOME) && look === "minimised") setLook("compact");
  }, [asked?.n]);
  const title = chat ? (row?.title ?? reviewTitle(target)) : `Reviewing ${prName(target)}`;
  if (look === "minimised") {
    return (
      <div className="review-dock-place pointer-events-none absolute z-20 flex justify-end">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Restore floating chat: ${title}`}
                onClick={() => setLook("compact")}
                className="pointer-events-auto relative flex size-9 cursor-pointer items-center justify-center rounded-capsule bg-popover text-foreground shadow-summary hover:bg-muted focus-visible:focus-ring svg:size-icon-md"
              />
            }
          >
            {running ? <Spinner className="motion-safe:animate-spin" /> : <Chat />}
            {ready && <span aria-label="Unread response" className="absolute end-1 top-1 size-2 rounded-capsule bg-link" />}
          </TooltipTrigger>
          <TooltipContent side="left">Restore floating chat</TooltipContent>
        </Tooltip>
      </div>
    );
  }
  const expandable = Boolean(chat);
  const fold = expandable && (look === "expanded" ? "cursor-s-resize" : "cursor-n-resize");
  return (
    <section data-dock={look} aria-label={title} className="review-dock review-dock-place absolute z-20 flex flex-col rounded-dock bg-popover p-1.5 shadow-summary">
      <header
        onClick={() => expandable && setLook(look === "expanded" ? "compact" : "expanded")}
        className={cx("flex h-tab-bar shrink-0 items-center gap-1.5", look === "expanded" ? "px-3" : "mx-1.5 border-b border-border px-2", fold)}
      >
        <TooltipIconButton
          tooltip="Minimize chat"
          look="round"
          onClick={(event) => {
            event.stopPropagation();
            setLook("minimised");
          }}
        >
          <Minus />
        </TooltipIconButton>
        <h2 className="min-w-0 flex-1 truncate text-base font-medium text-muted-foreground">
          {/* The header's fold, for the keyboard too: its click reaches the header's. */}
          {expandable ? (
            <button type="button" aria-expanded={look === "expanded"} className={cx("max-w-full truncate rounded-sm focus-visible:focus-ring", fold)}>
              {title}
            </button>
          ) : (
            title
          )}
        </h2>
        {running ? <Spinner aria-label="Running" className="size-icon-sm text-muted-foreground motion-safe:animate-spin" /> : ready && <span aria-label="Unread response" className="size-2 rounded-capsule bg-link" />}
      </header>
      {look === "compact" && chat && (running || ready) && (
        <div className="relative mx-1.5 flex min-w-0 items-start gap-2 border-b border-border">
          <button type="button" onClick={() => setLook("expanded")} className="min-w-0 flex-1 cursor-pointer px-2.5 py-3 text-start text-sm">
            <span className="block text-muted-foreground">{running ? "Working…" : "Response ready"}</span>
            {!running && answer && <span className="mt-0.5 line-clamp-2 text-foreground">{answer}</span>}
          </button>
          {!running && (
            <TooltipIconButton tooltip="Dismiss" look="round" className="mt-2.5" onClick={() => setReady(false)}>
              <X />
            </TooltipIconButton>
          )}
        </div>
      )}
      {/* Its thread and composer, the thread shown only while expanded (theme.css review-dock). */}
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}
