import { useMemo } from "react";

import { TabGroupLabel } from "../browser/tab-icon";
import { cx } from "../components/cx";
import { useDaemon } from "../daemon";
import { Chat, SidebarError } from "../icons";
import { BrigadeGlyph } from "../sessions/brigade";
import { RowMark } from "../sidebar/row";
import { type SessionRow, useStatusWords } from "../sidebar/words";
import { BUTTON, Keycap, LOOK, noAutoscroll, TAB, TITLE } from "./chat-tab";
import { openSibling, SIBLING } from "./tab-store";

/*
 * A Brigade's family in the tab bar, as an agent's tab group [D793 D3108]: its label, then the Brigade's tab and one
 * per session it started, oldest first, the one shown being the Chat tab. They come from Rust's rows, not kept tabs:
 * a session's tab joins as its row arrives, and nothing takes the front [D30].
 */

/** The family of the session shown: the Brigade, then its live sessions; none while it has no sessions. */
export function useBrigadeFamily(row: SessionRow | undefined): SessionRow[] {
  const rows = useDaemon().rows as SessionRow[] | undefined;
  return useMemo(() => {
    const head = row?.brigade ? row : rows?.find((each) => each.id === row?.boss);
    if (!row || !head) return [];
    const subs = (rows ?? []).filter((each) => each.boss === head.id && (!each.archived || each.id === row.id)).toSorted((a, b) => (a.created ?? 0) - (b.created ?? 0));
    return subs.length > 0 ? [head, ...subs] : [];
  }, [row, rows]);
}

/** The family's label: the Brigade's name; clicked, its other tabs fold away and come back. */
export function BrigadeGroupLabel({ family, folded, onFold }: { family: readonly SessionRow[]; folded: boolean; onFold: () => void }) {
  return (
    <TabGroupLabel name={family[0]?.title || "Brigade"} count={`${family.length - 1} ${family.length === 2 ? "session" : "sessions"}`} folded={folded} onFold={onFold}>
      {family.slice(1).map((each) => (
        <li key={each.id} className="truncate">
          {each.title || "New session"}
        </li>
      ))}
    </TabGroupLabel>
  );
}

/** Another of the family's tabs: its icon, title and mark; a click opens its session, as its row does. No ×: it's a session. */
export function SiblingTab({ row, separator, folded, keycap }: { row: SessionRow; separator: boolean; folded: boolean; keycap?: string | undefined }) {
  const words = useStatusWords(row);
  const title = row.title || "New session";
  return (
    <div data-tab-id={SIBLING + row.id} data-separator={separator || undefined} data-closing={folded || undefined} aria-hidden={folded || undefined} inert={folded} data-agent-group className={cx(TAB, LOOK(false))}>
      <button type="button" role="tab" data-sibling aria-selected={false} tabIndex={-1} title={words ? `${title} · ${words}` : title} onMouseDown={noAutoscroll} onClick={() => openSibling(row.id)} className={BUTTON}>
        {row.mark === "amber" ? <SidebarError className="size-icon-md shrink-0 rotate-180 text-warning" /> : row.brigade ? <BrigadeGlyph className="size-icon-md shrink-0" /> : <Chat className="size-icon-md shrink-0" />}
        <span className={TITLE}>{title}</span>
        {row.mark && row.mark !== "amber" && !keycap && <RowMark mark={row.mark} label={words ?? ""} />}
        <Keycap keycap={keycap} />
      </button>
    </div>
  );
}
