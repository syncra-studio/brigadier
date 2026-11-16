import type { ReactNode } from "react";

import { Button } from "../components/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/collapsible";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/menu";
import { SettingsCard } from "../components/settings-card";
import { ChevronDown, DotsHorizontal } from "../icons";
import { store } from "../onboarding/api";
import { profileHref } from "./browser-profiles";

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** A row's time of day, as Browsing history and Download history show it. */
export const formatTime = (epochMs: number): string => timeFormat.format(epochMs);

/** A page of Settings › Browser: `#settings/browser/<view>`, and `/<profile>` when opened for one. */
export type BrowserSettingsView = "history" | "downloads" | "passwords" | "bookmarks" | "sites";

/** Clear browsing data is a dialog over Settings › Browser, never a route of its own. */
const clearing = store(false);
export const useClearingBrowsingData = clearing.use;
export const setClearingBrowsingData = (open: boolean) => clearing.set(open);

/** Shows Settings › Browser, at `view` when given (or with Clear browsing data open over it), for `profile` when given. */
export function openBrowserSettings(view?: BrowserSettingsView | "clear", profile?: string): void {
  if (view === "clear") clearing.set(true);
  window.location.hash = view && view !== "clear" ? `#settings/browser/${view}${profile ? `/${encodeURIComponent(profile)}` : ""}` : "#settings/browser";
}

/** Back from a page of the browser's data: to the profile's page when it was opened from there, else Browser. */
export const dataBack = (profile: string | undefined) => ({ label: "Browser", href: profile ? profileHref(profile) : "#settings/browser" });

/** One day of Browsing history (or a folder of Bookmarks): a card that folds, the day over its rows (`children`). */
export function DayGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <SettingsCard inset>
      <Collapsible defaultOpen>
        <CollapsibleTrigger className="group flex min-h-11 w-full items-center justify-between text-start text-sm font-medium">
          {label}
          <ChevronDown aria-hidden className="size-icon-sm text-quiet-foreground transition-transform group-data-panel-open:rotate-180" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="divide-y divide-divider border-t border-divider">{children}</ul>
        </CollapsibleContent>
      </Collapsible>
    </SettingsCard>
  );
}

/** A row's ⋯ menu, named for what it acts on; `children` are its items. */
export function RowMenu({ name, children }: { name: string; children: ReactNode }) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`More for ${name}`} className="shrink-0 text-quiet-foreground" />}>
        <DotsHorizontal />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
