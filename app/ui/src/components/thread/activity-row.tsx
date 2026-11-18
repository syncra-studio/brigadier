import type { ComponentType, ReactNode } from "react";

import { ChevronRightAlt, EditPencil, File, Folder, Globe, MagnifyingGlassSmSearch, RobotHead, Terminal, Tools, ToolsSkills } from "../../icons";
import type { IconProps } from "../../icons";
import type { StepKind } from "../../thread/item";
import { useKept } from "../../thread/kept";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../collapsible";
import { cx } from "../cx";

/** One 21px line of 60% words, as wide as its words, cut at the column's edge. */
export const ROW = "flex w-fit max-w-full min-h-5.25 min-w-0 items-center gap-1.5 text-sm leading-5.25 text-row-foreground";
/** A row that opens: it turns white while hovered or focused. */
export const TOGGLE = "group cursor-pointer rounded-control text-start hover:text-foreground focus-visible:text-foreground focus-visible:focus-ring";
/** What an opened row shows, under it. */
export const DETAIL = "flex min-w-0 flex-col gap-1 py-1 text-sm text-row-foreground";

/** A row's chevron: hidden until the row is hovered or focused; turned and kept while it's open. */
export function Chevron({ always = false }: { always?: boolean }) {
  return (
    <ChevronRightAlt
      className={cx(
        "-ms-0.5 size-icon-sm shrink-0 chevron-motion group-hover:text-foreground group-focus-visible:text-foreground group-aria-expanded:rotate-90",
        !always && "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 group-aria-expanded:opacity-100",
      )}
    />
  );
}

const ICONS: Record<StepKind, ComponentType<IconProps>> = {
  read: File,
  edit: EditPencil,
  list: Folder,
  search: MagnifyingGlassSmSearch,
  run: Terminal,
  web: Globe,
  agent: RobotHead,
  skill: ToolsSkills,
  other: Tools,
};

/** A step's icon, by its kind (or any icon). */
export function StepIcon({ kind, icon: Icon = ICONS[kind ?? "other"] }: { kind?: StepKind; icon?: ComponentType<IconProps> }) {
  return <Icon className="size-4 shrink-0" />;
}

/** "Read" in the row's colour, then its object ("blocks.ts") quieter, both white while the row is hovered. */
export function Words({ verb, object, live = false }: { verb: string; object?: ReactNode; live?: boolean }) {
  return (
    <span key={live ? `${verb}${String(object)}` : undefined} className={cx("min-w-0 truncate", live && "shimmer")}>
      {verb}
      {object && (
        <>
          {" "}
          <span className={cx(!live && "text-row-object group-hover:text-foreground group-focus-visible:text-foreground")}>{object}</span>
        </>
      )}
    </span>
  );
}

/**
 * A row that opens to its detail when clicked (Enter or Space too), kept open or shut by `keep` while it
 * scrolls out of view. `trail` sits after the chevron and hides while the row is open.
 */
export function OpeningRow({ keep, children, detail, trail }: { keep: string; children: ReactNode; detail: ReactNode; trail?: ReactNode }) {
  const [open, setOpen] = useKept(keep);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex min-w-0 flex-col">
      <CollapsibleTrigger className={cx(ROW, TOGGLE)}>
        {children}
        <Chevron />
        {trail && <span className="ms-1 flex shrink-0 items-center gap-1.5 group-aria-expanded:hidden">{trail}</span>}
      </CollapsibleTrigger>
      {/* Base UI leaves a shut panel out of the page: a closed row costs one line. */}
      <CollapsibleContent>
        <div className={DETAIL}>{detail}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
