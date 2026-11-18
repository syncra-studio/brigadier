import { type ReactNode, useEffect, useState } from "react";

import { sitesCleared } from "../browser/data";
import { profileCounts, reloadProfileTabs, useDefaultProfile, useProfiles } from "../browser/profiles";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Segmented } from "../components/segmented";
import { Select } from "../components/select";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Download, SettingsCog, Trash } from "../icons";
import { Images } from "../icons/browser";
import { errorText, run } from "../onboarding/api";

/** Which profile's data a Settings page shows: downloads and clearing are each profile's own. */
export function ProfilePicker({ value, onChange }: { value: string; onChange: (profile: string) => void }) {
  const profiles = useProfiles();
  return (
    <SettingsCard>
      <SettingsRow label="Profile">
        <Select label="Profile" value={value} onChange={onChange} options={profiles.map((each) => ({ value: each.id, label: each.name }))} />
      </SettingsRow>
    </SettingsCard>
  );
}

type ClearRange = "hour" | "day" | "week" | "month" | "all";
const RANGES = [
  { value: "hour", label: "Last hour" },
  { value: "day", label: "Last 24 hours" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "Last 4 weeks" },
  { value: "all", label: "All time" },
] as const satisfies readonly { value: ClearRange; label: string }[];

const HOUR = 60 * 60 * 1000;
const SINCE: Record<ClearRange, number | null> = { hour: HOUR, day: 24 * HOUR, week: 7 * 24 * HOUR, month: 28 * 24 * HOUR, all: null };

type Kind = "cookies" | "cache" | "downloads" | "sites";
type ClearRequest = { sinceMs: number | null } & Record<Kind, boolean>;

/** Picked when the dialog opens: everything but the sites' camera, microphone and location choices. */
const PICKED: Record<Kind, boolean> = { cookies: true, cache: true, downloads: true, sites: false };

/** Rust clears what it keeps; main clears Chromium's, with Rust's dates for a range (main's browser/browserClearData.ts). */
async function clearBrowsingData(profile: string, clear: ClearRequest): Promise<void> {
  const data = (args: string[]) => run(["browser", "-", ...args, "--profile", profile]);
  const range = clear.sinceMs === null ? [] : ["--since-ms", String(clear.sinceMs)];
  if (clear.downloads) await data(["downloads", "clear", ...range]);
  if (clear.sites) {
    await data(["sites", "clear", ...range]);
    sitesCleared(profile);
  }
  // Local sites opened anyway ask again (main's browser/localCerts.ts forgets its copy with the cookies).
  if (clear.cookies) await data(["certs", "clear"]);
  if (!clear.cookies && !clear.cache) return;
  const dated = clear.cookies && clear.sinceMs !== null ? await data(["dates", "since", String(clear.sinceMs)]) : null;
  await window.brigadierShell.profiles("clear", { profile, clear: { sinceMs: clear.sinceMs, cookies: clear.cookies, cache: clear.cache, dated } });
  if (clear.cookies && clear.sinceMs === null) await data(["dates", "clear"]);
}

function sitesLine(count: number | null | undefined): string {
  if (count === undefined || count === null) return "Signs you out of most sites.";
  if (count === 0) return "No site keeps any now.";
  return `Kept for ${count} ${count === 1 ? "site" : "sites"} now. Signs you out of most of them.`;
}

/** Clear browsing data: a time range and what to remove from Brigadier's browser, starting on `profile`. */
export function ClearBrowsingDataDialog({ profile, open, onOpenChange, onCleared }: { profile?: string; open: boolean; onOpenChange: (open: boolean) => void; onCleared?: () => void }) {
  const fallback = useDefaultProfile();
  const [clearing, setClearing] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(next) => !clearing && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Clear browsing data</DialogTitle>
          <DialogDescription className="sr-only">Choose a time range and what to remove from Brigadier's browser.</DialogDescription>
        </DialogHeader>
        {/* Made each time it opens, so it starts from the usual picks. */}
        {open && (
          <ClearForm
            opened={profile ?? fallback.id}
            clearing={clearing}
            setClearing={setClearing}
            onDone={() => {
              onCleared?.();
              onOpenChange(false);
            }}
            onCancel={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function ClearForm({ opened, clearing, setClearing, onDone, onCancel }: { opened: string; clearing: boolean; setClearing: (on: boolean) => void; onDone: () => void; onCancel: () => void }) {
  const [profile, setProfile] = useState(opened);
  const [range, setRange] = useState<ClearRange>("hour");
  const [picked, setPicked] = useState(PICKED);
  const [sites, setSites] = useState<number | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    profileCounts(profile).then(({ signIns }) => setSites(signIns), () => setSites(null));
  }, [profile]);
  const kinds: { kind: Kind; icon: ReactNode; label: string; detail: string }[] = [
    { kind: "cookies", icon: <Trash />, label: "Cookies and site data", detail: sitesLine(sites) },
    { kind: "cache", icon: <Images />, label: "Cached images and files", detail: "All of it, whatever the time range. Pages may load more slowly the next time." },
    { kind: "downloads", icon: <Download />, label: "Download history", detail: "The list only; downloaded files stay." },
    { kind: "sites", icon: <SettingsCog />, label: "Site settings", detail: "Which sites may use your camera, microphone and location." },
  ];
  const clear = () => {
    const since = SINCE[range];
    const request: ClearRequest = { sinceMs: since === null ? null : Date.now() - since, ...picked };
    setClearing(true);
    setError(null);
    clearBrowsingData(profile, request).then(
      () => {
        if (request.cookies) reloadProfileTabs(profile);
        setClearing(false);
        onDone();
      },
      (cause: unknown) => {
        setClearing(false);
        setError(errorText(cause));
      },
    );
  };
  return (
    <>
      <ProfilePicker value={profile} onChange={setProfile} />
      <Segmented label="Time range" value={range} options={RANGES} onChange={setRange} />
      <SettingsCard inset>
        {kinds.map(({ kind, icon, label, detail }) => (
          <label key={kind} className="flex min-h-14 cursor-pointer items-center gap-3 py-2">
            <span aria-hidden className="flex shrink-0 text-muted-foreground svg:size-icon-md">
              {icon}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-label">{label}</span>
              <span className="text-xs text-muted-foreground">{detail}</span>
            </span>
            <Checkbox checked={picked[kind]} onCheckedChange={(checked) => setPicked((shown) => ({ ...shown, [kind]: checked }))} />
          </label>
        ))}
      </SettingsCard>
      <p className="text-xs text-muted-foreground">Other profiles aren't touched.</p>
      <ErrorLine error={error} />
      <DialogFooter>
        <Button variant="ghost" disabled={clearing} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={clearing || !Object.values(picked).some(Boolean)} onClick={clear}>
          {clearing ? "Deleting…" : "Delete data"}
        </Button>
      </DialogFooter>
    </>
  );
}
