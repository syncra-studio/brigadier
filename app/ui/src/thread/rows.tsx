import { memo } from "react";

import { AnswerMarks } from "../components/thread/message";
import { Body } from "../components/thread/body";
import { GroupRow, WorkHeader } from "../components/thread/work";
import { SwitchRow } from "../accounts/limit";
import { SideLine } from "../session/side";
import type { Gap, Line } from "./lines";
import "./markdown.css";

const GAPS: Record<Gap, string> = { first: "pt-8", turn: "pt-6", part: "pt-4", step: "pt-1" };

export type LineProps = Line & { onToggle: (id: string) => void; dated?: boolean; latest?: boolean };

/**
 * The one place a line becomes a row component: the kit's thread rows plug in here. The list owns the column and
 * the space above each row; a row draws only its content. Rows draw again only when one of their props changes.
 */
export const LineRow = memo(function LineRow(props: LineProps) {
  return (
    <div className={`mx-auto w-full max-w-reading px-6 ${GAPS[props.gap]}`} data-item={props.id}>
      {props.type === "marks" ? (
        <AnswerMarks text={props.item.text} time={props.item.sentAt} latest={props.latest} />
      ) : props.type === "work" ? (
        <WorkHeader turn={props.turn} work={props.work} open={props.open} onToggle={props.onToggle} />
      ) : props.type === "group" ? (
        <GroupRow item={props.item} live={props.live} open={props.open} onToggle={props.onToggle} />
      ) : props.item.kind === "switch" ? (
        <SwitchRow item={props.item} />
      ) : props.item.kind === "started" ? (
        <SideLine item={props.item} />
      ) : (
        <Body item={props.item} turn={props.turn} step={props.step} dated={props.dated} latest={props.latest} actions={!(props.item.kind === "message" && props.item.final)} />
      )}
    </div>
  );
});
