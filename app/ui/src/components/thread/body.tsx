import type { Item, Turn } from "../../thread/item";
import { Markdown } from "../../thread/markdown";
import { duration } from "../../thread/words";
import { ApprovalRow, ChildAgentRow, CompactionDivider, NoticeRow, QuestionRow, UnknownRow } from "./cards";
import { FileChangeRow } from "./file-change";
import { AssistantMessage, SystemLine, ThinkingLine, UserBubble } from "./message";
import { ToolRow } from "./tool";

/**
 * One item's row, by its kind. `step` marks one of an opened group's steps, which says how long it took.
 * `turn` says whether a question still waits (its turn runs). `dated`: a user's message with its date above;
 * `latest`: the newest answer, whose time always shows.
 */
export function Body({ item, turn, step, dated = false, latest = false }: { item: Item; turn: Turn | undefined; step: boolean; dated?: boolean; latest?: boolean }) {
  switch (item.kind) {
    case "group":
      return null;
    case "message":
      if (item.origin === "system") return <SystemLine text={item.text} />;
      if (item.role === "user") return <UserBubble keep={item.id} text={item.text} time={item.sentAt} dated={dated} />;
      return (
        <AssistantMessage text={item.text} streaming={item.streaming} time={item.sentAt} latest={latest}>
          <Markdown text={item.text} keep={item.id} />
        </AssistantMessage>
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
    case "approval":
      return <ApprovalRow keep={item.id} title={item.title} detail={item.detail} decision={item.decision} action={item.action} waiting={turn?.status === "running"} />;
    case "question":
      return <QuestionRow keep={item.id} question={item.question} answer={item.answer} waiting={turn?.status === "running"} />;
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
      return <NoticeRow level={item.level} text={item.text} />;
    case "unknown":
      return <UnknownRow keep={item.id} raw={item.raw} />;
  }
}
