import type { ReactNode } from "react";

import { Button } from "../components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "../components/menu";
import { DotsHorizontal } from "../icons";
import { store } from "../onboarding/api";
import { profileHref } from "./browser-profiles";

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

/** A row's time of day, as Download history shows it. */
export const formatTime = (epochMs: number): string => timeFormat.format(epochMs);

/** A page of Settings › Browser: `#settings/browser/<view>`, and `/<profile>` when opened for one. */
export type BrowserSettingsView = "downloads";

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
