import { type ComponentType, useEffect, useSyncExternalStore } from "react";

import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import { Compare, Dock, Document, FileDocument, Globe } from "../icons";
import { Clock, PullRequestOpen } from "../landing/icons";
import { HOME_DRAFT } from "../session/draft";
import { newId } from "../session/store";

/*
 * The open chat's or session's tabs [D360, D361]. Rust owns them (crates/cli/src/tabs.rs); this shows each change at
 * once and reconciles with what Rust answers [D30]. Changes go one at a time per owner. A reply lost with the link
 * proves nothing either way, so the state read on reconnect decides, and a change still out is sent again: Rust
 * ignores one it already has [D71]. `reopen` is the one that can't go twice, so a lost one is left to that read.
 */

export const CHAT = "chat";
export const HOME = HOME_DRAFT;
/** Each kind's name and icon, shared by the tab bar and the page under it: a new kind adds one line. */
export const TAB_KINDS = {
  new: { name: "New tab", icon: Globe },
  terminal: { name: "Terminal", icon: Dock },
  file: { name: "File", icon: Document },
  pr: { name: "Pull request", icon: PullRequestOpen },
  review: { name: "Review", icon: Compare },
  attachment: { name: "Attachment", icon: FileDocument },
  background: { name: "Background history", icon: Clock },
  note: { name: "Note", icon: Document },
} satisfies Record<string, { name: string; icon: ComponentType<{ className?: string }> }>;
export type TabKind = keyof typeof TAB_KINDS;
/**
 * `target`: a file tab's path, a PR tab's number [D1014], an attachment's `<id>/<name>` [D2104], a note's id [D244]. A file tab also has the line last asked for, and whether it's
 * the preview the next file takes.
 */
export type Tab = { id: string; kind: TabKind; opener: string; target?: string; line?: number; preview?: boolean; scope?: string };
export type Tabs = { tabs: Tab[]; active: string };

type Action = { args: string[]; change: (now: Tabs) => Tabs; once?: boolean; out?: boolean; run?: () => void };
type Slot = { rev: number | null; rust: Tabs; pending: Action[]; shown: Tabs };

const NONE: Tabs = { tabs: [], active: CHAT };
const slots = new Map<string, Slot>();
const listeners = new Set<() => void>();
const opened = new Set<string>();

function slotOf(owner: string): Slot {
  let slot = slots.get(owner);
  if (!slot) slots.set(owner, (slot = { rev: null, rust: NONE, pending: [], shown: NONE }));
  return slot;
}

function draw(slot: Slot): void {
  slot.shown = slot.pending.reduce((now, action) => action.change(now), slot.rust);
  for (const listener of listeners) listener();
}

// Only a newer word counts: an answer overtaken by a later one never takes the view back.
function land(slot: Slot, reply: Record<string, any>): void {
  if (slot.rev === null || reply.rev > slot.rev) {
    slot.rev = reply.rev;
    slot.rust = { tabs: reply.tabs, active: reply.active };
  }
  draw(slot);
}

function read(owner: string): void {
  ask({ op: "run", args: ["tabs", owner] }, (reply) => {
    if (reply.ok) land(slotOf(owner), reply);
  });
}

function pump(owner: string): void {
  const slot = slotOf(owner);
  const action = slot.pending[0];
  if (!action || action.out) return;
  if (action.run) {
    slot.pending.shift();
    action.run();
    draw(slot);
    return pump(owner);
  }
  action.out = true;
  ask({ op: "run", args: ["tabs", owner, ...action.args] }, (reply) => {
    if (slot.pending[0] !== action) return;
    if (reply.error === "disconnected") {
      action.out = false;
      if (action.once) {
        slot.pending.shift();
        draw(slot);
      }
      return;
    }
    slot.pending.shift();
    if (reply.ok) land(slot, reply);
    else {
      draw(slot);
      showToast(String(reply.error), { tone: "error" });
      read(owner);
    }
    pump(owner);
  });
}

function act(owner: string, action: Action): void {
  const slot = slotOf(owner);
  slot.pending.push(action);
  draw(slot);
  pump(owner);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useTabs(owner: string): Tabs {
  return useSyncExternalStore(subscribe, () => slots.get(owner)?.shown ?? NONE);
}

/** True once Rust has answered for `owner`, or its tabs came from Home's. */
export function useTabsRead(owner: string): boolean {
  return useSyncExternalStore(subscribe, () => (slots.get(owner)?.rev ?? null) !== null);
}

/** Asks Rust on opening and on every reconnect, and sends again what the link took. */
export function useTabsFromRust(owner: string): void {
  const { daemon } = useDaemon();
  useEffect(() => {
    if (!daemon) return;
    read(owner);
    for (const each of slots.keys()) pump(each);
  }, [owner, daemon]);
}

export const tabsOf = (owner: string): Tabs => slotOf(owner).shown;
/** Chat first, then the rest. */
export const tabOrder = ({ tabs }: Tabs): string[] => [CHAT, ...tabs.map((tab) => tab.id)];
/** True once, for a tab just opened: it grows into its slot; one already open at a switch doesn't. */
export const justOpened = (id: string): boolean => opened.delete(id);

const has = (now: Tabs, id: string) => id === CHAT || now.tabs.some((tab) => tab.id === id);

/** Kinds a session has one of, as Rust's `ONE` [D478, D1114]. */
const ONE: readonly TabKind[] = ["review"];
// An attachment is one tab by its id, whichever name it was opened by, as Rust has it.
const keyOf = (kind: TabKind, target?: string) => (kind === "attachment" ? target?.split("/")[0] : target);
const isSame = (tab: Tab, kind: TabKind, target?: string) => tab.kind === kind && (ONE.includes(kind) || (target !== undefined && keyOf(kind, tab.target) === keyOf(kind, target)));

export function openTab(owner: string, kind: TabKind, target?: string): void {
  const id = `t-${newId()}`;
  // A file or PR already open, or the one tab of its kind, comes to the front as Rust does, so no tab of this id ever shows.
  if (!tabsOf(owner).tabs.some((tab) => isSame(tab, kind, target))) opened.add(id);
  act(owner, {
    args: ["open", id, kind, ...(target === undefined ? [] : [target])],
    change: (now) => {
      const same = now.tabs.find((tab) => isSame(tab, kind, target));
      // In place, keeping its id, on its new target [D419, D424].
      if (same) return { tabs: now.tabs.map((tab) => (tab === same ? { ...tab, target } : tab)), active: same.id };
      if (has(now, id)) return { ...now, active: id };
      const at = now.tabs.findIndex((tab) => tab.id === now.active) + 1;
      return { tabs: now.tabs.toSpliced(at, 0, { id, kind, opener: now.active, ...(target === undefined ? {} : { target }) }), active: id };
    },
  });
}

/** A New tab becomes what was picked on it, in place, as Rust does: only a New tab, only a kind with no target. */
export function replaceTab(owner: string, id: string, kind: "new" | "terminal"): void {
  act(owner, {
    args: ["replace", id, kind],
    change: (now) => (now.tabs.some((tab) => tab.id === id && tab.kind === "new") ? { tabs: now.tabs.map((tab) => (tab.id === id ? { ...tab, kind } : tab)), active: id } : now),
  });
}

const reveals = new Map<string, number>();
/** How many times a file tab was asked to show its line: the viewer scrolls to it again on each. */
export const revealOf = (id: string): number => reveals.get(id) ?? 0;

/** Opens a checkout file as the old app did: one already open comes to the front, a preview takes the preview's place. */
export function openFile(owner: string, path: string, { line, preview }: { line?: number; preview: boolean }): void {
  const id = `t-${newId()}`;
  const isOpen = (tab: Tab) => tab.kind === "file" && tab.target === path;
  const { tabs } = tabsOf(owner);
  if (!tabs.some(isOpen) && !(preview && tabs.some((tab) => tab.preview))) opened.add(id);
  act(owner, {
    args: ["file", id, path, line === undefined ? "-" : String(line), preview ? "preview" : "keep"],
    change: (now) => {
      const open = now.tabs.find(isOpen);
      if (open) return { tabs: now.tabs.map((tab) => (tab === open ? { ...tab, preview: Boolean(tab.preview) && preview, line: line ?? tab.line } : tab)), active: open.id };
      const file: Tab = { id, kind: "file", opener: now.active, target: path, ...(line === undefined ? {} : { line }), preview };
      const at = preview ? now.tabs.findIndex((tab) => tab.preview) : -1;
      // The preview keeps its id, so the bar doesn't grow a tab and shrink back [D419, D424].
      const { id: kept, opener } = now.tabs[at] ?? file;
      if (at >= 0) return { tabs: now.tabs.with(at, { ...file, id: kept, opener }), active: kept };
      return { tabs: now.tabs.toSpliced(now.tabs.findIndex((tab) => tab.id === now.active) + 1, 0, file), active: id };
    },
  });
  if (line !== undefined) {
    const at = tabsOf(owner).active;
    reveals.set(at, revealOf(at) + 1);
  }
}

/** A preview file tab stays open for good. */
export function keepTab(owner: string, id: string): void {
  act(owner, { args: ["keep", id], change: (now) => ({ ...now, tabs: now.tabs.map((tab) => (tab.id === id ? { ...tab, preview: false } : tab)) }) });
}

/** A Review tab's scope, kept in its record so it comes back after a restart [D1187]. */
export function setTabScope(owner: string, id: string, scope: string): void {
  act(owner, { args: ["scope", id, scope], change: (now) => ({ ...now, tabs: now.tabs.map((tab) => (tab.id === id ? { ...tab, scope } : tab)) }) });
}

export function selectTab(owner: string, id: string): void {
  act(owner, { args: ["select", id], change: (now) => (has(now, id) ? { ...now, active: id } : now) });
}

export function closeTab(owner: string, id: string): void {
  act(owner, {
    args: ["close", id],
    change: (now) => {
      const at = now.tabs.findIndex((tab) => tab.id === id);
      if (at < 0) return now;
      const gone = now.tabs[at]!;
      const tabs = now.tabs.toSpliced(at, 1);
      if (now.active !== id) return { tabs, active: now.active };
      const back = gone.opener === CHAT || tabs.some((tab) => tab.id === gone.opener);
      return { tabs, active: back ? gone.opener : (tabs[at]?.id ?? tabs[at - 1]?.id ?? CHAT) };
    },
  });
}

export function closeOthers(owner: string, id: string): void {
  act(owner, { args: ["close-others", id], change: (now) => (has(now, id) ? { tabs: now.tabs.filter((tab) => tab.id === id), active: id } : now) });
}

export function closeRight(owner: string, id: string): void {
  act(owner, {
    args: ["close-right", id],
    change: (now) => {
      if (!has(now, id)) return now;
      const tabs = now.tabs.slice(0, now.tabs.findIndex((tab) => tab.id === id) + 1);
      return { tabs, active: has({ ...now, tabs }, now.active) ? now.active : id };
    },
  });
}

export function moveTab(owner: string, id: string, to: number): void {
  act(owner, {
    args: ["move", id, String(to)],
    change: (now) => {
      const at = now.tabs.findIndex((tab) => tab.id === id);
      return at < 0 ? now : { ...now, tabs: now.tabs.toSpliced(at, 1).toSpliced(to, 0, now.tabs[at]!) };
    },
  });
}

/** Which tab comes back is Rust's to know, so it shows when Rust answers. */
export function reopenTab(owner: string): void {
  act(owner, { args: ["reopen"], change: (now) => now, once: true });
}

export function stepTab(owner: string, step: 1 | -1): void {
  const now = tabsOf(owner);
  const order = tabOrder(now);
  selectTab(owner, order[(order.indexOf(now.active) + step + order.length) % order.length]!);
}

/** ⌘1 is Chat, ⌘2 to ⌘8 the tabs after it, ⌘9 the last, as browsers do. */
export function selectNumber(owner: string, number: number): void {
  const order = tabOrder(tabsOf(owner));
  const id = number === 9 ? order.at(-1) : order[number - 1];
  if (id) selectTab(owner, id);
}

/**
 * Home's tabs show on the session at once; `start --carry-tabs` moves what Rust has, so `start` waits its turn behind
 * Home's changes still out. The session's rev 0 yields to Rust's first answer after.
 */
export function carryHome(to: string, start: () => void): void {
  const home = slotOf(HOME);
  slots.set(to, { rev: 0, rust: home.shown, pending: [], shown: home.shown });
  act(HOME, {
    args: [],
    change: () => NONE,
    run: () => {
      home.rust = NONE;
      start();
    },
  });
}

/** A refused start may have moved nothing: Rust's Home counts again, even at the rev it had. */
export function rereadHome(): void {
  slotOf(HOME).rev = null;
  read(HOME);
}

/** The gallery's fixed tabs; Infinity so no answer from Rust replaces them. */
export function seedTabs(owner: string, shown: Tabs): void {
  slots.set(owner, { rev: Infinity, rust: shown, pending: [], shown });
}

/** A file that isn't an image opens in a tab, never the default app: `label` names it there [D2104]. */
export const openAttachment = (owner: string, id: string, label: string) => openTab(owner, "attachment", `${id}/${label.replaceAll("/", " ")}`);
