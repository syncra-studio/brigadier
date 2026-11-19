import { useEffect, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Switch } from "../components/switch";
import { errorText, run } from "../onboarding/api";
import { setSetting, useSettings } from "./api";
import { useSave } from "./general";
import { SettingsPage, SettingsSection } from "./parts";

/** The Computer use page's rows, for the page and for Settings search (the old app's words, macOS's) [D911, D912]. */
export const COMPUTER_USE_ROWS = {
  enable: { label: "Let sessions use apps on this Mac", description: "Sessions, Chats and their workers can see and control apps in the background.", section: "Enable" },
  cursor: { label: "Show cursor", description: "A cursor shows where an agent clicks, types and scrolls. Your own pointer stays yours.", section: "Enable" },
  accessibility: { label: "Accessibility", description: "Read what's in app windows and use their controls", section: "Permissions" },
  screenRecording: { label: "Screen Recording", description: "See app windows, to check what happened", section: "Permissions" },
} as const;

type Permission = "accessibility" | "screenRecording";
type PermissionState = "granted" | "notGranted" | "unknown";
/** `brigadier computer status`, as Rust says it. */
type Status = { on: boolean; helper: "off" | "absent" | "starting" | "ready" | "failed"; error?: string; noCursor?: string | null } & Record<Permission, PermissionState>;

const PERMISSIONS: readonly Permission[] = ["accessibility", "screenRecording"];
const STATUS_MS = 2000;

const STATE_LABEL: Record<PermissionState, string> = {
  granted: "Granted",
  notGranted: "Not granted",
  unknown: "Unknown",
};

/**
 * Settings › Computer use, the old page cut to its switch, Show cursor [D956] and the two macOS permissions [D911, D912]: Rust's status,
 * read again every 2 s while the page shows. The switch moves at once and holds until a status after the change.
 */
export function ComputerUsePage() {
  const [read, setRead] = useState<{ status?: Status; error?: string }>({});
  const [wanted, setWanted] = useState<boolean | null>(null);
  const save = useSave();
  const cursorSave = useSave();
  const settings = useSettings().value;
  const load = () =>
    run(["computer", "status"]).then(
      (reply) => setRead({ status: reply as Status }),
      (cause: unknown) => setRead((last) => ({ ...last, error: errorText(cause) })),
    );
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), STATUS_MS);
    return () => clearInterval(timer);
  }, []);
  const status = read.status ?? null;
  const on = wanted ?? status?.on ?? false;
  // The first status after turning on hasn't come back.
  const checking = wanted === true;
  const toggle = (next: boolean) => {
    setWanted(next);
    save.run(() => run(["computer", next ? "on" : "off"]).then(load).finally(() => setWanted(null)));
  };
  const row = COMPUTER_USE_ROWS.enable;
  const cursor = COMPUTER_USE_ROWS.cursor;
  const noCursor = status?.noCursor ? `The cursor can't show in this build: ${status.noCursor}` : null;
  return (
    <SettingsPage title="Computer use">
      <SettingsSection title="Enable">
        <SettingsCard>
          <SettingsRow label={row.label} description={row.description} error={save.error ?? status?.error ?? read.error}>
            <Switch aria-label={row.label} checked={on} onCheckedChange={toggle} />
          </SettingsRow>
          {settings && (
            <SettingsRow label={cursor.label} description={cursor.description} error={cursorSave.error ?? noCursor}>
              <Switch aria-label={cursor.label} checked={settings.computer_cursor} onCheckedChange={(next) => cursorSave.run(() => setSetting("computer_cursor", next))} />
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Permissions">
        <SettingsCard>
          {PERMISSIONS.map((permission) => (
            <PermissionRow key={permission} permission={permission} status={status} checking={checking} enabled={on} />
          ))}
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}

function PermissionRow({ permission, status, checking, enabled }: { permission: Permission; status: Status | null; checking: boolean; enabled: boolean }) {
  const grant = useSave();
  const open = useSave();
  const [busy, setBusy] = useState(false);
  const row = COMPUTER_USE_ROWS[permission];
  const state = status ? status[permission] : "unknown";
  const ask = () => {
    setBusy(true);
    return run(["computer", "grant", permission]).finally(() => setBusy(false));
  };
  return (
    <SettingsRow label={row.label} description={row.description} error={grant.error ?? open.error}>
      <Badge data-slot="permission-state" variant={state === "granted" ? "success" : state === "notGranted" ? "warning" : "secondary"}>
        {checking ? "Checking…" : STATE_LABEL[state]}
      </Badge>
      {state !== "granted" && !checking && (
        <Button variant="soft" size="sm" disabled={!enabled || busy} onClick={() => grant.run(ask)}>
          Grant…
        </Button>
      )}
      <Button variant="soft" size="sm" aria-label={`Open System Settings for ${row.label}`} onClick={() => open.run(() => window.brigadier?.openPrivacySettings(permission))}>
        Open System Settings
      </Button>
    </SettingsRow>
  );
}
