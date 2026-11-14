import { memo, useContext } from "react";

import { AnswerMarks } from "../components/thread/message";
import { Body, GroupLine } from "../components/thread/body";
import { RewindContext } from "../components/thread/rewind";
import { WorkHeader } from "../components/thread/work";
import { SwitchRow } from "../accounts/limit";
import { SideLine } from "../session/side";
import { ForkAction, ForkedLine } from "../session/fork";
import { FailedActions, GoOn } from "../session/notices";
import { SetupRow } from "../components/thread/setup";
import { DrawBoundary } from "../components/thread/error-state";
import { PeerRow } from "../peers/live";
import { TeamRow } from "../workers/live";
import type { Gap, Line } from "./lines";
import "./markdown.css";

// The first row clears find's bar (find.tsx), as the old app's did.
const GAPS: Record<Gap, string> = { first: "pt-thread-find-top", turn: "pt-6", part: "pt-4", step: "pt-1" };

export type LineProps = Line & { onToggle: (id: string) => void; dated?: boolean; older?: boolean };

/**
 * The one place a line becomes a row component: the kit's thread rows plug in here. The list owns the column and
 * the space above each row; a row draws only its content. Rows draw again only when one of their props changes.
 */
export const LineRow = memo(function LineRow(props: LineProps) {
  const rewind = useContext(RewindContext);
  const gone = rewind?.gone("item" in props ? props.item.n : undefined, "turn" in props ? props.turn?.id : undefined);
  const fork = "turn" in props && props.turn && <ForkAction at={props.turn.id} />;
  return (
    <div className={`mx-auto w-full max-w-reading px-5 ${GAPS[props.gap]} ${gone ? "opacity-row-disabled" : ""}`} data-item={props.id}>
      {/* A row that throws while it's drawn leaves the rest of the thread standing (D490). */}
      <DrawBoundary summary={props.type === "item" && props.item.kind === "message" ? "This message couldn’t be shown" : "This part couldn’t be shown"}>
      {props.type === "setup" ? (
        <SetupRow keep={props.id} setup={props.setup} />
      ) : props.type === "marks" ? (
        <AnswerMarks text={props.item.text} time={props.item.sentAt} fork={fork} older={props.older} />
      ) : props.type === "work" ? (
        <WorkHeader turn={props.turn} work={props.work} open={props.open} onToggle={props.onToggle} />
      ) : props.type === "group" ? (
        <GroupLine {...props} />
      ) : props.item.kind === "switch" ? (
        <SwitchRow item={props.item} />
      ) : props.item.kind === "team" || props.item.kind === "team_step" || props.item.kind === "team_still" ? (
        <TeamRow item={props.item} />
      ) : props.item.kind === "peer" ? (
        <PeerRow item={props.item} />
      ) : props.item.kind === "started" ? (
        <SideLine item={props.item} />
      ) : props.item.kind === "forked" ? (
        <ForkedLine item={props.item} />
      ) : (
        <Body
          item={props.item}
          turn={props.turn}
          step={props.step}
          dated={props.dated}
          older={props.older}
          actions={props.item.kind !== "message" || !props.item.final || props.actions === true}
          fork={fork}
          again={props.item.kind === "notice" && "why" in props.item ? <FailedActions turn={props.item.turnId} why={props.item.why} /> : props.item.kind === "line" && props.item.reason === "stalled" && <GoOn turn={props.item.turnId} />}
        />
      )}
      </DrawBoundary>
    </div>
  );
});
