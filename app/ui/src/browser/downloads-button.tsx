import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { TooltipIconButton } from "../components/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { showToast } from "../components/toast";
import { Download } from "../icons";
import { errorText } from "../onboarding/api";
import { openBrowserSettings } from "../settings/browser-parts";
import { type Tab } from "../shell/tab-store";
import { known, useProfiles, useSessionProfile } from "./profiles";
import { browserDownloads, cancelDownload, downloadProgress, type DownloadRecord, openDownload, revealDownload, siteOf, useDownloadChanges } from "./data";

const MAC = window.brigadier?.platform === "darwin";

/** The profile a tab's page is on: its own, else its session's (the old tabProfileId). */
function useTabProfile(owner: string, tab: Tab): string {
  useProfiles();
  const session = useSessionProfile(owner);
  return known(tab.profile) ?? session;
}

const STATES: Record<DownloadRecord["state"], string | null> = {
  running: "Downloading",
  done: null,
  failed: "Failed",
  cancelled: "Cancelled",
};

/** How many of the newest downloads the popover lists. */
const NEWEST = 5;

const failed = (cause: unknown) => showToast(errorText(cause), { tone: "error" });

/**
 * The toolbar's Downloads, once the browser has downloaded something: the newest files, each to
 * open or show in its folder, and all of them in Settings.
 */
export function DownloadsButton({ owner, tab }: { owner: string; tab: Tab }) {
  const profile = useTabProfile(owner, tab);
  const changes = useDownloadChanges();
  const [open, setOpen] = useState(false);
  const [downloads, setDownloads] = useState<DownloadRecord[]>([]);
  const [read, setRead] = useState(0);
  useEffect(() => {
    let current = true;
    browserDownloads(profile, "").then(
      (found) => current && setDownloads(found.slice(0, NEWEST)),
      () => {},
    );
    return () => {
      current = false;
    };
    // Read again as a download moves and as the popover opens.
  }, [profile, changes, read]);
  if (downloads.length === 0) return null;
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) setRead((count) => count + 1);
      }}
    >
      <PopoverTrigger render={<TooltipIconButton tooltip="Downloads" size="icon-md" className="shrink-0 rounded-capsule @max-md/browser-toolbar:hidden" />}>
        <Download />
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Downloads" data-slot="browser-downloads" padded={false} className="w-browser-downloads p-1">
        <ul>
          {downloads.map((download) => {
            const name = download.path.split(/[\\/]/).pop() || download.path;
            const state = STATES[download.state];
            return (
              <li key={download.id} className="flex items-center gap-2 rounded-capsule py-1.5 ps-2 pe-1">
                <Download aria-hidden className="size-icon-md shrink-0 text-muted-foreground" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-label" title={download.path}>
                    {name}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {download.state === "running" ? `${downloadProgress(download)} · ` : state ? `${state} · ` : ""}
                    {siteOf(download.url)}
                  </span>
                </span>
                {download.state === "running" && (
                  <Button size="xs" variant="ghost" onClick={() => cancelDownload(profile, download.id).catch(failed)}>
                    Cancel
                  </Button>
                )}
                {download.state === "done" && (
                  <>
                    <Button size="xs" variant="ghost" onClick={() => openDownload(profile, download.id).catch(failed)}>
                      Open
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => revealDownload(download.path).catch(failed)}>
                      {MAC ? "Show in Finder" : "Show in folder"}
                    </Button>
                  </>
                )}
              </li>
            );
          })}
        </ul>
        <div className="mx-1 my-1 h-px bg-border" />
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            openBrowserSettings("downloads", profile);
          }}
          className="flex h-browser-menu-item w-full items-center rounded-capsule px-2 text-label hover:bg-fill"
        >
          All downloads
        </button>
      </PopoverContent>
    </Popover>
  );
}
