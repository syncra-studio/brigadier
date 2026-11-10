// The summary card [D1014, D1048, D1098]: its git section in each state on fake data, then its frame at each pane width.
import { Button } from "../src/components/button";
import { GitCard } from "../src/panel/card";
import { CLEAN, COMMITTED, MERGING, PRS, STAGED, STEPS } from "../src/panel/fake";
import type { SourceData } from "../src/panel/source/panel";
import { SummaryCard, SummaryPane, useCardToggle } from "../src/shell/summary-card";
import { Row, Section, State } from "./parts";

const NOW = Date.now();
const CONFLICT_PRS = [{ ...PRS[0]!, health: "conflicts" as const, failed: 0 }, PRS[1]!];

/** The states the owner checks the card in [D1048, D1098], then the data states [D30]. */
const CARDS: [string, SourceData, boolean?][] = [
  ["Nothing changed", { source: CLEAN, step: STEPS.commit }],
  ["Changes: #12 failing, #11 merged", { source: STAGED, step: STEPS.commitWaiting, prs: PRS }],
  ["Ready to merge", { source: COMMITTED, step: STEPS.merge }],
  ["A PR with failing checks", { source: COMMITTED, step: STEPS.fixPr, prs: PRS }],
  ["A conflict: catching up with main", { source: MERGING, step: STEPS.continue, prs: CONFLICT_PRS }],
  ["Loading", { source: null, step: null }],
  ["Couldn't read", { source: null, step: null, error: "git exited with 128" }],
  ["Disconnected: last read, read-only", { source: STAGED, step: STEPS.commitWaiting, prs: PRS, offline: true }],
  ["Pending: the button at work", { source: COMMITTED, step: STEPS.merge }, true],
];

/** A thread pane with a few rows and a composer, so the frame's layouts show what they move. */
function Pane({ owner, width, label }: { owner: string; width: string; label: string }) {
  const { shown, toggle } = useCardToggle(owner);
  // Scrolls where the window is narrower than the pane, so each keeps the width its layout needs.
  return (
    <div className="max-w-full overflow-x-auto pb-2">
      <State label={label}>
        <div className="flex flex-col items-start gap-2">
          <Button size="sm" variant="soft" onClick={toggle}>
            {shown ? "Hide the card" : "Show the card"}
          </Button>
          <div className={`flex h-120 overflow-hidden rounded-surface border border-border bg-background ${width}`}>
            <SummaryPane owner={owner} card={<GitCard data={{ source: STAGED, step: STEPS.commitWaiting, prs: PRS }} nowMs={NOW} />}>
              <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto pt-8">
                {["Make failed uploads retry three times with a growing wait.", "Done: uploads retry with a growing wait, capped at 30 seconds, and 4xx errors don't retry.", "Show the progress in the tray too."].map((text, index) => (
                  <p key={text} className={`mx-auto w-full max-w-reading px-6 text-sm ${index % 2 === 0 ? "text-end" : ""}`}>
                    <span className={index % 2 === 0 ? "inline-block rounded-surface bg-muted px-3 py-2 text-start" : ""}>{text}</span>
                  </p>
                ))}
              </div>
              <div className="mx-auto w-full max-w-reading shrink-0 px-4 pb-4">
                <div className="h-24 rounded-surface border border-border bg-card" />
              </div>
            </SummaryPane>
          </div>
        </div>
      </State>
    </div>
  );
}

export function CardGallery() {
  return (
    <Section title="Summary card">
      <Row name="Card states">
        {CARDS.map(([label, data, running]) => (
          <State key={label} label={label}>
            {/* Its own stacking context, so the card stays under the section's sticky title. */}
            <div className="relative isolate h-72 w-81">
              <SummaryCard shown>
                <GitCard data={data} nowMs={NOW} running={running} />
              </SummaryCard>
            </div>
          </State>
        ))}
      </Row>
      <Row name="The frame by the pane's width: beside the column, the column moved aside, floating only when asked">
        <Pane owner="gallery-card-beside" width="w-390" label="Wide: beside the thread's column" />
        <Pane owner="gallery-card-shift" width="w-250" label="Narrower: the column moves aside" />
        <Pane owner="gallery-card-float" width="w-180" label="Narrow: hidden until asked, then over the thread; Escape closes it" />
      </Row>
    </Section>
  );
}
