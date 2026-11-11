import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Select } from "../components/select";
import { SettingsPage } from "./parts";

/** The Git page's rows, for the page and for Settings search. */
export const GIT_ROWS = {
  writer: { label: "Write with", description: "The model that writes a commit message when you commit from the card without one" },
} as const;

/** Git, the old app's page with its one row [D1224, D2004]. */
export function GitPage() {
  return (
    <SettingsPage title="Git">
      <SettingsCard>
        <SettingsRow label={GIT_ROWS.writer.label} description={GIT_ROWS.writer.description}>
          {/* shortcut: drawn only (D388); 3.8 wires it to Rust's catalog once wave 2's writer that takes a model is on main. */}
          <Select label={GIT_ROWS.writer.label} value="automatic" options={[{ value: "automatic", label: "Automatic" }]} onChange={() => {}} disabled />
        </SettingsRow>
      </SettingsCard>
    </SettingsPage>
  );
}
