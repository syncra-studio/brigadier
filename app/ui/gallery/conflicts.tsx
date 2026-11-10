// Step 2.11's conflict tab on fake data [D1044]: in place, Compare, their states, Resolve with agent and the chip it leaves.
import { useState } from "react";

import { type AgentChip } from "../src/landing/agent-chip";
import { Button } from "../src/components/button";
import { CompareView, ConflictTab } from "../src/landing/conflict-tab";
import type { Accepting, Choice, Conflict, ConflictFile, Segment } from "../src/landing/conflicts";
import { ChipsComposer, TabFrame } from "./landing-parts";
import { Row, Section, State } from "./parts";

// The old conflict-tab fixture's file: two conflicts in src/cart/total.ts, catching up with main.
const conflict = (id: string, current: string, incoming: string, base: string | null): Conflict => ({
  type: "conflict",
  id,
  current: [current],
  base: base === null ? null : [base],
  incoming: [incoming],
  currentLabel: "HEAD",
  baseLabel: "Base",
  incomingLabel: "main",
  size: 7,
});
const segments = (withBase: boolean): Segment[] => [
  { type: "common", lines: ['import { couponFor } from "./coupon";\n', "export function total(cart) {\n"] },
  conflict("c1", "  return cart.member ? 9 : 10;\n", "  return couponFor(cart).apply(10);\n", withBase ? "  return 10;\n" : null),
  { type: "common", lines: ["}\n", "export function shipping(cart) {\n"] },
  conflict("c2", "  return cart.total > 50 ? 0 : 4.99;\n", "  return cart.express ? 9.99 : 4.99;\n", withBase ? "  return 4.99;\n" : null),
  { type: "common", lines: ["}\n"] },
];
const FILE: ConflictFile = {
  path: "src/cart/total.ts",
  segments: segments(false),
  current:
    'import { couponFor } from "./coupon";\nexport function total(cart) {\n  return cart.member ? 9 : 10;\n}\nexport function shipping(cart) {\n  return cart.total > 50 ? 0 : 4.99;\n}\n',
  incoming:
    'import { couponFor } from "./coupon";\nexport function total(cart) {\n  return couponFor(cart).apply(10);\n}\nexport function shipping(cart) {\n  return cart.express ? 9.99 : 4.99;\n}\n',
  currentLabel: "0288795 • brigadier/912a9469/session",
  incomingLabel: "11e363f • main",
  rebasing: null,
};
const RESOLVE: AgentChip = { id: "resolve", kind: "resolve", conflicts: 2, files: 2, operation: "merging", onto: "main" };
const noop = () => {};

/** Rust's side, faked: the conflict becomes the lines picked. Gallery only; the real file comes back from Rust. */
function accepted(file: ConflictFile, id: string, choice: Choice): ConflictFile {
  const parts = (file.segments ?? []).map((segment): Segment => {
    if (segment.type === "common" || segment.id !== id) return segment;
    const lines = choice === "current" ? segment.current : choice === "incoming" ? segment.incoming : [...segment.current, ...segment.incoming];
    return { type: "common", lines };
  });
  return { ...file, segments: parts };
}

/** The tab live: accepts show at once and settle a moment later (or fail, with `fails`); Resolve with agent leaves a chip. */
function Live({ fails = false }: { fails?: boolean }) {
  const [file, setFile] = useState(FILE);
  const [accepting, setAccepting] = useState<Record<string, Accepting>>({});
  const [chips, setChips] = useState<AgentChip[]>([]);
  // The tab's view; the real tab keeps it per tab (2.23). The way back is the gallery's own.
  const [comparing, setComparing] = useState(false);
  const accept = (id: string, choice: Choice) => {
    setAccepting((now) => ({ ...now, [id]: { choice } }));
    setTimeout(() => {
      if (fails) {
        setAccepting((now) => ({ ...now, [id]: { choice, error: "src/cart/total.ts changed since it was read" } }));
        return;
      }
      setFile((now) => accepted(now, id, choice));
      setAccepting(({ [id]: _, ...rest }) => rest);
    }, 700);
  };
  return (
    <div className="flex flex-col gap-3">
      <TabFrame>
        {comparing ? (
          <CompareView file={file} />
        ) : (
          <ConflictTab
            file={file}
            accepting={accepting}
            onAccept={accept}
            onCompare={() => setComparing(true)}
            onResolveWithAgent={() => setChips((now) => (now.some((chip) => chip.id === RESOLVE.id) ? now : [...now, RESOLVE]))}
          />
        )}
      </TabFrame>
      {comparing && (
        <Button variant="soft" size="xs" className="self-start" onClick={() => setComparing(false)}>
          Back to the conflicts
        </Button>
      )}
      <ChipsComposer chips={chips} onRemove={(id) => setChips((now) => now.filter((chip) => chip.id !== id))} />
    </div>
  );
}

export function ConflictsGallery() {
  return (
    <Section title="Conflict tab (step 2.11)">
      <Row name="live: accept a side, Compare Changes, Resolve with agent leaves a chip above the composer and sends nothing">
        <State label="accepts settle">
          <Live />
        </State>
        <State label="accepts fail: the file changed since it was read">
          <Live fails />
        </State>
      </Row>
      <Row name="in place: with the common version marked · rebasing · an accept on its way · one that failed">
        <State label="common version (diff3)">
          <TabFrame>
            <ConflictTab file={{ ...FILE, segments: segments(true) }} onAccept={noop} onCompare={noop} onResolveWithAgent={noop} />
          </TabFrame>
        </State>
        <State label="rebasing">
          <TabFrame>
            <ConflictTab file={{ ...FILE, rebasing: { step: 2, total: 5, subject: "Cap the retry wait" } }} onAccept={noop} onCompare={noop} onResolveWithAgent={noop} />
          </TabFrame>
        </State>
        <State label="accepting incoming, on its way">
          <TabFrame>
            <ConflictTab file={FILE} accepting={{ c1: { choice: "incoming" } }} onAccept={noop} onCompare={noop} onResolveWithAgent={noop} />
          </TabFrame>
        </State>
        <State label="an accept failed">
          <TabFrame>
            <ConflictTab file={FILE} accepting={{ c1: { choice: "both", error: "src/cart/total.ts changed since it was read" } }} onAccept={noop} onCompare={noop} onResolveWithAgent={noop} />
          </TabFrame>
        </State>
      </Row>
      <Row name="loading · couldn't read · one side deleted it · no conflicts left · disconnected">
        <State label="loading">
          <TabFrame>
            <ConflictTab file={undefined} onAccept={noop} onCompare={noop} onResolveWithAgent={noop} />
          </TabFrame>
        </State>
        <State label="couldn't read">
          <TabFrame>
            <ConflictTab file={undefined} error="Couldn't read src/cart/total.ts: it's no longer in conflict" onAccept={noop} onCompare={noop} onResolveWithAgent={noop} />
          </TabFrame>
        </State>
        <State label="one side deleted it">
          <TabFrame>
            <ConflictTab file={{ ...FILE, segments: null, incoming: null }} onAccept={noop} onCompare={noop} onResolveWithAgent={noop} />
          </TabFrame>
        </State>
        <State label="no conflicts left">
          <TabFrame>
            <ConflictTab file={accepted(accepted(FILE, "c1", "incoming"), "c2", "current")} onAccept={noop} onCompare={noop} onResolveWithAgent={noop} />
          </TabFrame>
        </State>
        <State label="disconnected">
          <TabFrame>
            <ConflictTab file={FILE} offline onAccept={noop} onCompare={noop} onResolveWithAgent={noop} />
          </TabFrame>
        </State>
      </Row>
      <Row name="Compare Changes: both sides whole, side by side · loading · couldn't read · disconnected">
        <State label="compare">
          <TabFrame>
            <CompareView file={FILE} />
          </TabFrame>
        </State>
        <State label="loading">
          <TabFrame>
            <CompareView file={undefined} />
          </TabFrame>
        </State>
        <State label="couldn't read">
          <TabFrame>
            <CompareView file={undefined} error="Couldn't read src/cart/total.ts: it's no longer in conflict" />
          </TabFrame>
        </State>
        <State label="disconnected">
          <TabFrame>
            <CompareView file={undefined} offline />
          </TabFrame>
        </State>
      </Row>
      <Row name="the chip Resolve with agent leaves">
        <State label="above the composer">
          <ChipsComposer chips={[RESOLVE]} onRemove={noop} />
        </State>
      </Row>
    </Section>
  );
}
