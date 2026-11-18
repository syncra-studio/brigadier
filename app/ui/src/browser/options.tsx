import { useRef } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { DotsHorizontal, Minus, Plus, Reload } from "../icons";
import { openBrowserSettings } from "../settings/browser-parts";
import { openSettings } from "../settings/shell";
import { stepZoom, ZOOM_LEAST, ZOOM_MOST, zoomLabel } from "./keys";

const MAC = window.brigadier?.platform === "darwin";

/** The zoom stepper's buttons: faint while they can't act. */
const STEP = "flex size-6 items-center justify-center hover:bg-fill disabled:opacity-disabled disabled:hover:bg-transparent";

/**
 * The ⋯ menu: the page's own actions (Find in page, Print and Zoom, once there is a page), then where
 * the browser's data lives in Settings.
 */
export function BrowserOptions({
  ready,
  zoom,
  onFind,
  onPrint,
  onZoom,
}: {
  /** A page is open to act on. */
  ready: boolean;
  zoom: number;
  onFind: () => void;
  onPrint: () => void;
  onZoom: (zoom: number) => void;
}) {
  // Find in page puts the keyboard in its field: the menu doesn't take it back to its button.
  const keepFocus = useRef(false);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<TooltipIconButton tooltip="Browser options" size="icon-md" className="shrink-0 rounded-capsule" />}>
        <DotsHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        data-slot="browser-options"
        className="w-browser-menu"
        finalFocus={() => {
          if (!keepFocus.current) return true;
          keepFocus.current = false;
          return false;
        }}
      >
        <DropdownMenuItem
          disabled={!ready}
          className="h-browser-menu-item"
          onClick={() => {
            keepFocus.current = true;
            onFind();
          }}
        >
          Find in page
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!ready} className="h-browser-menu-item" onClick={onPrint}>
          Print
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mx-2" />
        <div role="group" aria-label="Zoom" className="flex h-browser-menu-item items-center gap-1 ps-2 pe-1 text-sm">
          <span className="flex-1">Zoom</span>
          <div className="flex h-browser-zoom items-center rounded-control border border-border bg-fill-subtle text-xs">
            <button type="button" disabled={!ready || zoom <= ZOOM_LEAST} aria-label="Zoom out" onClick={() => onZoom(stepZoom(zoom, -1))} className={`${STEP} rounded-s-control`}>
              <Minus className="size-icon-sm" />
            </button>
            <span data-slot="browser-zoom" aria-live="polite" className="w-browser-zoom-value border-x border-border text-center tabular-nums">
              {zoomLabel(zoom)}
            </span>
            <button type="button" disabled={!ready || zoom >= ZOOM_MOST} aria-label="Zoom in" onClick={() => onZoom(stepZoom(zoom, 1))} className={`${STEP} rounded-e-control`}>
              <Plus className="size-icon-sm" />
            </button>
          </div>
          <button type="button" disabled={!ready || zoom === 1} aria-label="Reset zoom" onClick={() => onZoom(1)} className={`${STEP} rounded-capsule`}>
            <Reload className="size-icon-sm" />
          </button>
        </div>
        <DropdownMenuSeparator className="mx-2" />
        {MAC && (
          <DropdownMenuItem className="h-browser-menu-item" onClick={() => openSettings("browserImport")}>
            Import Browser Data…
          </DropdownMenuItem>
        )}
        <DropdownMenuItem className="h-browser-menu-item" onClick={() => openBrowserSettings("downloads")}>
          Downloads
        </DropdownMenuItem>
        <DropdownMenuItem className="h-browser-menu-item" onClick={() => openBrowserSettings("clear")}>
          Clear browsing data
        </DropdownMenuItem>
        <DropdownMenuSeparator className="mx-2" />
        <DropdownMenuItem className="h-browser-menu-item" onClick={() => openBrowserSettings()}>
          Browser settings
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
