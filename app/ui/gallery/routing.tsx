// Settings › Routing on fake data (C5): the page as Rust's table would fill it, its editor, offers and results, its
// loading, error and offline states, and the dot.
import { type ReactNode, useRef, useState } from "react";

import { CheckboxRow } from "../src/components/checkbox-row";
import type { ModelGroup } from "../src/components/composer/model-picker";
import { TooltipIconButton } from "../src/components/icon-button";
import { Settings } from "../src/icons";
import { type Job, type Routing, RoutingPage, showRoutingDot } from "../src/settings/routing";
import type { Answer } from "../src/settings/routing-jobs";
import type { Results } from "../src/settings/routing-results";
import { SettingsNav } from "../src/settings/shell";
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
      { id: "large-2", name: "Large model 2", efforts: EFFORTS, defaultEffort: "high" },
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

const WRITE: Job = {
  name: "Write code",
  for: "Writing or changing code, with its tests.",
  entries: [
    { agent: "cloud", model: "large", effort: "high" },
    { agent: "other", model: "big", effort: "high" },
  ],
};

const TABLE: Routing = {
  jobs: [
    WRITE,
    { name: "Look into the codebase", for: "Reading and analysing code without changing it: tracing, audits, explaining how something works.", entries: [{ agent: "cloud", model: "medium", effort: "low" }] },
    { name: "Research the web", for: "Finding and reading sources on the web, and summing them up with links.", entries: [{ agent: "other", model: "mini", effort: null }] },
    { name: "Plan and orchestrate", for: "Planning or designing a change, splitting it into jobs and leading the workers.", entries: [{ agent: "cloud", model: "large", effort: "high" }] },
    { name: "Quick actions", for: "Fast, small steps: computer use, a lookup, a one-line edit.", entries: [{ agent: "cloud", model: "small", effort: "low" }] },
    {
      name: "Review",
      for: "Adversarial reviews: try to break code or a plan.",
      entries: [
        { agent: "cloud", model: "large", effort: "high" },
        { agent: "other", model: "big", effort: "high" },
      ],
    },
  ],
  rules: [
    { never: "above", effort: "high", agent: null },
    { never: "model", agent: "other", model: "mini" },
  ],
  review: true,
  offers: [
    {
      id: "newer",
      job: "Write code",
      kind: "newer",
      title: "Large model 2 is new. Use it in place of Large model in Write code?",
      facts: "Cloud agent lists it since today, a newer Large model than the one in this list. It keeps the same place and effort (High).",
      done: "Large model 2 is in Write code now",
    },
    { id: "alias", job: "Quick actions", kind: "alias", title: "small now runs Small model 1.1 (was Small model 1.0)", facts: "", done: "" },
    { id: "mark", job: null, kind: "mark", title: "Cloud agent's default is now Medium model, which none of your jobs holds.", facts: "", done: "" },
  ],
  notes: {
    review: "Plans are reviewed from Cloud agent's plan mode. Other agent doesn't hand Brigadier a plan, so its plans aren't reviewed.",
    rules: "They hold everywhere Brigadier starts a model: your pickers, sessions, workers, Brigade bosses, side chats, forks and the commit writer. Your agents' own subagents: Cloud agent's can't run a model your rules bar. Other agent's start on the session's model and effort, but its agent can still pick another.",
  },
};

const RESULTS: Results = {
  jobs: [
    {
      job: "Write code",
      models: [
        { agent: "cloud", model: "large", name: "Large model", kept: 21, of: 24, finished: 24, retried: 0 },
        { agent: "other", model: "big", name: "Big model", kept: 5, of: 7, finished: 7, retried: 0 },
      ],
    },
    { job: "Look into the codebase", models: [{ agent: "cloud", model: "medium", name: "Medium model", kept: null, of: 10, finished: 9, retried: 1 }] },
    { job: "Plan and orchestrate", models: [{ agent: "cloud", model: "large", name: "Large model", kept: null, of: 4, finished: 4, retried: 0 }] },
    { job: null, models: [{ agent: "other", model: "mini", name: "Mini model", kept: 3, of: 4, finished: 4, retried: 0 }] },
    { job: "Best", models: [{ agent: "cloud", model: "large", name: "Large model", kept: 17, of: 20, finished: 20, retried: 1 }] },
  ],
  reviews: { count: 6, findings: 14, fixed: 11, rejected: 3 },
};

const DRAFT: Job = {
  name: "3D and modelling",
  for: "Anything 3D: models, scenes, meshes, Blender or CAD scripts.",
  entries: [
    { agent: "other", model: "big", effort: "high" },
    { agent: "cloud", model: "large", effort: "high" },
  ],
};

showRoutingDot(TABLE);

/** A page in a box of its own, scrolled inside it as Settings scrolls it. */
function Frame({ tall = false, children }: { tall?: boolean; children: ReactNode }) {
  return <div className={tall ? "flex h-240 w-full overflow-hidden rounded-surface border border-divider bg-background" : "flex h-80 w-200 overflow-hidden rounded-surface border border-divider bg-background"}>{children}</div>;
}

export function RoutingGallery() {
  const [value, setValue] = useState<Routing>(TABLE);
  const table = useRef(TABLE);
  const [refuses, setRefuses] = useState(false);
  // Rust takes a change after a moment, or refuses it with its words.
  const later = (next: (now: Routing) => Routing) =>
    new Promise<Routing>((done, fail) =>
      setTimeout(() => {
        if (refuses) return fail(new Error("A job's name is up to 40 characters."));
        table.current = next(table.current);
        setValue(table.current);
        done(table.current);
      }, 600),
    );
  const save = (next: Routing) => later(() => next);
  // Use it puts Large model 2 in Large model's place, as Rust would.
  const answer = (id: string, how: Answer) =>
    later((now) => ({
      ...now,
      offers: now.offers.filter((offer) => offer.id !== id),
      jobs: how === "use" && id === "newer" ? now.jobs.map((job) => (job.name === WRITE.name ? { ...job, entries: job.entries.map((entry) => (entry.model === "large" ? { ...entry, model: "large-2" } : entry)) } : job)) : now.jobs,
    }));
  const still = () => Promise.resolve(TABLE);
  return (
    <Section title="Settings › Routing">
      <Row name="The page: edit a job, drag a header, answer the offer">
        <div className="flex w-full flex-col gap-3">
          <CheckboxRow label="Rust refuses changes" checked={refuses} onCheckedChange={setRefuses} />
          <Frame tall>
            <RoutingPage value={value} groups={FAKE_GROUPS} onChange={save} onOffer={answer} results={RESULTS} />
          </Frame>
        </div>
      </Row>
      <Row name="The editor">
        <State label="New job">
          <Frame tall>
            <RoutingPage value={{ ...TABLE, jobs: [WRITE], offers: [] }} groups={FAKE_GROUPS} onChange={still} onOffer={still} results={RESULTS} draft={DRAFT} />
          </Frame>
        </State>
        <State label="Review">
          <Frame tall>
            <RoutingPage value={{ ...TABLE, offers: [] }} groups={FAKE_GROUPS} onChange={still} onOffer={still} results={RESULTS} editing="Review" />
          </Frame>
        </State>
      </Row>
      <Row name="States">
        <State label="Loading">
          <Frame>
            <RoutingPage value={null} groups={FAKE_GROUPS} onChange={still} onOffer={still} results={null} />
          </Frame>
        </State>
        <State label="Can't be read">
          <Frame>
            <RoutingPage value={null} groups={FAKE_GROUPS} onChange={still} onOffer={still} results={null} error="Couldn't read the routing: Brigadier stopped answering." />
          </Frame>
        </State>
        <State label="Brigadier isn't running">
          <Frame>
            <RoutingPage value={TABLE} groups={FAKE_GROUPS} onChange={still} onOffer={still} results={RESULTS} offline />
          </Frame>
        </State>
        <State label="No results yet">
          <Frame>
            <RoutingPage value={{ ...TABLE, rules: [] }} groups={FAKE_GROUPS} onChange={still} onOffer={still} results={{ jobs: [], reviews: null }} />
          </Frame>
        </State>
        <State label="Results loading">
          <Frame>
            <RoutingPage value={{ ...TABLE, rules: [] }} groups={FAKE_GROUPS} onChange={still} onOffer={still} results={null} />
          </Frame>
        </State>
      </Row>
      <Row name="The dot: an offer on a job is open">
        <State label="Settings' sidebar">
          <div data-slot="dot-nav" className="flex w-65 flex-col rounded-surface border border-divider bg-card p-2">
            <SettingsNav current="general" />
          </div>
        </State>
        <State label="The sidebar's Settings">
          <TooltipIconButton look="strip" tooltip="Settings" dot="bg-link">
            <Settings />
          </TooltipIconButton>
        </State>
      </Row>
    </Section>
  );
}
