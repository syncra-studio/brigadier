import { useState } from "react";

import { FullAccessDialog, LEVELS } from "../components/composer/pickers";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Select } from "../components/select";
import { type Settings, setSetting, useSettings } from "./api";
import { useSave } from "./general";
import { SettingsPage } from "./parts";

/** The Configuration page's rows, for the page and for Settings search. */
export const CONFIGURATION_ROWS = {
  permission: { label: "Default permission level", description: "Choose how much new sessions may do without asking" },
  ...Object.fromEntries(LEVELS.map(({ level, label, detail }) => [level, { label, description: detail, section: "Default permission level" }])),
} as const;

/**
 * Configuration, the old app's page cut to its one row we have [D187, D2022]: the level a new session starts on in
 * a trusted project. An untrusted project's still start on Ask, and an agent with no such level on its own most
 * restrictive; Rust decides both [D201]. Full access asks first, with the composer's own confirm.
 */
export function ConfigurationPage() {
  const { value: settings, error } = useSettings();
  const save = useSave();
  const [confirming, setConfirming] = useState(false);
  const pick = (level: Settings["default_level"]) => save.run(() => setSetting("default_level", level));
  return (
    <SettingsPage title="Configuration" description="Choose how Brigadier works on your tasks. A project you haven’t trusted still starts on Ask.">
      <SettingsCard>
        <SettingsRow label={CONFIGURATION_ROWS.permission.label} description={settings ? CONFIGURATION_ROWS.permission.description : error ? undefined : "Loading…"} error={save.error ?? error}>
          {settings && (
            <Select
              label={CONFIGURATION_ROWS.permission.label}
              value={settings.default_level}
              options={LEVELS.map(({ level, label, detail }) => ({ value: level, label, hint: detail }))}
              onChange={(level) => (level === "full" ? setConfirming(true) : pick(level))}
            />
          )}
        </SettingsRow>
      </SettingsCard>
      <FullAccessDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          pick("full");
        }}
      />
    </SettingsPage>
  );
}
