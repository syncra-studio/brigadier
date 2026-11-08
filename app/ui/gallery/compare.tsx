// Gallery-only, for the owner's pick: two error rows as they are and drawn with the kit's ErrorLine.
// Deleted before landing.
import { type ReactNode, useEffect, useRef } from "react";

import { ErrorLine } from "../src/components/error-line";
import { OpeningRow, StepIcon, Words } from "../src/components/thread/activity-row";
import { Body } from "../src/components/thread/body";
import type { Item, Turn } from "../src/thread/item";
import { Row, Section } from "./parts";

const TURN: Turn = { id: "c-turn", status: "done", startedAt: 0, endedAt: 1 };
const NOTICE = "The connection dropped before the reply finished.";
const failedTool: Item = { id: "c-tool", turnId: TURN.id, kind: "tool", step: "other", name: "linear.search_issues", input: "", output: "", progress: "failed", exitCode: null };

/** Opens the row inside it once, as a click would. */
function Opened({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => box.current?.querySelector<HTMLElement>('[aria-expanded="false"]')?.click(), []);
  return <div ref={box}>{children}</div>;
}

function Side({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex w-80 min-w-0 flex-col gap-2">
      <span className="text-2xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function ErrorCompare() {
  return (
    <Section title="Errors · Current | With ErrorLine">
      <Row name="Thread error notice">
        <Side label="Current">
          <Body item={{ id: "c-n1", turnId: TURN.id, kind: "notice", level: "error", text: NOTICE }} turn={TURN} step={false} />
        </Side>
        <Side label="With ErrorLine">
          <ErrorLine size="sm" error={NOTICE} />
        </Side>
      </Row>
      <Row name="Failed tool step, opened">
        <Side label="Current">
          <Opened>
            <Body item={failedTool} turn={TURN} step={false} />
          </Opened>
        </Side>
        <Side label="With ErrorLine">
          <Opened>
            <OpeningRow
              keep="c-tool-errorline"
              detail={
                <div className="flex min-w-0 flex-col gap-1 pt-1">
                  <ErrorLine size="sm" error="linear.search_issues failed." />
                </div>
              }
            >
              <StepIcon kind="other" />
              <Words verb="Used" object="linear.search_issues — failed" />
            </OpeningRow>
          </Opened>
        </Side>
      </Row>
    </Section>
  );
}
