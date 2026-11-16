import { useState } from "react";

import { cx } from "../components/cx";
import { TooltipIconButton } from "../components/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { Info, Warning } from "../icons";
import { Lock } from "../icons/browser";
import { openBrowserSettings } from "../settings/browser-parts";
import { siteSecurity } from "./address";

const MAC = window.brigadier?.platform === "darwin";

/** What the site information popover says of each kind of page. */
const SECURITY = {
  secure: {
    label: "View site information",
    Icon: Lock,
    title: "Connection is secure",
    detail: "Passwords, card numbers and anything else you send this site stay private on the way there.",
  },
  insecure: {
    label: "Not secure, view site information",
    Icon: Warning,
    title: "Connection is not secure",
    detail: "Don't enter passwords, card numbers or other private information here: others on the network could read them.",
  },
  local: {
    label: "View site information",
    Icon: Info,
    title: "Connection is not secure",
    detail: "This page comes from your own computer, so what you send it doesn't travel over the network.",
  },
} as const;

/**
 * The address field's start: a lock for https (shown while the pointer is over the field), "Not
 * secure" for http, nothing on the New tab page. It opens what is known of the connection.
 */
export function SiteInfo({ url }: { url: string }) {
  const security = siteSecurity(url);
  const [open, setOpen] = useState(false);
  if (!security) return null;
  const { label, Icon, title, detail } = SECURITY[security];
  let host = url;
  try {
    host = new URL(url).host;
  } catch {
    // siteSecurity read it already.
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <TooltipIconButton
            tooltip={label}
            size="icon-md"
            data-slot="browser-site-info"
            data-security={security}
            className={cx(
              "shrink-0 rounded-capsule",
              security === "insecure"
                ? "w-auto gap-1 px-2 text-xs text-destructive"
                : "opacity-0 group-hover/address:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100",
            )}
          />
        }
      >
        <Icon />
        {security === "insecure" && <span aria-hidden>Not secure</span>}
      </PopoverTrigger>
      {/* What is known of the page's connection: its host, whether it is secure, and Site settings (macOS). */}
      <PopoverContent align="start" aria-label="Site information" padded={false} className="w-browser-site-info p-3">
        <p className="truncate text-label font-medium">{host}</p>
        <div className="mt-3 flex items-start gap-2">
          <Icon aria-hidden className={cx("mt-0.5 size-icon-md shrink-0", security === "insecure" && "text-destructive")} />
          <div className="min-w-0">
            <p className="text-label">{title}</p>
            <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
          </div>
        </div>
        {MAC && (
          <>
            <div className="-mx-3 my-3 h-px bg-border" />
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openBrowserSettings("sites");
              }}
              className="-mx-1 flex h-browser-menu-item w-full items-center rounded-capsule px-1 text-label hover:bg-fill"
            >
              Site settings
            </button>
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}
