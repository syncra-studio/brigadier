// The gallery's index: every block on the page by area, found by name, with the current place lit.
import { type RefObject, useEffect, useState } from "react";

import { Input } from "../src/components/input";
import { NavList, NavRow, NavSection } from "../src/components/nav";

type Block = { area: string; title: string; element: HTMLElement; rows: { name: string; element: HTMLElement }[] };

// Read from the page, so a block added anywhere is listed without touching this file.
function readBlocks(page: HTMLElement): Block[] {
  return [...page.querySelectorAll<HTMLElement>("[data-block]")].map((element) => ({
    area: element.closest<HTMLElement>("[data-area]")!.dataset.area!,
    title: element.dataset.block!,
    element,
    rows: [...element.querySelectorAll<HTMLElement>("[data-row]")].map((row) => ({ name: row.dataset.row!, element: row })),
  }));
}

function Entry({ label, at, target }: { label: string; at: boolean; target: HTMLElement }) {
  return (
    <li>
      <NavRow
        data-active={at ? "" : undefined}
        aria-current={at ? "location" : undefined}
        ref={(row) => {
          if (at) row?.scrollIntoView({ block: "nearest" });
        }}
        onClick={() => target.scrollIntoView({ block: "start" })}
      >
        <span className="truncate">{label}</span>
      </NavRow>
    </li>
  );
}

export function Contents({ scroller }: { scroller: RefObject<HTMLDivElement | null> }) {
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [block, setBlock] = useState<HTMLElement>();
  const [row, setRow] = useState<HTMLElement>();
  const [query, setQuery] = useState("");

  useEffect(() => {
    const box = scroller.current!;
    const found = readBlocks(box);
    setBlocks(found);
    const update = () => {
      // Below the heading that stays on top of a block.
      const line = box.getBoundingClientRect().top + 64;
      const current = found.findLast((entry) => entry.element.getBoundingClientRect().top <= line) ?? found[0];
      setBlock(current?.element);
      setRow(current?.rows.findLast((entry) => entry.element.getBoundingClientRect().top <= line)?.element);
    };
    update();
    box.addEventListener("scroll", update, { passive: true });
    return () => box.removeEventListener("scroll", update);
  }, [scroller]);

  const words = query.trim().toLowerCase();
  const has = (text: string) => text.toLowerCase().includes(words);
  const shown = blocks.flatMap((entry) => {
    // At rest only the current block lists its rows; a search lists the ones that match.
    const rows = words ? entry.rows.filter((item) => has(item.name)) : entry.element === block ? entry.rows : [];
    return !words || rows.length > 0 || has(entry.title) || has(entry.area) ? [{ ...entry, rows }] : [];
  });

  return (
    <aside className="flex w-sidebar shrink-0 flex-col border-e border-divider">
      <div className="shrink-0 p-2">
        <Input type="search" aria-label="Find a component" placeholder="Find a component" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      <nav aria-label="Components" className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-4">
        {[...new Set(shown.map((entry) => entry.area))].map((area) => (
          <NavSection key={area} title={area}>
            <NavList>
              {shown
                .filter((entry) => entry.area === area)
                .map((entry) => (
                  <li key={entry.title}>
                    <NavList>
                      <Entry label={entry.title} at={entry.element === block && !entry.rows.some((item) => item.element === row)} target={entry.element} />
                    </NavList>
                    {entry.rows.length > 0 && (
                      <NavList className="ps-3">
                        {entry.rows.map((item) => (
                          <Entry key={item.name} label={item.name} at={item.element === row} target={item.element} />
                        ))}
                      </NavList>
                    )}
                  </li>
                ))}
            </NavList>
          </NavSection>
        ))}
        {shown.length === 0 && blocks.length > 0 && <p className="px-2 text-sm text-muted-foreground">No component matches.</p>}
      </nav>
    </aside>
  );
}
