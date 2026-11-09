import { type RefObject, useEffect, useState } from "react";

import { ArrowDown, ArrowUp, SidebarError, SidebarQuestion } from "../icons";

/** Of `ids`, those above and below what `list` shows. */
function outOfView(list: HTMLElement, ids: readonly string[]): { above: string[]; below: string[] } {
  const view = list.getBoundingClientRect();
  const above: string[] = [];
  const below: string[] = [];
  for (const id of ids) {
    const row = list.querySelector(`[data-row-id="${CSS.escape(id)}"]`)?.getBoundingClientRect();
    if (!row) continue;
    if (row.top < view.top) above.push(id);
    else if (row.bottom > view.bottom) below.push(id);
  }
  return { above, below };
}

/**
 * "2 need you", the old app's [D200]: every row that waits on you or failed, while one of them is scrolled
 * out of the list's view: blue if any of them waits, amber when all of them failed. A click brings the
 * next one into view, the nearest below first.
 */
export function NeedYouPill({ list, ids, waiting }: { list: RefObject<HTMLDivElement | null>; ids: readonly string[]; waiting: boolean }) {
  const [hidden, setHidden] = useState<{ above: string[]; below: string[] }>({ above: [], below: [] });
  const key = ids.join(" ");
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const shown = key ? key.split(" ") : [];
    const measure = () => setHidden(outOfView(element, shown));
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    const resized = new ResizeObserver(measure);
    resized.observe(element);
    // A send, pin or fold can move such a row without changing its id or the list's size.
    const changed = new MutationObserver(measure);
    changed.observe(element, { childList: true, subtree: true, attributes: true });
    return () => {
      element.removeEventListener("scroll", measure);
      resized.disconnect();
      changed.disconnect();
    };
  }, [list, key]);
  const next = hidden.below[0] ?? hidden.above.at(-1);
  if (next === undefined) return null;
  const Arrow = hidden.below.length > 0 ? ArrowDown : ArrowUp;
  return (
    <button
      type="button"
      onClick={() => list.current?.querySelector(`[data-row-id="${CSS.escape(next)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" })}
      className="mx-auto my-1.5 flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-capsule border border-border bg-popover ps-2 pe-2.5 text-sm whitespace-nowrap text-foreground shadow-tooltip hover:bg-muted focus-visible:focus-ring"
    >
      {waiting ? (
        <SidebarQuestion aria-hidden className="size-icon-md shrink-0 text-link" />
      ) : (
        <SidebarError aria-hidden className="size-icon-md shrink-0 rotate-180 text-warning" />
      )}
      {ids.length === 1 ? "1 needs you" : `${ids.length} need you`}
      <Arrow aria-hidden className="size-icon-sm shrink-0 text-muted-foreground" />
    </button>
  );
}
