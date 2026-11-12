import { memo, useContext } from "react";

import { AnswerMarks } from "../components/thread/message";
import { Body } from "../components/thread/body";
import { RewindContext } from "../components/thread/rewind";
import { GroupRow, WorkHeader } from "../components/thread/work";
import { SwitchRow } from "../accounts/limit";
import { SideLine } from "../session/side";
import { ForkAction, ForkedLine } from "../session/fork";
import { FailedActions } from "../session/notices";
import { SetupRow } from "../components/thread/setup";
import { DrawBoundary } from "../components/thread/error-state";
import { PeerRow } from "../peers/live";
import { TeamRow } from "../workers/live";
import type { Gap, Line } from "./lines";
import "./markdown.css";

// The first row clears find's bar (find.tsx), as the old app's did.
const GAPS: Record<Gap, string> = { first: "pt-thread-find-top", turn: "pt-6", part: "pt-4", step: "pt-1" };

export type LineProps = Line & { onToggle: (id: string) => void; dated?: boolean };

/** A group's row and, opened, its steps: the thread's and a worker's in its panel. */
export function GroupLine({ item, live, open, steps, onToggle }: Extract<Line, { type: "group" }> & { onToggle: (id: string) => void }) {
  return (
    <>
      <GroupRow item={item} live={live} open={open} onToggle={onToggle} />
      {/* Opened: up to 14rem of its steps 4px apart, then they scroll, their edges fading while there is more (the old app's). */}
      {open && steps.length > 0 && (
        <div className="flex max-h-group-list min-w-0 scroll-edge-fade edge-fade-group flex-col gap-1 overflow-y-auto pt-1 *:shrink-0">
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

/**
 * The one place a line becomes a row component: the kit's thread rows plug in here. The list owns the column and
 * the space above each row; a row draws only its content. Rows draw again only when one of their props changes.
 */
export const LineRow = memo(function LineRow(props: LineProps) {
  const rewind = useContext(RewindContext);
  const gone = rewind?.gone("item" in props ? props.item.n : undefined, "turn" in props ? props.turn?.id : undefined);
  const fork = "turn" in props && props.turn && <ForkAction at={props.turn.id} />;
  return (
    <div className={`mx-auto w-full max-w-reading px-6 ${GAPS[props.gap]} ${gone ? "opacity-row-disabled" : ""}`} data-item={props.id}>
      {/* A row that throws while it's drawn leaves the rest of the thread standing (D490). */}
      <DrawBoundary summary={props.type === "item" && props.item.kind === "message" ? "This message couldn’t be shown" : "This part couldn’t be shown"}>
      {props.type === "setup" ? (
        <SetupRow key={`${props.id}:${props.setup.state === "running"}`} keep={props.id} setup={props.setup} />
      ) : props.type === "marks" ? (
        <AnswerMarks text={props.item.text} time={props.item.sentAt} fork={fork} />
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
          actions={props.item.kind !== "message" || !props.item.final || props.actions === true}
          fork={fork}
          again={props.item.kind === "notice" && "why" in props.item && <FailedActions turn={props.item.turnId} why={props.item.why} />}
        />
      )}
      </DrawBoundary>
    </div>
  );
});
