import { useEffect, useSyncExternalStore } from "react";

import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";

/*
 * What the right panel remembers [D1014, D1033]: open or closed and its width for the whole app. Rust keeps it (crates/cli/src/panel.rs); this shows each change at once and takes Rust's answer when it's
 * newer, as the tabs do [D30, D71]. A change the link took is sent again on reconnect: each is safe twice.
 */

type Memory = { open: boolean; width: number | null };
type Change = { args: string[]; change: (now: Memory) => Memory; out?: boolean };

let rev = -1;
let rust: Memory = { open: false, width: null };
let memory = rust;
let pending: Change[] = [];
const listeners = new Set<() => void>();

function draw() {
  memory = pending.reduce((now, each) => each.change(now), rust);
  for (const listener of listeners) listener();
}

/** Rust's word, only when newer than the last. */
function land(reply: Record<string, any>) {
  if (reply.rev > rev) {
    rust = { open: reply.open, width: reply.width ?? null };
    rev = reply.rev;
  }
  draw();
}

function pump() {
  const change = pending[0];
  if (!change || change.out) return;
  change.out = true;
  ask({ op: "run", args: ["panel", ...change.args] }, (reply) => {
    if (pending[0] !== change) return;
    if (reply.error === "disconnected") return void (change.out = false);
    pending.shift();
    if (reply.ok) land(reply);
    else {
      draw();
      showToast(String(reply.error), { tone: "error" });
    }
    pump();
  });
}

function act(args: string[], change: (now: Memory) => Memory) {
  pending.push({ args, change });
  draw();
  pump();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePanelMemory(): Memory {
  return useSyncExternalStore(subscribe, () => memory);
}

/** Reads it on every connect, and sends again what the link took. */
export function usePanelFromRust(): void {
  const { daemon } = useDaemon();
  useEffect(() => {
    if (!daemon) return;
    ask({ op: "run", args: ["panel"] }, (reply) => reply.ok && land(reply));
    pump();
  }, [daemon]);
}

export function setPanelOpen(open: boolean) {
  act(["open", open ? "on" : "off"], (now) => ({ ...now, open }));
}

export function setPanelWidth(width: number) {
  act(["width", String(width)], (now) => ({ ...now, width }));
}

/** The right panel's views, in its icon row's order [D56]. */
export type PanelTab = "files" | "workers";

// shortcut: each session's last view lasts until the app quits, as the old app's per-session tab; keep it in Rust's panel memory if the owner wants it kept.
let tabs: Record<string, PanelTab> = {};

/** The view the panel shows for `owner`, Files until another is picked. */
export function usePanelTab(owner: string): PanelTab {
  return useSyncExternalStore(subscribe, () => tabs[owner] ?? "files");
}

/** Shows `tab` for `owner`, opening the panel if it's closed, as the old app's openWorkspacePane. */
export function openPanel(owner: string, tab: PanelTab) {
  if (tabs[owner] !== tab) {
    tabs = { ...tabs, [owner]: tab };
    for (const listener of listeners) listener();
  }
  if (!memory.open) setPanelOpen(true);
}
