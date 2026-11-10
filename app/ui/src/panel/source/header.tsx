import type { ReactNode } from "react";

import { TooltipIconButton } from "../../components/icon-button";
import { DropdownMenu, DropdownMenuTrigger } from "../../components/menu";
import { Check, DotsHorizontal, Reload } from "../../icons";

/** The Source panel's title row: SOURCE, then its actions, always in view (the old SourceHeader). */
export function SourceHeader({ children }: { children?: ReactNode }) {
  return (
    <header className="flex h-control-md shrink-0 items-center gap-0.5 ps-3 pe-2 text-muted-foreground">
      <span className="min-w-0 flex-1 text-xs font-semibold tracking-wide">SOURCE</span>
      {children}
    </header>
  );
}

/** Commit (off when it can't), Refresh, then More Actions (`moreMenu`). `held`: the gallery holds the menu open. */
export function SourceActions({ canCommit, locked, onCommit, onRefresh, moreMenu, held = false }: {
  canCommit: boolean;
  locked: boolean;
  onCommit?: () => void;
  onRefresh?: () => void;
  moreMenu: ReactNode;
  held?: boolean;
}) {
  return (
    <>
      <TooltipIconButton tooltip="Commit" size="icon-xs" disabled={locked || !canCommit} onClick={onCommit}>
        <Check />
      </TooltipIconButton>
      <TooltipIconButton tooltip="Refresh" size="icon-xs" onClick={onRefresh}>
        <Reload />
      </TooltipIconButton>
      <DropdownMenu modal={false} {...(held && { open: true })}>
        <DropdownMenuTrigger render={<TooltipIconButton tooltip="More Actions" size="icon-xs" disabled={locked} />}>
          <DotsHorizontal />
        </DropdownMenuTrigger>
        {moreMenu}
      </DropdownMenu>
    </>
  );
}
