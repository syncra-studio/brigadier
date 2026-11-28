import { type ReactNode, useContext } from "react";

import { SessionOfThread } from "../../accounts/limit";
import { PeerBubble } from "../../peers/live";
import type { Item, SentFile, Turn } from "../../thread/item";
import { useKept } from "../../thread/kept";
import { type Group, type Line, running } from "../../thread/lines";
import { Markdown } from "../../thread/markdown";
import { AnswerRefs } from "../../thread/refs";
import { tidy } from "../../../../shared/markdown";
import { approvalSubject } from "../../../../shared/cards";
import { useAgentLabel } from "../../onboarding/api";
import { describe } from "../composer/approval";
import { SentAttachments } from "../composer/attachments";
import type { Draft } from "../composer/draft";
import { PASTE_LABEL, PR_FIX } from "../../shell/attachment-tab";
import { openAttachment } from "../../shell/tab-store";
import { STEPS } from "./activity-row";
import { ApprovalRow, CompactionDivider, NoticeRow, QuestionRow, UnknownRow } from "./cards";
import { FileChangeRow } from "./file-change";
import { ArrowRotateCw, Plug, ShieldExclamation } from "../../icons";
import { ChangeLine, InlineStatus, ThreadLine } from "./line";
import { AssistantMessage, ThinkingLine, UserBubble } from "./message";
import { ErrorState } from "./error-state";
import { RewindContext } from "./rewind";
import { SubagentRow } from "../../workers/subagents";
import { ToolRow } from "./tool";
import { GroupRow, ThoughtRow } from "./work";
import { NOTICE_WORDS, FAILED_CAUSE as CAUSE, TURN_FAILED as FAILED } from "../../../../shared/words";

function UserRow({ id, cid, text, time, dated, files, draft, older }: { older?: boolean; id: string; cid: string | undefined; text: string; time: number | undefined; dated: boolean; files: readonly SentFile[]; draft?: Draft | null }) {
  const offer = useContext(RewindContext)?.offer(cid ?? "", text);
  const session = useContext(SessionOfThread)?.id;
  const at = (file: string) => `/attachment/${session}/${file}`;
  // An image or paste in the text shows there as its chip, not above as well, as the old app's [D2107].
  const inline = new Set(draft?.parts.flatMap((part) => (typeof part !== "string" && "attachmentId" in part ? [part.attachmentId] : [])));
  const above = files.filter((file) => !inline.has(file.id));
  const sent = session && above.length > 0 && (
    <SentAttachments files={above.map((file) => ({ ...file, url: at(file.id) }))} onOpen={(file) => openAttachment(session, file.id, file.pasted ? PASTE_LABEL : file.name)} />
  );
  // A message asking to repair a PR says so over it, "PR fix" [D171].
  const fix = draft?.parts.some((part) => typeof part !== "string" && part.kind === "paste" && PR_FIX.test(part.preview ?? "")) && <span className="w-fit text-sm text-muted-foreground">PR fix</span>;
  const bubble = <UserBubble keep={id} text={text} time={time} dated={dated} older={older} rewind={cid ? offer : undefined} files={fix ? <>{sent}{fix}</> : sent} owner={session} parts={draft?.parts} />;
  // Reaching the message asks Rust ahead, so its rewind dialog opens whole [D480]. No box of its own.
  return cid && offer ? (
    <div className="contents" onPointerEnter={offer.look} onFocus={offer.look}>
      {bubble}
    </div>
  ) : (
    bubble
  );
}

type StepLine = Pick<Extract<Line, { type: "item" }>, "id" | "item" | "turn" | "step">;

/**
 * The group line for every run of steps: the thread's, a worker's in its panel, a skill's [D697]. Live,
 * it is one line saying what it does now: its running step, its thought, or Thinking while it is the running
 * turn's latest run. Once the run ends, the line says what its steps did [D755, D762].
 */
export function GroupLine({ item, turn, open, steps, live, members, onToggle }: { item: Group; turn: Turn | undefined; open: boolean; steps: StepLine[]; live?: Item; members: readonly Item[]; onToggle: (id: string) => void }) {
  const going = turn?.status === "running" || turn?.held === true;
  const now = live?.kind === "reasoning" ? <ThinkingLine heading={live.heading} /> : live ? <Body item={live} turn={turn} step={false} /> : item.run && going && <ThinkingLine />;
  const ended = members.filter((member) => !running(member) && !(member.kind === "reasoning" && member.streaming));
  if (!now && !ended.length) return null;
  return (
    <>
      {now || <GroupRow item={item} members={ended} open={open} onToggle={onToggle} />}
      {/* Opened: all its steps 12 apart, under the words, on a guide line under the line's icon [D95, D762]. */}
      {open && steps.length > 0 && (
        <div className={STEPS}>
          {/* Each step marked, for find to go to a match in it. */}
          {steps.map((step) => (
            <div key={step.id} data-step={step.id}>
              <Body item={step.item} turn={step.turn} step={step.step} />
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/** A skill's own steps under its row as one group, as the thread groups steps: "Ran 16 commands", its running step in its place [D227]. */
function SkillSteps({ id, log, counts, turn }: { id: string; log: Item[]; counts: Group["steps"]; turn: Turn | undefined }) {
  const key = `${id}:steps`;
  const [open, setOpen] = useKept(key);
  const group: Group = { id: key, turnId: turn?.id ?? "", kind: "group", steps: counts, span: [0, 0] };
  const ended = log.filter((step) => !running(step)).map((step) => ({ id: step.id, item: step, turn, step: true }));
  return <GroupLine item={group} turn={turn} open={open} steps={ended} live={log.findLast(running)} members={log} onToggle={() => setOpen(!open)} />;
}

function Said({ backend }: { backend: string | undefined }) {
  return <h2 className="sr-only">{useAgentLabel(backend)} said:</h2>;
}



/**
 * One item's row, by its kind. `step` marks one of an opened group's steps, a command saying its line alone [D95].
 * `turn` says whether a question still waits (its turn runs). `dated`: a user's message with its date above. `again`:
 * a failed turn's actions, the app's (Retry and what its reason offers), or a line's (Continue).
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
            <UserRow id={item.id} cid={item.cid} text={item.draft?.shell ? "```sh\n" + item.draft.shell + "\n```" : item.text} time={item.sentAt} dated={dated} files={item.files ?? []} draft={item.draft?.shell ? null : item.draft} older={older} />
          </>
        );
      }
      // Drawn and copied with its shape repaired [D530].
      const shaped = tidy(item.text);
      return (
        <>
        {item.final && <Said backend={turn?.backend} />}
        <AssistantMessage
          text={shaped}
          final={actions && item.final === true}
          time={item.sentAt}
          fork={fork}
          older={older}
        >
          <AnswerRefs text={shaped} done={!item.streaming}>
            <Markdown text={shaped} keep={item.id} streaming={item.streaming} />
          </AnswerRefs>
        </AssistantMessage>
        </>
      );
    case "reasoning":
      // A thought is a line of the work; while it streams, the live line [D752].
      return item.streaming ? <ThinkingLine heading={item.heading} /> : <ThoughtRow item={item} />;
    case "tool": {
      return (
        <ToolRow
          keep={item.id}
          kind={item.step}
          name={item.name}
          input={item.input}
          output={item.output}
          progress={item.progress}
          exitCode={item.exitCode}
          line={item.command}
          bare={step}
          server={item.server}
          approval={item.approval}
          steps={item.log?.length ? <SkillSteps id={item.id} log={item.log} counts={item.logSteps ?? []} turn={turn} /> : undefined}
          description={item.description}
        />
      );
    }
    case "fileChange":
      return (
        <div className="flex flex-col gap-1">
          {item.changes.map((change, at) => (
            <FileChangeRow key={at} keep={`${item.id}:${at}`} change={change} progress={item.progress} approval={at === 0 ? item.approval : undefined} />
          ))}
        </div>
      );
    case "approval": {
      const shown = describe(item.request);
      return (
        <ApprovalRow
          keep={item.id}
          title={shown.title}
          detail={shown.detail}
          body={shown.body}
          decision={item.decision}
          action={item.request.action}
          waiting={turn?.status === "running" || turn?.held === true}
          subject={approvalSubject(item.request)}
          toParent={item.to === "parent"}
          byReview={item.by === "review"}
        />
      );
    }
    case "question":
      return <QuestionRow keep={item.id} question={item.question} answer={item.answer} round={item.request} answers={item.answers} files={item.files} waiting={!item.withdrawn && (turn?.status === "running" || turn?.held === true || (item.held === true && item.answer === null))} toParent={item.to === "parent"} />;
    case "childAgent":
      return <SubagentRow items={[item]} />;
    case "compaction":
      // Without a reported progress it draws as done (D71): nothing says it is still the live tail.
      return <CompactionDivider progress={item.progress} />;
    case "notice":
      if (!("reason" in item)) return <NoticeRow level={item.level} text={item.text} />;
      if (item.reason === "blocked") {
        return (
          <InlineStatus icon={ShieldExclamation} tip={item.text || undefined}>
            {NOTICE_WORDS.blocked}
          </InlineStatus>
        );
      }
      if (item.reason === "failed") {
        // Brigadier carried it on once the network was back: a quiet line, the error's words its tip [D339].
        if (item.resumed) return <ThreadLine icon={ArrowRotateCw} tip={item.text || undefined}>{NOTICE_WORDS.resumed}</ThreadLine>;
        return <ErrorState summary={item.cause ? CAUSE[item.cause] : FAILED[item.why]} details={item.text} action={again} />;
      }
      if (item.reason === "untrusted") return <NoticeRow level="info" text={NOTICE_WORDS.untrusted} />;
      // A library server's, beside the tool call it refused, is a quiet line with its Sign in (`again`) [D761].
      if (item.plugin) {
        return (
          <ThreadLine icon={Plug}>
            {item.text}
            <span className="ms-1.5 whitespace-nowrap">{again}</span>
          </ThreadLine>
        );
      }
      // An agent's sign-in lives on Settings › Providers [D347, D381, D2054].
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
      return <ChangeLine item={item} action={again} />;
    case "unknown":
      return <UnknownRow keep={item.id} raw={item.raw} />;
    // The app draws it (its switch needs the session); see thread/rows.tsx.
    case "switch":
    case "team":
    case "team_step":
    case "team_still":
    case "mockup":
    case "overnight":
    case "peer":
      return null;
  }
}
