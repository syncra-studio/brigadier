// Settings › Routing on fake data (4.5): the page as Rust's table would fill it, and its loading, error, offline and
// empty states. Not in Settings until its wiring lands [D2079].
import { type ReactNode, useState } from "react";

import { CheckboxRow } from "../src/components/checkbox-row";
import type { ModelGroup } from "../src/components/composer/model-picker";
import { type Routing, RoutingPage } from "../src/settings/routing";
import type { Results } from "../src/settings/routing-results";
import { Row, Section, State } from "./parts";

// Stand-in marks: no agent's real logo in gallery code.
const RING = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="5.5"/></svg>';
const DIAMOND = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/></svg>';
const EFFORTS = ["low", "medium", "high", "xhigh"];
export const FAKE_GROUPS: ModelGroup[] = [
  {
    provider: "cloud",
    label: "Cloud agent",
    short: "Cloud",
    mark: RING,
    models: [
      { id: "large", name: "Large model", efforts: EFFORTS, defaultEffort: "high" },
      { id: "medium", name: "Medium model", efforts: EFFORTS, defaultEffort: "medium" },
      { id: "small", name: "Small model", efforts: ["low", "medium"], defaultEffort: "low" },
    ],
  },
  {
    provider: "other",
    label: "Other agent",
    short: "Other",
    mark: DIAMOND,
    models: [
      { id: "big", name: "Big model", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { id: "mini", name: "Mini model", efforts: ["low", "medium", "high"], defaultEffort: "low" },
    ],
  },
];

const TABLE: Routing = {
  rows: {
    best: [
      { agent: "cloud", model: "large", effort: "high" },
      { agent: "other", model: "big", effort: "high" },
    ],
    standard: [
      { agent: "cloud", model: "medium", effort: "medium" },
      { agent: "other", model: "big", effort: "medium" },
    ],
    quick: [
      { agent: "cloud", model: "small", effort: "low" },
      { agent: "other", model: "mini", effort: null },
    ],
  },
  rules: [
    { never: "model", agent: "other", model: "mini" },
    { never: "above", effort: "high", agent: null },
  ],
  review: false,
  now: {
    best: { agent: "cloud", model: "large", effort: "high" },
    standard: { agent: "cloud", model: "medium", effort: "medium" },
    quick: { agent: "cloud", model: "small", effort: "low" },
  },
};

const RESULTS: Results = {
  models: [
    { agent: "cloud", model: "large", succeeded: 18, of: 20 },
    { agent: "cloud", model: "medium", succeeded: 31, of: 40 },
    { agent: "other", model: "big", succeeded: 7, of: 9 },
    { agent: "cloud", model: "small", succeeded: 5, of: 12 },
  ],
  reviews: { count: 6, findings: 14, fixed: 11, rejected: 3 },
};

/** A page in a box of its own, scrolled inside it as Settings scrolls it. */
function Frame({ tall = false, children }: { tall?: boolean; children: ReactNode }) {
  return <div className={tall ? "flex h-240 w-full overflow-hidden rounded-surface border border-divider bg-background" : "flex h-80 w-200 overflow-hidden rounded-surface border border-divider bg-background"}>{children}</div>;
}

export function RoutingGallery() {
  const [value, setValue] = useState<Routing>(TABLE);
  const [refuses, setRefuses] = useState(false);
  // Rust takes a change after a moment, or refuses it with its words.
  const save = (next: Routing) =>
    new Promise<Routing>((done, fail) =>
      setTimeout(() => {
        if (refuses) return fail(new Error("Couldn't save the routing: the agent's model list changed. Try again."));
        setValue(next);
        done(next);
      }, 600),
    );
  const still = () => Promise.resolve(TABLE);
  return (
    <Section title="Settings › Routing">
      <Row name="The page: open a row for My order; Add rule for its menu">
        <div className="flex w-full flex-col gap-3">
          <CheckboxRow label="Rust refuses changes" checked={refuses} onCheckedChange={setRefuses} />
          <Frame tall>
            <RoutingPage value={value} groups={FAKE_GROUPS} onChange={save} review results={RESULTS} />
          </Frame>
        </div>
      </Row>
      <Row name="States">
        <State label="Loading">
          <Frame>
            <RoutingPage value={null} groups={FAKE_GROUPS} onChange={still} />
          </Frame>
        </State>
        <State label="Can't be read">
          <Frame>
            <RoutingPage value={null} groups={FAKE_GROUPS} onChange={still} error="Couldn't read the routing: Brigadier stopped answering." />
          </Frame>
        </State>
        <State label="Brigadier isn't running">
          <Frame>
            <RoutingPage value={TABLE} groups={FAKE_GROUPS} onChange={still} offline />
          </Frame>
        </State>
        <State label="No results yet">
          <Frame>
            <RoutingPage value={{ ...TABLE, rules: [] }} groups={FAKE_GROUPS} onChange={still} results={{ models: [], reviews: null }} />
          </Frame>
        </State>
        <State label="Results loading">
          <Frame>
            <RoutingPage value={{ ...TABLE, rules: [] }} groups={FAKE_GROUPS} onChange={still} results={null} />
          </Frame>
        </State>
      </Row>
    </Section>
  );
}
