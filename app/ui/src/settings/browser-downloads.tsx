import { useEffect, useState } from "react";

import { browserDownloads, byDay, cancelDownload, downloadProgress, type DownloadRecord, removeDownloads, revealDownload, siteOf, useDownloadChanges } from "../browser/data";
import { useDefaultProfile } from "../browser/profiles";
import { Button } from "../components/button";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { DropdownMenuItem } from "../components/menu";
import { SettingsCard } from "../components/settings-card";
import { Download, Folder, Trash } from "../icons";
import { errorText } from "../onboarding/api";
import { useNow } from "../session/shown";
import { SearchField } from "./archived-toolbar";
import { ProfilePicker } from "./browser-clear";
import { dataBack, formatTime, RowMenu } from "./browser-parts";
import { SettingsPage, SettingsSection } from "./parts";

const MAC = window.brigadier?.platform === "darwin";

const STATES: Record<DownloadRecord["state"], string | null> = {
  running: "Downloading",
  done: null,
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * One file in Download history: its name over its state and site, the time, and a menu to reveal
 * it (once done) or remove it from the history. `onError` takes what revealing failed with.
 */
function DownloadRow({ download, onRemove, onCancel, onError }: { download: DownloadRecord; onRemove: () => void; onCancel: () => void; onError: (error: string) => void }) {
  const name = download.path.split(/[\\/]/).pop() || download.path;
  const state = STATES[download.state];
  return (
    <li className="flex min-h-12 items-center gap-3 py-1.5">
      <Download aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label" title={download.path}>
          {name}
        </span>
        <span className="truncate text-xs text-quiet-foreground">
          {download.state === "running" ? `${state} · ${downloadProgress(download)} · ` : state ? `${state} · ` : ""}
          {siteOf(download.url)}
        </span>
        {download.state === "running" && (
          <progress aria-label={`Progress of ${name}`} className="mt-1 h-1 w-full" max={download.totalBytes || 1} {...(download.totalBytes ? { value: download.receivedBytes ?? 0 } : {})} />
        )}
      </span>
      <span className="shrink-0 text-xs text-quiet-foreground tabular-nums">{formatTime(download.atMs)}</span>
      {download.state === "running" && (
        <Button variant="soft" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      )}
      <RowMenu name={name}>
        {download.state === "done" && (
          <DropdownMenuItem onClick={() => void revealDownload(download.path).catch((cause: unknown) => onError(errorText(cause)))}>
            <Folder />
            {MAC ? "Reveal in Finder" : "Show in folder"}
          </DropdownMenuItem>
        )}
        {download.state !== "running" && (
          <DropdownMenuItem variant="destructive" onClick={onRemove}>
            <Trash />
            Remove from history
          </DropdownMenuItem>
        )}
      </RowMenu>
    </li>
  );
}

/** Settings › Browser › Download history: the files the browser downloaded, by day. */
export function BrowserDownloads({ profile: opened }: { profile?: string | undefined }) {
  const fallback = useDefaultProfile();
  const [profile, setProfile] = useState(opened ?? fallback.id);
  const told = useDownloadChanges();
  const [query, setQuery] = useState("");
  const [downloads, setDownloads] = useState<DownloadRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(true, 60_000);

  useEffect(() => {
    let current = true;
    const timer = setTimeout(
      () => {
        browserDownloads(profile, query)
          .then((found) => current && setDownloads(found))
          .catch((cause: unknown) => current && setError(errorText(cause)));
      },
      query ? 150 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // `told` reads the list again as a download moves or is removed.
  }, [profile, query, told]);

  const remove = (ids: number[] | null) => {
    removeDownloads(profile, ids).catch((cause: unknown) => setError(errorText(cause)));
  };

  const shown = downloads ?? [];
  const days = byDay(shown, now);
  return (
    <SettingsPage title="Download history" back={dataBack(opened)}>
      <ProfilePicker value={profile} onChange={setProfile} />
      <SearchField label="Search download history" value={query} onChange={setQuery} />
      <SettingsSection
        title="All-time history"
        actions={
          <Button variant="soft" size="sm" disabled={!shown.some((each) => each.state !== "running")} onClick={() => remove(null)}>
            Clear all
          </Button>
        }
      >
        <ErrorLine error={error} />
        {downloads && days.length === 0 && (
          <SettingsCard>
            <EmptyState variant="centered" icon={Download} title={query ? "No downloads match" : "No downloads yet"} detail={!query && "Files you download in the built-in browser show here."} />
          </SettingsCard>
        )}
        {days.map((day) => (
          <SettingsSection key={day.key} title={day.label}>
            <SettingsCard inset>
              <ul className="divide-y divide-divider">
                {day.items.map((download) => (
                  <DownloadRow
                    key={download.id}
                    download={download}
                    onRemove={() => remove([download.id])}
                    onCancel={() => void cancelDownload(profile, download.id).catch((cause: unknown) => setError(errorText(cause)))}
                    onError={setError}
                  />
                ))}
              </ul>
            </SettingsCard>
          </SettingsSection>
        ))}
      </SettingsSection>
    </SettingsPage>
  );
}
