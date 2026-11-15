// An approval waiting for the user, in the composer's place (D96).
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { ApprovalAction } from "../../thread/item";
import { Commit, Dock, Globe, Key, PencilSquare, Sparkle } from "../../icons";
import { MentionedWorker } from "../../workers/live";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { Kbd } from "../kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { ActionCard, ActionCardActions, ActionCardTitle, ActionFileList, ActionFreeText, actionButton, CodeSpans, cardKey, DismissButton, forgetCards, inField, StepCounter, ToolBox, useCardKeys } from "./decision-parts";
import { plainText } from "./draft";
import { ComposerField, type ComposerFieldHandle } from "./field";

/** An approval as Rust sends it (msgs/w18-fields-4.md, boss D177). Agent text (`reason`, `body`) passes as is. */
export type PendingApproval = {
  id: string;
  action: ApprovalAction;
  /** The asker's one-line reason; null: the plain question. */
  reason: string | null;
  command?: string;
  /** Only when the command runs outside the session's own folders. */
  cwd?: string | null;
  /** Files to edit; for a command, what it asks beyond its sandbox. */
  paths?: string[];
  /** A landing's diff stat. */
  files?: { path: string; insertions: number; deletions: number; binary: boolean }[];
  branch?: string;
  /** A network request's host, when that's all it asks. */
  host?: string;
  /** A tool's raw input, when there's no command or paths. */
  input?: string;
  /** Prose: a plan, a message to another session, a browser step's details, an action's details. */
  body?: string;
  /** A message's target session. */
  to?: string;
  /** What "Allow for this session" covers: a command prefix, a folder, a host. */
  grant?: { scope: "command" | "edits" | "network" | "tool"; pattern: string } | null;
  /** The subagent that asks, by its title. */
  agent?: string;
  /** A plan its adversarial review holds: the reviewer, a worker, and its model's name (§6). */
  review?: { by: string; name: string };
  /** A plan's review line: "Plan reviewed by ‹model›: 5 findings, 4 fixed, 1 rejected", or "Review didn't run: ‹why›". */
  reviewed?: string;
};

export type ApprovalDecision = "allow" | "allowSession" | "deny";

type Shown = { icon: ReactNode; kind: string; title: string; detail?: string; body?: ReactNode; allow?: string; deny?: string; noDeny?: boolean };

/** What the card asks, compactly: its kind, the reason (or the plain question) as the title, the exact thing asked about. */
export function describe(approval: PendingApproval): Shown {
  const { action, reason, command, cwd, paths = [], host, input, body } = approval;
  const prose = body ? (
    <ToolBox prose>
      <CodeSpans text={body} />
    </ToolBox>
  ) : undefined;
  switch (action) {
    case "command":
      return {
        icon: <Dock />,
        kind: "Terminal",
        title: reason || "Allow this command?",
        body: command && (
          <ToolBox clamp>
            <CodeSpans exact text={command} />
            {cwd && <span className="block text-card-faint">in {cwd}</span>}
            {/* What the command asks for beyond its sandbox (`write /path`, `network`). */}
            {paths.length > 0 && <span className="block text-card-faint">with {paths.join(", ")}</span>}
          </ToolBox>
        ),
      };
    case "edit":
      return {
        icon: <PencilSquare />,
        kind: "Edit files",
        title: reason || (paths.length === 1 ? "Allow editing this file?" : "Allow editing these files?"),
        body: paths.length > 0 && <ActionFileList files={paths.map((path) => ({ path }))} />,
      };
    case "network":
      return {
        icon: <Globe />,
        kind: "Internet access",
        title: reason || (host ? `Allow connecting to https://${host}?` : "Allow connecting to the internet?"),
        body: host && <p className="px-4 text-sm text-card-note">{host} isn’t on this session’s list of allowed sites.</p>,
      };
    case "land":
      return {
        icon: <Commit />,
        kind: "Land a change",
        // Where it lands always shows; the agent's reason goes under it.
        title: `Land this change on ${approval.branch ?? "the branch"}?`,
        detail: reason ?? undefined,
        body: approval.files && (
          <ActionFileList
            files={approval.files.map((file) => ({
              path: file.path,
              trailing: (
                <span className="shrink-0 text-xs font-normal tabular-nums">
                  {file.binary ? (
                    <span className="text-toolbar-foreground">binary</span>
                  ) : (
                    <>
                      <span className="text-success">+{file.insertions}</span> <span className="text-destructive">−{file.deletions}</span>
                    </>
                  )}
                </span>
              ),
            }))}
          />
        ),
        allow: "Land",
      };
    // The plan the agent proposed in its plan mode: build it, or reply to change it.
    // While its review holds it, nothing to answer yet (§6).
    case "plan":
      return {
        icon: <Sparkle />,
        kind: "Plan",
        title: approval.review ? `Reviewing this plan · ${approval.review.name}` : reason || "Build this plan?",
        detail: approval.reviewed,
        body: prose,
        allow: "Build it",
        noDeny: true,
      };
    case "message":
      return {
        icon: <Sparkle />,
        kind: "Message",
        // Who it goes to always shows; the agent's reason goes under it.
        title: `Send a message to ${approval.to ?? "another session"}?`,
        detail: reason ?? undefined,
        body: prose,
        allow: "Send",
        deny: "Don't send",
      };
    case "browser":
      return { icon: <Globe />, kind: "Browser", title: reason || "Go ahead in the browser?", body: prose, allow: "Go ahead", deny: "Don't" };
    default:
      return {
        icon: <Key />,
        kind: "Ask permission",
        title: reason || "Allow this?",
        body:
          prose ??
          (input && (
            <ToolBox clamp>
              <CodeSpans exact text={input} />
            </ToolBox>
          )),
      };
  }
}

/** The "Allow for this session" button's tip, from what the grant covers (D177); its words never change [D167]. */
function grantTip({ scope, pattern }: NonNullable<PendingApproval["grant"]>): string {
  const kept = "Not saved across sessions.";
  if (scope === "edits") return `Allow file changes inside ${pattern} in this chat. Edits outside it still ask. ${kept}`;
  if (scope === "tool") return `Allow ${pattern} in this chat. ${kept}`;
  if (scope === "network") return `Allow connections to ${pattern} in this chat. ${kept}`;
  return `Allow commands that start with ${pattern} in this chat. ${kept}`;
}

// Deny reasons typed, by session and approval id, outside any card: paging away and back keeps them. Read as each
// card mounts, so not state. Dropped once answered, or by `forgetReasons`.
const reasons = new Map<string, string>();
/** Drops the session's deny reasons for approvals no longer waiting. */
export const forgetReasons = (session: string, keep: ReadonlySet<string>) => forgetCards(reasons, session, keep);

/** Where a card stands among the approvals waiting: "1 of 3", with ‹ › to step between them. */
export type ApprovalStep = { index: number; total: number; onStep: (index: number) => void };

// A button making way for a typed reason: its width eases to nothing, and the row's gap goes with it.
const MAKES_WAY = "makes-way grid data-gone:w-0 data-gone:-ms-2";

const ENTER_KEY = (
  <Kbd variant="chip" aria-hidden className="@max-card-narrow/approval-card:hidden">
    ⏎
  </Kbd>
);

/** One label becoming another: the width eases between them while the labels crossfade over it whole, so neither is uncovered from an edge. */
function Morph({ from, to, morphed }: { from: ReactNode; to: ReactNode; morphed: boolean }) {
  const faces = [
    { face: from, gone: morphed || undefined },
    { face: to, gone: !morphed || undefined },
  ];
  return (
    <span className="relative flex items-center">
      {faces.map(({ face, gone }, at) => (
        <span key={at} aria-hidden data-gone={gone} className="makes-way invisible flex items-center gap-1 data-gone:w-0">
          {face}
        </span>
      ))}
      <span className="absolute inset-0 grid place-content-center place-items-center">
        {faces.map(({ face, gone }, at) => (
          <span key={at} aria-hidden={gone} data-gone={gone} className="col-start-1 row-start-1 flex items-center gap-1 transition-opacity motion-reduce:transition-none data-gone:opacity-0">
            {face}
          </span>
        ))}
      </span>
    </span>
  );
}

/**
 * An approval, compact: kind, the reason as the title, the exact command, then [Deny `Esc`] [Allow … for this
 * session] [Allow once `⏎`]. Esc denies from anywhere in the view. The card takes focus as it comes, unless the user
 * is typing elsewhere, and Enter anywhere in it answers with its main button (D186), until something is typed on a card
 * with no field (it goes to the hidden draft); a held Enter counts once, so it can't answer the next card. With `onReason` a field beside the buttons takes
 * what the agent should do instead (D192). With words in it the card turns to refusing (D182): Deny and the session
 * grant make way, Allow becomes Send, which denies with the words and never allows. Esc clears the words and
 * brings the card back (D183); only with the field empty does it deny.
 * While an answer goes (`busy`) the buttons wait, and a refusal shows its `error` on the card.
 */
export function ApprovalCard({
  approval,
  onAnswer,
  busy,
  error,
  reason = "",
  onReason,
  step,
  dismiss,
  onType,
}: {
  approval: PendingApproval;
  /** `reason`: what the user typed with a deny, trimmed; none when empty. */
  onAnswer: (decision: ApprovalDecision, reason?: string) => void;
  busy: boolean;
  error: string | null;
  /** The deny reason typed so far (read as the card mounts), and as it changes; without `onReason` no field. */
  reason?: string;
  onReason?: (text: string) => void;
  step?: ApprovalStep;
  /** Nothing waits on it any more: Dismiss beside its error puts it away. */
  dismiss?: () => void;
  /** A key typed on a card with no field of its own, for the draft it hides; null: Backspace. */
  onType?: (text: string | null) => void;
}) {
  const [typed, setTyped] = useState(reason);
  // Typed since it showed: Enter no longer answers, so words meant as a reply never build the plan [D186].
  const [keyed, setKeyed] = useState(false);
  const answer = (decision: ApprovalDecision) => {
    if (!busy) onAnswer(decision, decision === "deny" ? typed.trim() || undefined : undefined);
  };
  const deny = () => answer("deny");
  const shown = describe(approval);
  const asksReason = Boolean(onReason) && !shown.noDeny;
  const refusing = asksReason && typed.trim() !== "";
  const primary = () => answer(refusing ? "deny" : "allow");
  const message = approval.action === "message";
  const field = useRef<ComposerFieldHandle>(null);
  const escape = () => {
    if (busy) return;
    if (refusing) field.current?.set([]);
    else deny();
  };
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    // In the composer's place it takes focus from the composer it hides, which would drop it to the page.
    const active = document.activeElement;
    if (!inField(active) || active?.closest("[data-slot=composer-card]")) card.current?.focus({ preventScroll: true });
  }, []);
  const reviewing = approval.review;
  useCardKeys(!busy && !reviewing, { enter: keyed ? undefined : primary, escape: shown.noDeny ? undefined : escape }, card);
  const keep = asksReason || !onType ? undefined : (text: string | null) => {
    setKeyed(true);
    onType(text);
  };

  const grant = approval.grant ? grantTip(approval.grant) : null;
  const allow = shown.allow ?? "Allow once";
  return (
    <ActionCard
      ref={card}
      tabIndex={0}
      aria-label="Approval"
      data-action="approval"
      onKeyDown={(event) => {
        // shortcut: plain keys, Backspace and paste only (no IME composing); enough while the field is out of sight.
        const { key, target, currentTarget } = event;
        if (!keep || event.metaKey || event.ctrlKey || inField(target) || (key === " " && target !== currentTarget)) return;
        if (key !== "Backspace" && key.length !== 1) return;
        event.preventDefault();
        keep(key === "Backspace" ? null : key);
      }}
      onPaste={(event) => {
        const text = event.clipboardData.getData("text/plain");
        if (!keep || inField(event.target) || !text) return;
        event.preventDefault();
        keep(text);
      }}
    >
      <div className="flex min-w-0 flex-col gap-2 px-4 pt-3.5 pb-2.5">
        <div className="flex min-w-0 items-center gap-2 text-code leading-5 text-card-kind svg:size-4.5 svg:shrink-0">
          {shown.icon}
          <span className="shrink-0">{shown.kind}</span>
          {approval.agent && <span className="truncate">· {approval.agent}</span>}
          {step && step.total > 1 && (
            <StepCounter
              noun="request"
              at={step.index}
              count={step.total}
              canBack={step.index > 0}
              canForward={step.index < step.total - 1}
              onStep={(by) => step.onStep(step.index + by)}
              className="ms-auto"
            />
          )}
        </div>
        <div role="alert" aria-atomic="true">
          <ActionCardTitle detail={shown.detail && <CodeSpans text={shown.detail} />}>
            <CodeSpans text={shown.title} />
            {reviewing && (
              <>
                {" "}
                <MentionedWorker id={reviewing.by} />
              </>
            )}
          </ActionCardTitle>
        </div>
      </div>
      {shown.body}
      <ErrorLine error={error} className="px-4 pt-2" actions={dismiss && <DismissButton onClick={dismiss} />} />
      {!reviewing && (
        <ActionCardActions
          leading={
            asksReason && (
              <ActionFreeText
                className="-ms-2 min-w-40 flex-1 @max-card-one-row/approval-card:basis-full"
                field={
                  <div className="min-w-0 flex-1">
                    <ComposerField
                      ref={field}
                      size="line"
                      label="What to do instead"
                      placeholder="Tell the agent what to do instead"
                      initial={{ parts: reason ? [reason] : [], attachmentIds: [] }}
                      onChange={(parts) => {
                        const text = plainText(parts);
                        setTyped(text);
                        onReason?.(text);
                      }}
                      onSubmit={(other) => {
                        if (refusing || !other) primary();
                      }}
                      onEscape={escape}
                    />
                  </div>
                }
              />
            )
          }
        >
          {!shown.noDeny && (
            <div data-gone={refusing || undefined} inert={refusing} className={MAKES_WAY}>
              <button type="button" className={actionButton("outline")} disabled={busy} onClick={deny}>
                {shown.deny ?? "Deny"}
                <Kbd variant="chip" aria-hidden className="@max-card-narrow/approval-card:hidden">
                  Esc
                </Kbd>
              </button>
            </div>
          )}
          {grant && (
            <div data-gone={refusing || undefined} inert={refusing} className={MAKES_WAY}>
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    className={actionButton("outline")}
                    disabled={busy}
                    onClick={() => answer("allowSession")}
                  />
                }
              >
                Allow for this session
              </TooltipTrigger>
              <TooltipContent>{grant}</TooltipContent>
            </Tooltip>
            </div>
          )}
          <button
            type="button"
            className={actionButton("primary", "max-w-full")}
            disabled={busy}
            onClick={primary}
          >
            {asksReason ? (
              <Morph
                morphed={refusing}
                from={
                  <>
                    {allow}
                    {ENTER_KEY}
                  </>
                }
                to={
                  <>
                    {message ? "Send instead" : "Send"}
                    {ENTER_KEY}
                  </>
                }
              />
            ) : (
              <>
                {allow}
                {!keyed && ENTER_KEY}
              </>
            )}
          </button>
        </ActionCardActions>
      )}
    </ActionCard>
  );
}

/**
 * The approvals waiting, oldest first, one at a time, in the composer's place as the composer card (D96).
 * Answering one shows the next.
 */
export function ApprovalSlot({
  approvals,
  onAnswer,
  denyReason = true,
  session = "",
  dismiss,
  error,
  onType,
}: {
  approvals: readonly PendingApproval[];
  /** `reason`: what to do instead, typed with a deny. */
  onAnswer: (id: string, decision: ApprovalDecision, reason?: string) => Promise<void>;
  /** The deny reason field (D192). */
  denyReason?: boolean;
  /** Whose approvals they are: what keeps one session's typed reasons from another's. */
  session?: string;
  /** A refused card nothing waits on any more: its Dismiss. */
  dismiss?: (id: string) => (() => void) | undefined;
  /** Rust's refusal, kept with the answer. */
  error?: (id: string) => string | null;
  /** Keys typed on a card with no field of its own: the hidden composer's draft keeps them. */
  onType?: (text: string | null) => void;
}) {
  // The card shown, by id, so another going doesn't change it; where it was, for the one after it when it goes.
  const [shown, setShown] = useState<{ id: string | null; index: number }>({ id: null, index: 0 });
  // Answers on their way and refusals, by id: paging away and back keeps them.
  const [sending, setSending] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  // One that came while nobody could see the window is simply there when it shows again.
  const [opens] = useState(() => document.visibilityState === "visible");
  const found = approvals.findIndex((each) => each.id === shown.id);
  const at = found >= 0 ? found : Math.min(shown.index, approvals.length - 1);
  const approval = approvals[at];
  if (!approval) return null;
  const { id } = approval;
  const answer = (decision: ApprovalDecision, reason?: string) => {
    // Where a click on the card got to, for a demo that sees one not reach the session (CDP replays the console).
    console.info("approval answer", decision, session, id, sending.has(id) ? "already on its way" : "sending");
    if (sending.has(id)) return;
    setSending((ids) => new Set(ids).add(id));
    setErrors((map) => new Map([...map].filter(([key]) => key !== id)));
    onAnswer(id, decision, reason)
      .then(() => reasons.delete(cardKey(session, id)))
      .catch((cause: unknown) => setErrors((map) => new Map(map).set(id, cause instanceof Error ? cause.message : String(cause))))
      .finally(() => setSending((ids) => new Set([...ids].filter((key) => key !== id))));
  };
  return (
    <div data-slot="approval-slot" className={cx("relative w-full rounded-composer bg-composer shadow-hairline", opens && "motion-safe:animate-rail-open")}>
      <ApprovalCard
        key={id}
        approval={approval}
        onAnswer={answer}
        busy={sending.has(id)}
        error={errors.get(id) ?? error?.(id) ?? null}
        reason={reasons.get(cardKey(session, id))}
        onReason={denyReason ? (text) => reasons.set(cardKey(session, id), text) : undefined}
        dismiss={dismiss?.(id)}
        onType={onType}
        step={{ index: at, total: approvals.length, onStep: (index) => setShown({ id: approvals[index]?.id ?? null, index }) }}
      />
    </div>
  );
}

/** Under a decision on the rail: how many more wait behind it. */
export function MoreWaiting({ more }: { more: number }) {
  if (more <= 0) return null;
  return (
    <p className="px-4 pb-3 text-xs text-toolbar-foreground">
      {more} more {more === 1 ? "decision waits" : "decisions wait"} after this one
    </p>
  );
}
