import { type ReactNode, useContext } from "react";

import { SessionOfThread } from "../../accounts/limit";
import { PeerBubble } from "../../peers/live";
import type { Item, SentFile, Turn } from "../../thread/item";
import { Markdown } from "../../thread/markdown";
import { duration } from "../../thread/words";
import { useAgentLabel } from "../../onboarding/api";
import { describe } from "../composer/approval";
import { SentAttachments } from "../composer/attachments";
import type { Draft } from "../composer/draft";
import { PASTE_LABEL } from "../../shell/attachment-tab";
import { openAttachment } from "../../shell/tab-store";
import { ApprovalRow, ChildAgentRow, CompactionDivider, NoticeRow, QuestionRow, UnknownRow } from "./cards";
import { FileChangeRow } from "./file-change";
import { ShieldExclamation } from "../../icons";
import { ChangeLine, InlineStatus } from "./line";
import { AssistantMessage, ThinkingLine, UserBubble } from "./message";
import { ErrorState } from "./error-state";
import { RewindContext } from "./rewind";
import { ToolRow } from "./tool";

function UserRow({ id, cid, text, time, dated, files, draft }: { id: string; cid: string | undefined; text: string; time: number | undefined; dated: boolean; files: readonly SentFile[]; draft?: Draft | null }) {
  const offer = useContext(RewindContext)?.offer(cid ?? "", text);
  const session = useContext(SessionOfThread)?.id;
  const at = (file: string) => `/attachment/${session}/${file}`;
  // An image or paste in the text shows there as its chip, not above as well, as the old app's [D2107].
  const inline = new Set(draft?.parts.flatMap((part) => (typeof part !== "string" && "attachmentId" in part ? [part.attachmentId] : [])));
  const above = files.filter((file) => !inline.has(file.id));
  const sent = session && above.length > 0 && (
    <SentAttachments files={above.map((file) => ({ ...file, url: at(file.id) }))} onOpen={(file) => openAttachment(session, file.id, file.pasted ? PASTE_LABEL : file.name)} />
  );
  const bubble = <UserBubble keep={id} text={text} time={time} dated={dated} rewind={cid ? offer : undefined} files={sent} owner={session} parts={draft?.parts} />;
  // Reaching the message asks Rust ahead, so its rewind dialog opens whole [D480]. No box of its own.
  return cid && offer ? (
    <div className="contents" onPointerEnter={offer.look} onFocus={offer.look}>
      {bubble}
    </div>
  ) : (
    bubble
  );
}

function Said({ backend }: { backend: string | undefined }) {
  return <h2 className="sr-only">{useAgentLabel(backend)} said:</h2>;
}

const FAILED = {
  "turn-failed": "This turn didn’t finish",
  "model-unavailable": "This model isn’t available",
  "ended-for-safety": "A safety check ended this conversation, so it can’t go on",
  "context-full": "Context full",
};

/**
 * One item's row, by its kind. `step` marks one of an opened group's steps, which says how long it took.
 * `turn` says whether a question still waits (its turn runs). `dated`: a user's message with its date above. `again`:
 * a failed turn's actions, the app's (Retry and what its reason offers).
 */
export function Body({ item, turn, step, dated = false, actions = true, older, fork, again }: { item: Item; turn: Turn | undefined; step: boolean; dated?: boolean; actions?: boolean; older?: boolean; fork?: ReactNode; again?: ReactNode }) {
  switch (item.kind) {
    case "group":
      return null;
    case "message":
      if (item.origin === "peer" && item.from) return <PeerBubble from={item.from} text={item.text} at={item.sentAt ?? 0} />;
      if (item.role === "user") {
        return (
          <>
            {/* Each side of a turn heads itself for a screen reader. */}
            <h2 className="sr-only">You said:</h2>
            <UserRow id={item.id} cid={item.cid} text={item.text} time={item.sentAt} dated={dated} files={item.files ?? []} draft={item.draft} />
          </>
        );
      }
      return (
        <>
        {(item.final || item.joined) && <Said backend={turn?.backend} />}
        <AssistantMessage
          text={item.text}
          final={actions && (item.final === true || item.joined === true)}
          time={item.sentAt}
          fork={fork}
          older={older}
        >
          <Markdown text={item.text} keep={item.id} at={item.sentAt} />
        </AssistantMessage>
        </>
      );
    case "reasoning":
      // Finished thinking isn't drawn: "Worked for …" covers it.
      return item.streaming ? <ThinkingLine heading={item.heading} /> : null;
    case "tool": {
      const ms = item.startedAt !== undefined && item.endedAt != null ? item.endedAt - item.startedAt : null;
      return (
        <ToolRow
          keep={item.id}
          kind={item.step}
          name={item.name}
          input={item.input}
          output={item.output}
          progress={item.progress}
          exitCode={item.exitCode}
          took={step && ms !== null && ms >= 1000 ? `in ${duration(ms)}` : undefined}
        />
      );
    }
    case "fileChange":
      return (
        <div className="flex flex-col gap-1">
          {item.changes.map((change, at) => (
            <FileChangeRow key={at} keep={`${item.id}:${at}`} change={change} progress={item.progress} />
          ))}
        </div>
      );
    case "approval": {
      const shown = describe(item.request);
      return <ApprovalRow keep={item.id} title={shown.title} detail={shown.detail} body={shown.body} decision={item.decision} action={item.request.action} waiting={turn?.status === "running"} />;
    }
    case "question":
      return <QuestionRow keep={item.id} question={item.question} answer={item.answer} round={item.request} answers={item.answers} waiting={!item.withdrawn && turn?.status === "running"} />;
    case "childAgent":
      return (
        <ChildAgentRow
          keep={item.id}
          title={item.title}
          progress={item.progress}
          startedAt={item.startedAt}
          endedAt={item.endedAt}
          current={item.current}
          steps={item.steps}
          answer={item.answer}
        />
      );
    case "compaction":
      // Without a reported progress it draws as done (D71): nothing says it is still the live tail.
      return <CompactionDivider progress={item.progress} />;
    case "notice":
      if (!("reason" in item)) return <NoticeRow level={item.level} text={item.text} />;
      if (item.reason === "blocked") {
        return (
          <InlineStatus icon={ShieldExclamation} tip={item.text || undefined}>
            The agent’s safety checks held this reply back
          </InlineStatus>
        );
      }
      if (item.reason === "failed") {
        const words = item.cause === "capacity" ? "The model’s servers are busy, so this turn didn’t finish" : FAILED[item.why];
        return <ErrorState summary={words} details={item.text} action={again} />;
      }
      if (item.reason === "untrusted") return <NoticeRow level="info" text="This folder is no longer trusted, so this turn runs under Ask." />;
      // Sign-in lives on Settings › Providers [D347, D381, D2054].
      return (
        <NoticeRow
          level="error"
          text={item.text}
          link={
            <a href="#settings/providers" className="ms-1.5 whitespace-nowrap text-link hover:underline">
              Open Providers
            </a>
          }
        />
      );
    case "line":
      return <ChangeLine item={item} />;
    case "unknown":
      return <UnknownRow keep={item.id} raw={item.raw} />;
    // The app draws it (its switch needs the session); see thread/rows.tsx.
    case "switch":
    case "team":
    case "team_step":
    case "team_still":
    case "peer":
      return null;
  }
}
