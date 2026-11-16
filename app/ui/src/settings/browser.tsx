import { Select } from "../components/select";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { type Settings, setSetting, useSettings } from "./api";
import { useSave } from "./general";
import { SettingsPage, SettingsSection } from "./parts";

/** The Browser page's rows, for the page and for Settings search (the old app's words). */
export const BROWSER_ROWS = {
  webLinks: { label: "Open web links in", description: "Where links in answers, search results and pull requests open", section: "General" },
  localLinks: { label: "Open local dev URLs in", description: "Where localhost and other local development sites open, such as a running preview", section: "General" },
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

/** Settings › Browser, the old app's page; its other sections come with their parts [D507, D516]. */
export function BrowserPage() {
  return (
    <SettingsPage title="Browser" description={PAGE_DESCRIPTION}>
      <SettingsSection title="General">
        <SettingsCard>
          <LinkRow setting="web_links_in" row={BROWSER_ROWS.webLinks} />
          <LinkRow setting="local_links_in" row={BROWSER_ROWS.localLinks} />
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}
