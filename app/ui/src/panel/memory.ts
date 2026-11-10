import { useSyncExternalStore } from "react";

import type { PanelView } from "./types";

/*
 * What the right panel remembers [D1033]: open or closed and its width for the whole app, the view per session or
 * chat. Temporary: held in memory only until step 2.15 keeps it in Rust; callers use just these functions, so that
 * step replaces this file alone.
 */

type Memory = { open: boolean; width: number | null; views: Record<string, PanelView> };

let memory: Memory = { open: false, width: null, views: {} };
const listeners = new Set<() => void>();

function set(next: Partial<Memory>) {
  memory = { ...memory, ...next };
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePanelMemory(): Memory {
  return useSyncExternalStore(subscribe, () => memory);
}

export function setPanelOpen(open: boolean) {
  set({ open });
}

export function setPanelWidth(width: number) {
  set({ width });
}

/** Opens the panel on `view` for `owner`. */
export function showPanelView(owner: string, view: PanelView) {
  set({ open: true, views: { ...memory.views, [owner]: view } });
}
