import { useEffect, useSyncExternalStore } from "react";

import { showToast } from "../components/toast";
import { ask, useDaemon } from "../daemon";
import type { PanelView } from "./types";

/*
 * What the right panel remembers [D1014, D1033]: open or closed and its width for the whole app, the view per session
 * or chat. Rust keeps it (crates/cli/src/panel.rs); this shows each change at once and takes Rust's answer when it's
 * newer, as the tabs do [D30, D71]. A change the link took is sent again on reconnect: each is safe twice.
 */

type Memory = { open: boolean; width: number | null; views: Record<string, PanelView> };
type Change = { args: string[]; change: (now: Memory) => Memory; out?: boolean };

let rev = -1;
// Each owner's view has its own: a read of one isn't stale for being older than another's change.
const viewRevs = new Map<string, number>();
let rust: Memory = { open: false, width: null, views: {} };
let memory = rust;
let pending: Change[] = [];
const listeners = new Set<() => void>();

function draw() {
  memory = pending.reduce((now, each) => each.change(now), rust);
  for (const listener of listeners) listener();
}

/** Rust's word: open and width only when newer than the last, an owner's view when newer than that owner's last. */
function land(reply: Record<string, any>, owner?: string) {
  if (reply.rev > rev) {
    rust = { ...rust, open: reply.open, width: reply.width ?? null };
    rev = reply.rev;
  }
  if (owner && reply.view && reply.rev >= (viewRevs.get(owner) ?? -1)) {
    viewRevs.set(owner, reply.rev);
    rust = { ...rust, views: { ...rust.views, [owner]: reply.view } };
  }
  // The one time it opened by itself, it says why [D1023].
  if (typeof reply.opened === "number") showToast(`Opened: the agent changed ${reply.opened} ${reply.opened === 1 ? "file" : "files"}`);
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
    if (reply.ok) land(reply, change.args[0] === "view" ? change.args[1] : undefined);
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

/**
 * Reads `owner`'s view on opening and on every reconnect, sends again what the link took, and tells Rust the owner is
 * on screen: on opening it and when its turn ends (`finished`), so the panel opens itself there, once [D1023].
 */
export function usePanelFromRust(owner: string, finished: number | undefined): void {
  const { daemon } = useDaemon();
  useEffect(() => {
    if (!daemon) return;
    ask({ op: "run", args: ["panel", owner] }, (reply) => reply.ok && land(reply, owner));
    pump();
  }, [owner, daemon]);
  useEffect(() => {
    if (!daemon || finished === undefined) return;
    ask({ op: "run", args: ["panel", "shown", owner] }, (reply) => reply.ok && land(reply, owner));
  }, [owner, daemon, finished]);
}

export function setPanelOpen(open: boolean) {
  act(["open", open ? "on" : "off"], (now) => ({ ...now, open }));
}

export function setPanelWidth(width: number) {
  act(["width", String(width)], (now) => ({ ...now, width }));
}

/** Opens the panel on `view` for `owner`. */
export function showPanelView(owner: string, view: PanelView) {
  act(["view", owner, view], (now) => ({ ...now, open: true, views: { ...now.views, [owner]: view } }));
}
