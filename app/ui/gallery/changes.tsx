// The selected notice parts (D487, D490): real components, with their absent-data states and live controls.
import { type ReactNode, useState } from "react";

import { Button } from "../src/components/button";
import { ComposerCard } from "../src/components/composer/composer";
import { ComposerRail, type Notice, Notices } from "../src/components/composer/rail";
import { DrawBoundary, ErrorState } from "../src/components/thread/error-state";
import { ChangeLine, InlineStatus } from "../src/components/thread/line";
import { UserBubble } from "../src/components/thread/message";
import { Thread, type Source } from "../src/thread/thread";
import { WorkHeader, WorkingLine } from "../src/components/thread/work";
import { ShieldExclamation } from "../src/icons";
import { retiringNotice, sessionNotice } from "../src/session/notices";
import type { Item, RailNotice, Session } from "../src/thread/item";
import { Row, Section, State } from "./parts";
import { Toggled } from "./thread";

const noop = () => {};
const empty: Session = { id: "empty-retry", title: "", turns: [], items: [] };
const emptySource: Source = { get: () => empty, subscribe: () => noop };
const NOW = Date.now();
const ERROR = "TypeError: The saved reply could not be drawn\n    at Reply (reply.tsx:12:3)";
type Line = Extract<Item, { kind: "line" }>;
const base = { kind: "line", id: "sample", turnId: "turn" } as const;
const LINES: [string, Line][] = [
  ["limit reset", { ...base, reason: "limit-reset", at: NOW }],
  ["model changed", { ...base, reason: "model", why: "changed", from: "Large", to: "Small" }],
  ["model changed, previous unknown", { ...base, reason: "model", why: "changed", from: null, to: "Small" }],
  ["request rerouted", { ...base, reason: "model", why: "rerouted", from: "Large", to: "Small" }],
  ["rerouted, previous unknown", { ...base, reason: "model", why: "rerouted", from: null, to: "Small" }],
  ["stopped", { ...base, reason: "stopped", ms: 62_000 }],
  ["stopped, time unknown", { ...base, reason: "stopped", ms: null }],
  ["automatic review ended", { ...base, reason: "review-ended" }],
  ["retry replaces attempt", { ...base, reason: "retried" }],
  ["continuation, waits for forks", { ...base, reason: "continued", session: "example", title: "Fix login" }],
  ["continuation, title unknown", { ...base, reason: "continued", session: "example", title: null }],
];

function Column({ children }: { children: ReactNode }) {
  return <div className="w-80 max-w-full">{children}</div>;
}

function Reply({ broken }: { broken: boolean }) {
  if (broken) throw new Error("The sample reply could not be drawn");
  return <p className="text-sm">The saved reply is still here. Drawing it again runs no agent work.</p>;
}

function LiveBoundary() {
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex w-full max-w-reading flex-col gap-3">
      <DrawBoundary summary="This reply couldn’t be shown">
        <Reply broken={broken} />
      </DrawBoundary>
      <Button size="sm" variant="soft" className="self-start" onClick={() => setBroken(!broken)}>
        {broken ? "Repair saved reply" : "Break reply"}
      </Button>
      <p className="text-xs text-muted-foreground">Break it, repair the saved reply, then press Try again on the error line.</p>
    </div>
  );
}

const action = (words: string) => <Button variant="link-blue" size="xs" className="-my-0.5">{words}</Button>;
const notice = (reason: RailNotice["reason"], text = "", cause: RailNotice["cause"] = null) =>
  sessionNotice({ id: reason, turnId: "turn", reason, text, cause }, action("Retry"));
const RAIL: [string, Notice][] = [
  ["turn failed", notice("turn-failed", "The agent exited before its answer finished.")],
  ["busy", notice("turn-failed", "", "capacity")],
  ["model unavailable", notice("model-unavailable")],
  ["conversation ended", notice("ended-for-safety")],
  ["retirement, date and replacement", retiringNotice({ name: "Large", at: NOW + 86_400_000, to: "Small" })],
  ["retirement, date unknown", retiringNotice({ name: "Large", at: null, to: "Small" })],
  ["retired, replacement unknown", retiringNotice({ name: "Large", at: NOW - 86_400_000, to: null })],
  ["retirement, both unknown", retiringNotice({ name: "Large", at: null, to: null })],
  ["load failed", { id: "load", level: "warning", text: "Couldn’t load messages", action: action("Retry") }],
  ["setup incomplete", { id: "setup", level: "warning", text: "Setup didn’t finish: the setup script failed. Its step above says why." }],
  ["reconnecting", { id: "offline", level: "info", text: "Reconnecting to Brigadier…" }],
  ["start not confirmed", { id: "start", level: "info", text: "Not confirmed yet, so don’t send it again. It’s checked once Brigadier reconnects." }],
  ["couldn’t start", { id: "start", level: "error", text: "Couldn’t start this conversation. The folder could not be opened.", action: action("Try again") }],
  ["retrying", { id: "retry", level: "info", text: "Retrying this turn…" }],
  ["rewind unconfirmed", { id: "retry", level: "info", text: "Rewind not confirmed yet. It’s checked once Brigadier reconnects." }],
  ["retry refused", { id: "retry", level: "error", text: "Couldn’t retry: this turn can’t be rewound.", action: action("Put back message") }],
];

function Rail({ notices, onDismiss = noop }: { notices: Notice[]; onDismiss?: (id: Notice["id"]) => void }) {
  return (
    <div className="w-full">
      <ComposerRail><Notices notices={notices} onDismiss={onDismiss} /></ComposerRail>
      <ComposerCard><p className="px-4 py-3 text-sm text-muted-foreground">Do anything</p></ComposerCard>
    </div>
  );
}

function LiveRail() {
  const [notices, setNotices] = useState(RAIL.slice(0, 4).map(([, n], id) => ({ ...n, id })));
  return (
    <div className="flex w-full max-w-reading flex-col gap-3">
      <Rail notices={notices} onDismiss={(id) => setNotices(notices.filter((n) => n.id !== id))} />
      <Button size="sm" variant="soft" className="self-start" onClick={() => setNotices(RAIL.slice(0, 4).map(([, n], id) => ({ ...n, id })))}>Restore notices</Button>
    </div>
  );
}

export function ChangesGallery() {
  const [at, setAt] = useState(0);
  return (
    <Section title="Conversation changes and recovery">
      <Row name="Couldn’t draw: summary, details and rendering retry">
        <State label="with details and Retry"><Column><ErrorState summary="This reply couldn’t be shown" details={ERROR} onRetry={noop} /></Column></State>
        <State label="no details"><Column><ErrorState summary="This reply couldn’t be shown" onRetry={noop} /></Column></State>
        <State label="no retry"><Column><ErrorState summary="This conversation couldn’t be shown" details={ERROR} /></Column></State>
      </Row>
      <Row name="Live: one broken reply leaves the rest visible"><LiveBoundary /></Row>
      <Row name="Empty after rewind: pending and refused sends stay visible">
        <State label="pending"><div className="h-48 w-160 max-w-full"><Thread source={emptySource} footer={<UserBubble keep="empty-pending" text="Retry the saved message" time={NOW} />} /></div></State>
        <State label="refused"><div className="h-48 w-160 max-w-full"><Thread source={emptySource} footer={<UserBubble keep="empty-refused" text="Retry the saved message" failed="The agent isn’t available" onRetry={noop} onDiscard={noop} />} /></div></State>
      </Row>
      <Row name="Changes across the thread">
        {LINES.map(([label, item]) => <State key={label} label={label}><Column><ChangeLine item={item} /></Column></State>)}
      </Row>
      <Row name="Live: changes and their information tips">
        <div className="flex w-full max-w-reading flex-col gap-3">
          <ChangeLine item={LINES[at]![1]} />
          <Button size="sm" variant="soft" className="self-start" onClick={() => setAt((at + 1) % LINES.length)}>Next change</Button>
        </div>
      </Row>
      <Row name="Reply withheld, retries and safety checks">
        <State label="withheld"><Column><InlineStatus icon={ShieldExclamation}>This reply was withheld by the agent’s safety checks.</InlineStatus></Column></State>
        <State label="retry count known"><Column><WorkingLine state="live">Reconnecting · try 2 of 5</WorkingLine></Column></State>
        <State label="next time, count unknown"><Column><WorkingLine state="live">Reconnecting · try 2 · next at 21:39</WorkingLine></Column></State>
        <State label="safety checks"><div className="w-full max-w-reading"><WorkingLine state="live">Running extra safety checks · this can take a little longer</WorkingLine></div></State>
      </Row>
      <Row name="Denied actions beside the work time">
        <div className="w-full max-w-reading"><Toggled>{(open, onToggle) => <WorkHeader turn={{ id: "done", status: "done", startedAt: NOW - 184_000, endedAt: NOW }} work={{ turnId: "done", ms: 184_000, folded: [0, 0], denied: 2 }} open={open} onToggle={onToggle} />}</Toggled></div>
      </Row>
      <Row name="Session notices above the composer">
        {RAIL.map(([label, n]) => <State key={label} label={label}><div className="w-160 max-w-full"><Rail notices={[n]} /></div></State>)}
      </Row>
      <Row name="Live: page through notices, expand, dismiss, restore"><LiveRail /></Row>
    </Section>
  );
}
