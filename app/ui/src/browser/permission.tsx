import { type RefObject, useEffect, useState } from "react";

import { Button } from "../components/button";
import { TooltipIconButton } from "../components/icon-button";
import { Popover, PopoverContent } from "../components/popover";
import { X } from "../icons";
import { Camera, MapPin, Mic } from "../icons/browser";
import { answerPermission, type BrowserAsking, closeOsRefused, type LocationWhy, type OsRefused } from "./pages";

const ARM_MS = 500;
const MAC = window.brigadier?.platform === "darwin";

/** Only Esc or the card's own ×: a click on the page around it mustn't answer for the person. */
const keepOpen = (close: () => void) => (open: boolean, { reason }: { reason: string }) => {
  if (!open && reason !== "outside-press" && reason !== "focus-out") close();
};

/**
 * The page's question for the camera, microphone or location, from the address field's start:
 * allow it while visiting the site or this time only, or not; Brigadier forgets the answer when it quits. It stays until it is answered or closed (which
 * refuses this time), and leaves the page live around it.
 */
export function PermissionPrompt({ id, asking, anchor }: { id: string; asking: BrowserAsking | null | undefined; anchor: RefObject<HTMLDivElement | null> }) {
  let site = asking?.origin ?? "";
  try {
    site = new URL(site).host;
  } catch {
    // The origin as main named it.
  }
  // A click meant for the page must not land on a card that just came up under it.
  const [armedFor, setArmedFor] = useState<number | null>(null);
  const request = asking?.request ?? null;
  useEffect(() => {
    if (request === null) return;
    const timer = setTimeout(() => setArmedFor(request), ARM_MS);
    return () => clearTimeout(timer);
  }, [request]);
  const armed = request !== null && armedFor === request;
  const uses = [
    ...(asking?.camera ? [{ Icon: Camera, text: "Use your camera" }] : []),
    ...(asking?.microphone ? [{ Icon: Mic, text: "Use your microphone" }] : []),
    ...(asking?.location ? [{ Icon: MapPin, text: "Know your location" }] : []),
  ];
  return (
    <Popover open={!!asking} onOpenChange={keepOpen(() => answerPermission(id, "dismiss"))}>
      <PopoverContent
        anchor={anchor}
        align="start"
        aria-label={`Website permission request from ${site}`}
        data-slot="browser-permission"
        // Not a menu: the page stays live around it.
        data-above-page
        padded={false}
        initialFocus={false}
        className="w-browser-site-info p-3"
      >
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 pt-1 text-label font-medium break-words">{site} wants to</p>
          <TooltipIconButton tooltip="Close permission request" size="icon-xs" onClick={() => answerPermission(id, "dismiss")}>
            <X />
          </TooltipIconButton>
        </div>
        <ul className="mt-2 flex flex-col gap-1.5">
          {uses.map(({ Icon, text }) => (
            <li key={text} className="flex items-center gap-2 text-label">
              <Icon aria-hidden className="size-icon-md shrink-0 text-muted-foreground" />
              {text}
            </li>
          ))}
        </ul>
        <div className="mt-3 flex flex-col gap-1.5">
          <Button size="sm" variant="secondary" disabled={!armed} onClick={() => answerPermission(id, "visiting")}>Allow while visiting the site</Button>
          <Button size="sm" variant="secondary" disabled={!armed} onClick={() => answerPermission(id, "once")}>Allow this time</Button>
          <Button size="sm" variant="secondary" disabled={!armed} onClick={() => answerPermission(id, "never")}>Don't allow</Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

const REFUSED_NAMES: Record<OsRefused, string> = { camera: "the camera", microphone: "the microphone", location: "location" };

/** Why macOS gave a page no location when it isn't a plain no; only Location Services being off is System Settings' to fix. */
const LOCATION_WHY: Record<LocationWhy, string> = {
  off: "Location Services is off on this Mac, so the site can't have your location.",
  restricted: "This Mac doesn't let Brigadier use location, so the site can't have it.",
  unanswered: "macOS's location question wasn't answered, so the site can't have it this time.",
  unavailable: "Brigadier can't get your location on this Mac, so the site can't have it.",
};

/**
 * After a yes in the card: the system refused, or has off, what the person just allowed. The page hears the
 * refusal too; this says why, and where to change it.
 */
export function OsRefusedNotice({ id, refused, anchor }: { id: string; refused: { origin: string; refused: OsRefused[]; why?: LocationWhy } | null | undefined; anchor: RefObject<HTMLDivElement | null> }) {
  const devices = refused?.refused ?? [];
  const names = devices.map((device) => REFUSED_NAMES[device]).join(" and ");
  const why = refused?.why;
  return (
    <Popover open={devices.length > 0} onOpenChange={keepOpen(() => closeOsRefused(id))}>
      <PopoverContent
        anchor={anchor}
        align="start"
        aria-label="The system refused a website permission"
        data-slot="browser-permission-refused"
        data-above-page
        padded={false}
        initialFocus={false}
        className="w-browser-site-info p-3"
      >
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 pt-1 text-label break-words">{why ? LOCATION_WHY[why] : `${MAC ? `macOS isn't giving Brigadier ${names}` : `Brigadier can't get ${names} on this system yet`}, so the site can't have it.`}</p>
          <TooltipIconButton tooltip="Close" size="icon-xs" onClick={() => closeOsRefused(id)}>
            <X />
          </TooltipIconButton>
        </div>
        {MAC && (!why || why === "off") && (
          <Button
            className="mt-3 w-full"
            size="sm"
            variant="secondary"
            onClick={() => {
              if (devices[0]) void window.brigadierShell.openPermissionSettings(devices[0]);
              closeOsRefused(id);
            }}
          >
            Open System Settings
          </Button>
        )}
      </PopoverContent>
    </Popover>
  );
}
