// The thread's notice lines (D132-D134): the switch row in each state and live, changing in place, and a plain
// notice, wrapping.
import { type ReactNode, useEffect, useState } from "react";

import { Button } from "../src/components/button";
import { NoticeRow, SwitchDivider } from "../src/components/thread/cards";
import { AssistantMessage, UserBubble } from "../src/components/thread/message";
import type { Item } from "../src/thread/item";
import { Row, Section } from "./parts";

const LONG = "Usage limit on Work (fake) · switched automatically to OpenCode · ollama/fake-coder:7b";

type Switch = Extract<Item, { kind: "switch" }>;
type State = Switch["state"];
const noop = () => {};

const base = (id: string, more: Partial<Switch>): Switch => ({
  id,
  turnId: "t",
  kind: "switch",
  state: "limit",
  reason: "usage-limit",
  from: "this computer's login (fake)",
  to: "Work (fake)",
  handoff: false,
  automatic: false,
  text: "",
  ...more,
});
const MANUAL = base("sw-manual", { error: "Work (fake) isn't signed in any more" });
const AUTOMATIC = base("sw-auto", { from: "Work (fake)", to: "OpenCode", model: "ollama/fake-coder:7b", handoff: true, automatic: true });
const REFUSED = base("sw-refused", { reason: "unresumable", from: "Work (fake)", handoff: true });

/** The row as it reads in each state: Rust names both sides only once switched; a click names where it goes. */
const at = (s: Switch, state: State): Switch =>
  state === "switched" ? { ...s, state } : state === "limit" || state === "over" ? { ...s, state, from: null, to: null, model: null } : { ...s, state, from: null };

/** What the app adds after the limit's words: its links. */
const link = (text: string) => (
  <Button variant="link-blue" size={null}>
    {text}
  </Button>
);
const CASES: [string, Switch, State[], ReactNode, string][] = [
  ["usage limit, manual", MANUAL, ["limit", "switching", "failed", "switched", "over"], link("Switch to Work (fake)"), "this computer's login (fake)"],
  ["usage limit, automatic", AUTOMATIC, ["limit", "switched", "over"], null, "Work (fake)"],
  ["agent couldn't resume", REFUSED, ["limit", "switching", "switched", "over"], link("Start a new conversation"), "Work (fake)"],
];

/** limit → switching → switched, every 2 seconds, as a manual switch goes. */
function useCycle(): State {
  const [n, setN] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setN((k) => (k + 1) % 3), 2000);
    return () => window.clearInterval(timer);
  }, []);
  return (["limit", "switching", "switched"] as const)[n];
}

/** A bubble, the row and the answer, with the thread's gaps (rows.tsx: pt-6 after a user's message, pt-4 between parts). */
function Exchange({ row }: { row: ReactNode }) {
  return (
    <div className="flex flex-col">
      <UserBubble keep="notice-ex" text="say:three limit" />
      <div className="pt-6">{row}</div>
      <div className="pt-4">
        <AssistantMessage text="Hello from the local model." final>
          Hello from the local model.
        </AssistantMessage>
      </div>
    </div>
  );
}

const WIDTHS = [
  ["reading width", "flex w-full max-w-reading flex-col gap-2 px-6"],
  ["narrow", "flex w-72 flex-col gap-2"],
] as const;

function Column({ label, width, children }: { label: string; width: string; children: ReactNode }) {
  return (
    <div className={width}>
      <span className="text-2xs text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

export function Notices() {
  const live = useCycle();
  return (
    <Section title="Notice lines">
      {WIDTHS.map(([name, width]) => (
        <Row key={name} name={`Switch row, ${name}`}>
          {CASES.map(([label, s, states, actions, from]) => (
            <Column key={label} label={`${label}: ${states.join(" · ")}`} width={width}>
              <div className="flex flex-col gap-1">
                {states.map((state) => (
                  <SwitchDivider key={state} change={at(s, state)} from={from} actions={actions} onRetry={noop} />
                ))}
              </div>
            </Column>
          ))}
          <Column label="live: limit → switching → switched" width={width}>
            <Exchange row={<SwitchDivider change={at(MANUAL, live)} from="this computer's login (fake)" actions={link("Switch to Work (fake)")} onRetry={noop} />} />
          </Column>
          <Column label="other notices, current (wrap fixed)" width={width}>
            <Exchange row={<NoticeRow level="info" text={LONG} />} />
          </Column>
        </Row>
      ))}
    </Section>
  );
}
