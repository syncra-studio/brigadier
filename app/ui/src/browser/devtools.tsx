import { type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { showToast } from "../components/toast";
import { Terminal } from "../icons";
import { putBack } from "../session/side";
import { CHAT, selectTab, tabAnywhere } from "../shell/tab-store";
import { changeDev, closeDevTools, devOf, elementText, fitScale, openDevTools, placeDevTools, startPicking, stopPicking, useBrowserDev } from "./dev";
import { toggleDevice, useDeviceSize } from "./device-sizes";
import { followLayout } from "./follow";
import { type BrowserBounds, focusPage } from "./layer";
import { useBrowserPage } from "./pages";
import { useAgentPause, userUsed } from "./pause";
import { Banner } from "./toolbar-parts";

function failed(cause: unknown): void {
  const message = cause instanceof Error ? cause.message : String(cause);
  // L128: the picker needs the debugger, which DevTools holds, and never closes it.
  showToast(message.includes("devtools_open") ? "Close DevTools to pick an element for the chat." : message, { tone: "error" });
}

function togglePicker(id: string): void {
  userUsed(id);
  if (devOf(id).picking) void stopPicking(id).catch(failed);
  else void startPicking(id).catch(failed);
}

/** The toolbar's developer button. */
export function BrowserDevButton({ id, ready }: { id: string; ready: boolean }) {
  const dev = useBrowserDev(id);
  return (
    <span inert={!ready} data-gone={!ready || undefined} className={cx("makes-way flex shrink-0 @max-md/browser-toolbar:hidden", ready ? "w-auto" : "-ms-1.5 w-0")}>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={!ready}
          render={
            <TooltipIconButton
              tooltip="Developer tools"
              size="icon-md"
              className={cx("shrink-0 rounded-capsule", (dev.devtools || dev.picking || dev.device) && "text-primary")}
            />
          }
        >
          <Terminal />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-slot="browser-dev-menu">
          <DropdownMenuItem onClick={() => togglePicker(id)}>{dev.picking ? "Stop picking" : "Pick an element"}</DropdownMenuItem>
          <DropdownMenuCheckboxItem checked={dev.devtools} onCheckedChange={() => changeDev(id, { devtools: !dev.devtools })}>DevTools</DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem checked={dev.device !== null} onCheckedChange={() => toggleDevice(id)}>Device sizes</DropdownMenuCheckboxItem>
          {dev.devtools && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => changeDev(id, { dock: dev.dock === "right" ? "bottom" : "right" })}>
                {dev.dock === "right" ? "Dock DevTools below" : "Dock DevTools beside"}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

/** The strip while the picker is on, and with what it picked. */
export function BrowserPickerBar({ id }: { id: string }) {
  const { picking, picked } = useBrowserDev(id);
  if (picking) {
    return (
      <Banner slot="browser-picking" text="Click an element of the page. Esc leaves.">
        <Button size="sm" variant="ghost" onClick={() => void stopPicking(id).catch(failed)}>Stop</Button>
      </Banner>
    );
  }
  if (!picked) return null;
  const toChat = () => {
    const session = tabAnywhere(id)?.owner;
    if (!session) return showToast("There is no chat open to add it to.", { tone: "error" });
    // Above what is being typed: the composer takes it when its session shows.
    putBack(session, `${elementText(picked)}\n`, true);
    changeDev(id, { picked: null });
    showToast("Added to chat", { actions: [{ label: "View", run: () => selectTab(session, CHAT) }] });
  };
  const size = `${Math.round(picked.rect.width)}×${Math.round(picked.rect.height)}`;
  return (
    <Banner
      slot="browser-picked"
      text={<><span className="font-medium">{picked.component ?? picked.tag}</span> <span className="font-mono text-muted-foreground">{picked.selector}</span> <span className="text-muted-foreground tabular-nums">{size}</span></>}
      onDismiss={() => changeDev(id, { picked: null })}
    >
      <Button size="sm" onClick={toChat}>Add to chat</Button>
    </Banner>
  );
}

function boundsOf(element: HTMLElement): BrowserBounds {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

/** A menu over DevTools' pane or any dialog: the pane is a native view above the app, so it steps aside. */
function layerOver(box: BrowserBounds): boolean {
  if (document.querySelector("[role=dialog], [role=alertdialog]")) return true;
  for (const layer of document.querySelectorAll("[role=menu], [role=listbox], [data-above-page]")) {
    const rect = layer.getBoundingClientRect();
    if (rect.left < box.x + box.width && rect.right > box.x && rect.top < box.y + box.height && rect.bottom > box.y) return true;
  }
  return false;
}

/** Around the tab's page area: where it is laid out as a device, and DevTools beside or below it. */
export function BrowserDevFrame({ id, active, children }: { id: string; active: boolean; children: ReactNode }) {
  const { devtools, dock, share, device } = useBrowserDev(id);
  const ready = useBrowserPage(id)?.ready === true;
  const openInMain = id in useAgentPause().devtools;
  const stage = useRef<HTMLDivElement>(null);
  const pane = useRef<HTMLDivElement>(null);
  const [room, setRoom] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element || !device) return;
    const measure = () => {
      const { width, height } = boundsOf(element);
      setRoom({ width: width - 24, height: height - 24 });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [device]);

  const scale = device ? fitScale(device, room) : 1;
  useDeviceSize(id, device, scale, ready);

  // The page area, as big as the device shows.
  useLayoutEffect(() => {
    const area = stage.current?.querySelector<HTMLElement>('[data-slot="browser-page"]');
    if (!area) return;
    if (device) {
      area.dataset.width = String(Math.round(device.width * scale));
      area.dataset.height = String(Math.round(device.height * scale));
    } else {
      delete area.dataset.width;
      delete area.dataset.height;
    }
  }, [device, scale]);

  // DevTools' pane follows its place as the tab's page follows its area.
  const opened = useRef(false);
  useEffect(() => {
    const element = pane.current;
    if (!devtools || !ready || !element) return;
    if (!opened.current) {
      opened.current = true;
      void openDevTools(id, boundsOf(element)).catch((error: unknown) => {
        opened.current = false;
        changeDev(id, { devtools: false });
        failed(error);
      });
    }
    if (!active) return;
    let placed = "";
    const place = () => {
      const usable = element.closest("[inert]") ? null : boundsOf(element);
      const bounds = usable && !layerOver(usable) ? usable : null;
      const key = JSON.stringify(bounds);
      if (key === placed) return;
      placed = key;
      void placeDevTools(id, bounds).catch(() => {});
    };
    const stop = followLayout(() => [element], place);
    return () => {
      stop();
      void placeDevTools(id, null).catch(() => {});
    };
  }, [id, devtools, ready, active, dock]);

  // The toggle turned off, or DevTools closed itself: the pane goes, and the keyboard back to the page.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !openInMain && devtools) changeDev(id, { devtools: false });
    wasOpen.current = openInMain;
  }, [id, openInMain, devtools]);
  useEffect(() => {
    if (devtools || !opened.current) return;
    opened.current = false;
    void closeDevTools(id).catch(failed);
    focusPage(id);
  }, [id, devtools]);

  // Over the divider's gap there is no page: a drag stays with it.
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const whole = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!whole) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent) => {
      const part = dock === "right" ? (whole.right - moved.clientX) / whole.width : (whole.bottom - moved.clientY) / whole.height;
      changeDev(id, { share: Math.min(0.8, Math.max(0.15, part)) });
    };
    const done = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", done);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", done);
  };

  return (
    <div data-slot="browser-dev-frame" className={cx("flex min-h-0 w-full flex-1", dock === "bottom" && "flex-col")}>
      <div ref={stage} className={cx("flex min-h-0 min-w-0 flex-1", device && "items-center justify-center overflow-hidden bg-fill-subtle")}>
        {children}
      </div>
      {devtools && (
        <>
          <div
            role="separator"
            aria-orientation={dock === "right" ? "vertical" : "horizontal"}
            aria-label="Resize DevTools"
            onPointerDown={drag}
            className={cx("shrink-0 bg-border hover:bg-primary", dock === "right" ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize")}
          />
          <div ref={pane} data-slot="browser-devtools" data-share={share} className="browser-devtools-share" />
        </>
      )}
    </div>
  );
}
