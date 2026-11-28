// The one place a line becomes a row, as the desktop's thread/rows.tsx LineRow: the list owns the column, the row its content.
import { Component, memo, type ReactNode } from "react";
import { Text, View } from "react-native";
import { datedWords } from "../../../app/shared/words";
import { space } from "../theme";
import type { Gap, Line } from "../../../app/shared/lines";
import { Body } from "./rows/body";
import { AnswerMarks } from "./rows/message";
import { ErrorState, s } from "./rows/parts";
import { SetupRow } from "./rows/setup";
import { GroupLine, WorkHeader } from "./rows/work";

// The first row 32 under the top; then an even 12 between rows [D84], and 32 over the user's message.
const GAPS: Record<Gap, number> = { first: space(8), input: space(8), turn: space(3), part: space(3), step: space(1) };

/** `dated`: a user's message with its date above, as `datedMessages` says. */
export const Row = memo(function Row({ line, onToggle, dated }: { line: Line; onToggle: (id: string) => void; dated?: boolean }) {
  const at = dated && line.type === "item" && line.item.kind === "message" ? line.item.sentAt : undefined;
  return (
    <View style={{ paddingTop: GAPS[line.gap] }}>
      {at !== undefined && <Text style={[s.row, { textAlign: "center", paddingBottom: space(3) }]}>{datedWords(at)}</Text>}
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

/** A row that throws while it's drawn leaves the rest of the thread standing; Try again only draws it afresh (D490). */
class DrawBoundary extends Component<{ summary: string; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
  override render() {
    const { error } = this.state;
    return error ? <ErrorState summary={this.props.summary} details={error.stack ?? error.message} onRetry={() => this.setState({ error: null })} /> : this.props.children;
  }
}
