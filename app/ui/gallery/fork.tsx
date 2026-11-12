// Fork on Fake data, unwired [D48, D388, D1069–D1071, D1079]: the icon on an answer, its menu in each kind of
// session, each worktree-row wording, the agent submenu and vendor confirm, the pending fork, the "Forked from"
// line and a nested fork.
import { useState } from "react";

import { NavList } from "../src/components/nav";
import { type ForkOffer, ForkMenu } from "../src/components/thread/fork-menu";
import { type ForkOrigin, ForkedFrom } from "../src/components/thread/forked-from";
import { AnswerMarks } from "../src/components/thread/message";
import { SetupRow } from "../src/components/thread/setup";
import { SessionRowItem } from "../src/sidebar/row";
import type { Project, SessionRow } from "../src/sidebar/words";
import type { Setup } from "../src/thread/item";
import { Row, Section, State } from "./parts";
import { useAgents } from "./pickers";

const noop = () => undefined;
const offer = (worktree: ForkOffer["worktree"], here: ForkOffer["here"]): ForkOffer => ({ worktree, here, default: worktree ? "worktree" : here ? "here" : "chat", agent: "cloud", fingerprint: "f1" });
const MENUS: [string, ForkOffer | undefined, boolean, string?][] = [
  ["worktree session", offer("snapshot", "worktree"), false],
  ["Local checkout", offer("snapshot", "folder"), false],
  ["folder that isn't a git repository", offer(null, "folder"), false],
  ["chat with no project", offer(null, null), true],
  ["checking", undefined, false],
  ["couldn't check", undefined, false, "This session isn't reachable right now."],
];
const FILES: [string, ForkOffer["worktree"]][] = [
  ["snapshot", "snapshot"],
  ["no snapshot", "none"],
  ["snapshot whose commit is gone", "gone"],
  ["inherited answer, source gone", "sourceGone"],
];

/** An answer's marks with its fork menu, opened on press; another vendor's agent in its submenu asks first. */
function Menu({ chat, value, error }: { chat: boolean; value?: ForkOffer; error?: string }) {
  const agents = useAgents();
  return <AnswerMarks text="Done." fork={<ForkMenu chat={chat} {...(value && { offer: value })} {...(error && { error })} agents={agents} current="cloud" value={{ provider: "cloud", model: "large", effort: null }} onPick={noop} />} />;
}

const PENDING: Setup = { state: "running", before: null, steps: [{ kind: "worktree", state: "running", branch: "brigadier/fork-of-login", base: "main", error: null }] };
const FAILED: Setup = { state: "failed", before: null, steps: [{ kind: "worktree", state: "failed", branch: "brigadier/fork-of-login", base: "main", error: "The snapshot couldn't be written in." }] };
const ORIGINS: [string, ForkOrigin][] = [
  ["new worktree", { source: { id: "s1", title: "Login" }, where: "worktree", summary: false, leftOut: [] }],
  ["same folder", { source: { id: "s1", title: "Login" }, where: "folder", summary: false, leftOut: [] }],
  ["source deleted", { source: null, where: "worktree", summary: false, leftOut: [] }],
  ["started from a summary", { source: { id: "s1", title: "Login" }, where: "worktree", summary: true, leftOut: [] }],
  ["big files left out", { source: { id: "s1", title: "Login" }, where: "worktree", summary: false, leftOut: ["data/dump.sql", "vendor/sdk"] }],
];
const PROJECT: Project = { id: "p1", name: "brigadier", folder: "/Users/demo/code/brigadier" };
const row = (id: string, title: string): SessionRow => ({ id, title, state: "idle", mark: null, resets: null, sent: 0, finished: 0, project: "p1" });
const NESTED: [SessionRow, boolean][] = [
  [row("n1", "Login"), false],
  [row("n2", "Fork of Login"), true],
  [row("n3", "Rate limit the exports"), false],
];

export function ForkGallery() {
  const [active, setActive] = useState("n2");
  return (
    <Section title="Fork">
      <Row name="the icon on an answer, after Copy · session · chat · forking">
        <State label="session">
          <Menu chat={false} value={offer("snapshot", "worktree")} />
        </State>
        <State label="chat">
          <Menu chat />
        </State>
        <State label="forking">
          <AnswerMarks text="Done." fork={<ForkMenu chat={false} busy agents={undefined} current="cloud" onPick={noop} />} />
        </State>
      </Row>
      <Row name="the menu, by where the session works; Fork with another agent › lists this Mac's agents but this session's own, and another vendor's asks first">
        {MENUS.map(([label, value, chat, error]) => (
          <State key={label} label={label}>
            <Menu chat={chat} {...(value && { value })} {...(error && { error })} />
          </State>
        ))}
      </Row>
      <Row name="the worktree row, by what the check found">
        {FILES.map(([label, files]) => (
          <State key={label} label={label}>
            <Menu chat={false} value={offer(files, "folder")} />
          </State>
        ))}
      </Row>
      <Row name="the pending fork · failed">
        <State label="creating the worktree">
          <SetupRow keep="fork-pending" setup={PENDING} />
        </State>
        <State label="failed">
          <SetupRow keep="fork-failed" setup={FAILED} />
        </State>
      </Row>
      <Row name="Forked from, where the fork starts">
        {ORIGINS.map(([label, origin]) => (
          <State key={label} label={label}>
            <ForkedFrom origin={origin} chat={false} onOpen={noop} />
          </State>
        ))}
        <State label="a chat's source deleted">
          <ForkedFrom origin={{ source: null, where: null, summary: false, leftOut: [] }} chat onOpen={noop} />
        </State>
      </Row>
      <Row name="a fork nested under its source">
        <State label="sidebar · grouped by project">
          <NavList className="w-60">
            {NESTED.map(([each, forked]) => (
              <SessionRowItem key={each.id} row={each} project={PROJECT} active={each.id === active} nested forked={forked} onOpen={setActive} onRename={noop} />
            ))}
          </NavList>
        </State>
        <State label="one list">
          <NavList className="w-60">
            {NESTED.map(([each, forked]) => (
              <SessionRowItem key={each.id} row={each} project={PROJECT} tone={0} active={each.id === active} badged forked={forked} onOpen={setActive} onRename={noop} />
            ))}
          </NavList>
        </State>
      </Row>
    </Section>
  );
}
