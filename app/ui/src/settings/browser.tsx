import { Button } from "../components/button";
import { Select } from "../components/select";
import { shortPath } from "../projects/add-project";
import { ClearBrowsingDataDialog } from "./browser-clear";
import { BrowserDownloads } from "./browser-downloads";
import { type BrowserSettingsView, openBrowserSettings, setClearingBrowsingData as setClearing, useClearingBrowsingData } from "./browser-parts";
import { ProfileDetailPage } from "./browser-profile";
import { ProfilesSection } from "./browser-profiles";
import { BrowserSiteSettings } from "./browser-sites";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { type Settings, setSetting, useSettings } from "./api";
import { SwitchRow, useSave } from "./general";
import { SettingsPage, SettingsSection } from "./parts";

const MAC = window.brigadier?.platform === "darwin";

/** The Browser page's rows, for the page and for Settings search (the old app's words). */
export const BROWSER_ROWS = {
  webLinks: { label: "Open web links in", description: "Where links in answers, search results and pull requests open", section: "General" },
  localLinks: { label: "Open local dev URLs in", description: "Where localhost and other local development sites open, such as a running preview", section: "General" },
  data: { label: "Browsing data", description: "Clear the built-in browser's cookies, site data, cache and download history", section: "General" },
  location: { label: "Location", description: "Where files you download in the built-in browser are saved", section: "Downloads" },
  askDownloads: { label: "Ask where to save downloads", description: "Choose the folder and name for each download", section: "Downloads" },
  downloads: { label: "Download history", description: "View the files you downloaded in the built-in browser", section: "Downloads" },
  profiles: { label: "Profiles", description: "Separate sign-ins for each part of your life, and which profile new sessions start on" },
  sites: { label: "Site settings", description: "Which sites may use your camera, microphone and location, for each profile", section: "Browser permissions" },
} as const;

const PAGE_DESCRIPTION = "The built-in browser, where links open, and what it keeps.";

const TARGETS = [
  { value: "brigadier", label: "Brigadier's browser" },
  { value: "system", label: "Your default browser" },
] as const;

/** Where a kind of link opens: Brigadier's browser or the default one. */
function LinkRow({ setting, row }: { setting: "web_links_in" | "local_links_in"; row: { label: string; description: string } }) {
  const value = useSettings().value?.[setting];
  const save = useSave();
  return (
    <SettingsRow label={row.label} description={row.description} error={save.error}>
      {value && <Select<Settings[typeof setting]> label={row.label} value={value} options={TARGETS} onChange={(next) => save.run(() => setSetting(setting, next))} />}
    </SettingsRow>
  );
}

/** Downloads' folder: the system's Downloads folder until another is chosen. */
function LocationRow({ row }: { row: { label: string } }) {
  const dir = useSettings().value?.browser_downloads_dir ?? "";
  const save = useSave();
  const change = () =>
    save.run(async () => {
      const picked = (await window.brigadier?.pickFolders({ at: dir || undefined }))?.[0];
      if (picked) await setSetting("browser_downloads_dir", picked);
    });
  return (
    <SettingsRow label={row.label} description={dir ? <span title={dir}>{shortPath(dir)}</span> : "Your Downloads folder"} error={save.error}>
      <div className="flex items-center gap-2">
        {dir && (
          <Button variant="soft" size="sm" onClick={() => save.run(() => setSetting("browser_downloads_dir", ""))}>
            Use Downloads
          </Button>
        )}
        <Button variant="soft" size="sm" onClick={change}>
          Change…
        </Button>
      </div>
    </SettingsRow>
  );
}

/** A row that opens one of the browser's data pages. */
function ManageRow({ row, view }: { row: { label: string; description: string }; view: BrowserSettingsView }) {
  return (
    <SettingsRow label={row.label} description={row.description}>
      <Button variant="soft" size="sm" onClick={() => openBrowserSettings(view)}>
        Manage
      </Button>
    </SettingsRow>
  );
}

/**
 * Settings › Browser, the old app's page [D507, D516]. Its data pages are details of it: `downloads` and `sites`,
 * each with `/<profile>` when a profile's page opened it.
 */
export function BrowserPage({ detail = "" }: { detail?: string }) {
  const view = detail.split("/")[0];
  const profileId = detail.slice(view.length + 1) || undefined;
  const settings = useSettings().value;
  const ask = useSave();
  const clearing = useClearingBrowsingData();
  if (view === "profile" && profileId) return <ProfileDetailPage id={profileId} />;
  if (view === "sites") return <BrowserSiteSettings profile={profileId} />;
  if (view === "downloads") return <BrowserDownloads profile={profileId} />;
  return (
    <SettingsPage title="Browser" description={PAGE_DESCRIPTION}>
      <ProfilesSection />
      <SettingsSection title="General">
        <SettingsCard>
          <LinkRow setting="web_links_in" row={BROWSER_ROWS.webLinks} />
          <LinkRow setting="local_links_in" row={BROWSER_ROWS.localLinks} />
          <SettingsRow label={BROWSER_ROWS.data.label} description={BROWSER_ROWS.data.description}>
            <Button variant="soft" size="sm" onClick={() => setClearing(true)}>
              Clear browsing data
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Downloads">
        <SettingsCard>
          <LocationRow row={BROWSER_ROWS.location} />
          {MAC && settings && (
            <SwitchRow row={BROWSER_ROWS.askDownloads} checked={settings.browser_ask_downloads} save={ask} onChange={(on) => setSetting("browser_ask_downloads", on)} />
          )}
          <ManageRow row={BROWSER_ROWS.downloads} view="downloads" />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Browser permissions">
        <SettingsCard>
          <ManageRow row={BROWSER_ROWS.sites} view="sites" />
        </SettingsCard>
      </SettingsSection>
      <ClearBrowsingDataDialog open={clearing} onOpenChange={setClearing} />
    </SettingsPage>
  );
}
