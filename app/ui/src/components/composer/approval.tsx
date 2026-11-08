// An approval waiting for the user: in the composer's place (D96), or on the rail after Reply….
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { ApprovalAction } from "../../thread/item";
import { Commit, Dock, Globe, Key, PencilSquare, Sparkle } from "../../icons";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { Kbd } from "../kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";
import { RailItem } from "./rail";
import { ActionCard, ActionCardActions, ActionCardTitle, ActionFileList, actionButton, CodeSpans, inField, ReplyButton, StepCounter, ToolBox, useCardKeys } from "./decision-parts";

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
  /** What "Allow … for this session" covers: a command prefix, a folder, a host. */
  grant?: { scope: "command" | "edits" | "network"; pattern: string } | null;
};

export type ApprovalDecision = "allow" | "allowSession" | "deny";

type Shown = { icon: ReactNode; kind: string; title: string; detail?: string; body?: ReactNode; allow?: string; deny?: string; noDeny?: boolean };

/** What the card asks, compactly: its kind, the reason (or the plain question) as the title, the exact thing asked about. */
function describe(approval: PendingApproval): Shown {
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
    case "plan":
      return { icon: <Sparkle />, kind: "Plan", title: reason || "Build this plan?", body: prose, allow: "Build it", noDeny: true };
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

/** The "Allow … for this session" button's words and its tip, from what the grant covers (D177). */
function grantWords({ scope, pattern }: NonNullable<PendingApproval["grant"]>): { scope: string; tip: string } {
  const kept = "Not saved across sessions.";
  if (scope === "edits") return { scope: "edits in this folder", tip: `Allow file changes inside ${pattern} in this chat. Edits outside it still ask. ${kept}` };
  if (scope === "network") return { scope: pattern, tip: `Allow connections to ${pattern} in this chat. ${kept}` };
  return { scope: pattern, tip: `Allow commands that start with ${pattern} in this chat. ${kept}` };
}

/** Where a card stands among the approvals waiting: "1 of 3", with ‹ › to step between them. */
export type ApprovalStep = { index: number; total: number; onStep: (index: number) => void };

/**
 * An approval, compact: kind, the reason as the title, the exact command, then [Deny `Esc`] [Allow … for this
 * session] [Allow once]. Esc denies from anywhere in the view; allowing takes a click, or Enter on an Allow the
 * user moved to: a stray Enter never allows. A message to another session is the exception: the card takes
 * focus, and Enter on it sends (its ⏎ shows while it has focus). While an answer goes (`busy`) the buttons wait,
 * and a refusal shows its `error` on the card.
 */
export function ApprovalCard({
  approval,
  onAnswer,
  busy,
  error,
  step,
  onReply,
  footer,
}: {
  approval: PendingApproval;
  onAnswer: (decision: ApprovalDecision) => void;
  busy: boolean;
  error: string | null;
  step?: ApprovalStep;
  /** In the composer's place: brings the message field back. */
  onReply?: () => void;
  footer?: ReactNode;
}) {
  const answer = (decision: ApprovalDecision) => {
    if (!busy) onAnswer(decision);
  };
  const deny = () => answer("deny");
  const message = approval.action === "message";
  const plan = approval.action === "plan";
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    if (message && !inField(document.activeElement)) card.current?.focus({ preventScroll: true });
  }, [message]);
  useCardKeys(!busy && !plan, message ? { enter: () => answer("allow"), escape: deny } : { escape: deny }, card);

  const shown = describe(approval);
  const grant = approval.grant ? grantWords(approval.grant) : null;
  return (
    <ActionCard ref={card} tabIndex={message ? 0 : undefined} aria-label="Approval" data-action="approval" className="group/approval">
      <div className="flex min-w-0 flex-col gap-2 px-4 pt-3.5 pb-2.5">
        <div className="flex min-w-0 items-center gap-2 text-code leading-5 text-card-kind svg:size-4.5 svg:shrink-0">
          {shown.icon}
          <span className="shrink-0">{shown.kind}</span>
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
          </ActionCardTitle>
        </div>
      </div>
      {shown.body}
      <ActionCardActions
        leading={
          <>
            {onReply && <ReplyButton onClick={onReply} />}
            <ErrorLine error={error} className="me-auto" />
          </>
        }
      >
        {!shown.noDeny && (
          <button type="button" className={actionButton("outline", "@max-card-narrow/approval-card:justify-center")} disabled={busy} onClick={deny}>
            {shown.deny ?? "Deny"}
            <Kbd variant="chip" aria-hidden className="@max-card-narrow/approval-card:hidden">
              Esc
            </Kbd>
          </button>
        )}
        {grant && (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`Allow ${grant.scope} for this session`}
                  className={actionButton("outline", "max-w-full min-w-0 @max-card-narrow/approval-card:justify-center")}
                  disabled={busy}
                  onClick={() => answer("allowSession")}
                />
              }
            >
              <span className="flex min-w-0 items-center">
                <span className="shrink-0">Allow&nbsp;</span>
                <span className="truncate">{grant.scope}</span>
                <span className="shrink-0">&nbsp;for this session</span>
              </span>
            </TooltipTrigger>
            <TooltipContent>{grant.tip}</TooltipContent>
          </Tooltip>
        )}
        <button
          type="button"
          className={actionButton("primary", "max-w-full @max-card-narrow/approval-card:justify-center")}
          disabled={busy}
          onClick={() => answer("allow")}
        >
          <span className="truncate">{shown.allow ?? "Allow once"}</span>
          {message && (
            <span className="hidden group-focus-within/approval:contents">
              <Kbd variant="chip" aria-hidden className="@max-card-narrow/approval-card:hidden">
                ⏎
              </Kbd>
            </span>
          )}
        </button>
      </ActionCardActions>
      {footer}
    </ActionCard>
  );
}

/**
 * The approvals waiting, oldest first, one at a time. `placement` "composer": in the composer's place, as the
 * composer card, with "Reply…" to bring the field back (D96); "rail": on the rail above the field, like any
 * other decision, with how many more wait. Answering one shows the next.
 */
export function ApprovalSlot({
  approvals,
  placement = "composer",
  onAnswer,
  onReply,
}: {
  approvals: readonly PendingApproval[];
  placement?: "composer" | "rail";
  onAnswer: (id: string, decision: ApprovalDecision) => Promise<void>;
  onReply?: () => void;
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
  const answer = (decision: ApprovalDecision) => {
    if (sending.has(id)) return;
    setSending((ids) => new Set(ids).add(id));
    setErrors((map) => new Map([...map].filter(([key]) => key !== id)));
    onAnswer(id, decision)
      .catch((cause: unknown) => setErrors((map) => new Map(map).set(id, cause instanceof Error ? cause.message : String(cause))))
      .finally(() => setSending((ids) => new Set([...ids].filter((key) => key !== id))));
  };
  const card = (
    <ApprovalCard
      key={id}
      approval={approval}
      onAnswer={answer}
      busy={sending.has(id)}
      error={errors.get(id) ?? null}
      step={{ index: at, total: approvals.length, onStep: (index) => setShown({ id: approvals[index]?.id ?? null, index }) }}
      onReply={placement === "composer" ? onReply : undefined}
      footer={placement === "rail" && <MoreWaiting more={approvals.length - 1} />}
    />
  );
  if (placement === "rail") {
    return (
      <RailItem variant="decision" label="Waiting for you">
        {card}
      </RailItem>
    );
  }
  return (
    <div data-slot="approval-slot" className={cx("relative w-full rounded-composer bg-composer shadow-hairline", opens && "motion-safe:animate-rail-open")}>
      {card}
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
