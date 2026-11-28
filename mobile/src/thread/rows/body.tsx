// One item's row by its kind, after the desktop's components/thread/body.tsx and thread/rows.tsx.
import type { Item, Turn } from "../../../../app/shared/thread";
import { ApprovalRow, QuestionRow } from "./asks";
import { FileChangeItem } from "./file-change";
import { AssistantMessage, PeerBubble, ThinkingLine, ThoughtRow, UserBubble } from "./message";
import { ForkedLine, ImageRow, MockupRow, OvernightRow, PeerRow, StartedLine } from "./moments";
import { ChangeLine, Compaction, NoticeItem, SwitchRow } from "./notices";
import { OnMac } from "./parts";
import { SubagentRow, TeamRow } from "./team";
import { ShellRow, ToolItem } from "./tool";

/**
 * One item's row. `step` marks one of an opened group's steps, a command saying its line alone [D95]; `actions`
 * false keeps a final answer's marks off it, for the marks line under it to draw.
 */
export function Body({ item, turn, step, actions = true, batch }: { item: Item; turn: Turn | undefined; step: boolean; actions?: boolean; batch?: Extract<Item, { kind: "childAgent" }>[] }) {
  switch (item.kind) {
    case "group":
      return null;
    case "message":
      if (item.origin === "peer" && item.from) return <PeerBubble item={item} />;
      if (item.role === "user") return <UserBubble item={item} />;
      return <AssistantMessage item={item} final={actions && item.final === true} />;
    case "reasoning":
      // A thought is a line of the work; while it streams, the live line [D752].
      return item.streaming ? <ThinkingLine heading={item.heading} /> : <ThoughtRow item={item} />;
    case "tool":
      return <ToolItem item={item} turn={turn} bare={step} />;
    case "fileChange":
      return <FileChangeItem item={item} />;
    case "approval":
      return <ApprovalRow item={item} turn={turn} />;
    case "question":
      return <QuestionRow item={item} turn={turn} />;
    case "childAgent":
      return <SubagentRow items={batch ?? [item]} />;
    case "compaction":
      // Without a reported progress it draws as done (D71).
      return <Compaction progress={item.progress} />;
    case "notice":
      return <NoticeItem item={item} />;
    case "line":
      return <ChangeLine item={item} />;
    case "switch":
      return <SwitchRow item={item} />;
    case "team":
    case "team_step":
    case "team_still":
      return <TeamRow item={item} />;
    case "mockup":
      return <MockupRow item={item} />;
    case "overnight":
      return <OvernightRow item={item} />;
    case "peer":
      return <PeerRow item={item} />;
    case "shell":
      return <ShellRow item={item} />;
    case "started":
      return <StartedLine item={item} />;
    case "forked":
      return <ForkedLine item={item} />;
    case "image":
      return <ImageRow item={item} />;
    default:
      // `unknown`, and any kind newer than this app.
      return <OnMac />;
  }
}
