// The one place a line becomes a row, as the desktop's thread/rows.tsx LineRow: the list owns the column, the row its content.
import { Component, memo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { sentAt } from "../../vendor/brigadier-shared/words";
import { color, text } from "../theme";
import type { Gap, Line } from "../../vendor/brigadier-shared/lines";
import { Body } from "./rows/body";
import { AnswerMarks } from "./rows/message";
import { ErrorLine } from "./rows/parts";
import { SetupRow } from "./rows/setup";
import { GroupLine, WorkHeader } from "./rows/work";

// An even 12 between rows [D84] and 32 over the user's message; the first row's space is the list's own padding.
const GAPS: Record<Gap, number> = { first: 0, input: 32, turn: 12, part: 12, step: 4 };

/** `dated`: a user's message with its date above, as `datedMessages` says. */
export const Row = memo(function Row({ line, onToggle, dated }: { line: Line; onToggle: (id: string) => void; dated?: boolean }) {
  const at = dated && line.type === "item" && line.item.kind === "message" ? line.item.sentAt : undefined;
  return (
    <View style={{ paddingTop: GAPS[line.gap] }}>
      {at !== undefined && <Text style={{ ...text.sm, color: color.mutedForeground, textAlign: "center", paddingBottom: 12 }}>{sentAt(at)}</Text>}
      <DrawBoundary summary={line.type === "item" && line.item.kind === "message" ? "This message couldn’t be shown" : "This part couldn’t be shown"}>
        {line.type === "setup" ? (
          <SetupRow keep={line.id} setup={line.setup} />
        ) : line.type === "marks" ? (
          <AnswerMarks time={line.item.sentAt} />
        ) : line.type === "work" ? (
          <WorkHeader turn={line.turn} work={line.work} open={line.open} onToggle={onToggle} />
        ) : line.type === "group" ? (
          <GroupLine {...line} onToggle={onToggle} />
        ) : (
          <Body item={line.item} turn={line.turn} step={line.step} batch={line.batch} actions={line.item.kind !== "message" || !line.item.final || line.actions === true} />
        )}
      </DrawBoundary>
    </View>
  );
});

/** A row that throws while it's drawn leaves the rest of the thread standing (D490). */
class DrawBoundary extends Component<{ summary: string; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <ErrorLine error={this.props.summary} /> : this.props.children;
  }
}
