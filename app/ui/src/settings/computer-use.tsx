import { useEffect, useRef, useState } from "react";

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
  web: { label: "Web pages in Brigadier's browser", description: "Agents open web pages in Brigadier's browser, not in yours, unless you name your browser in the chat.", section: "Enable" },
  accessibility: { label: "Accessibility", description: "Read what's in app windows and use their controls", section: "Permissions" },
  screenRecording: { label: "Screen Recording", description: "See app windows, to check what happened", section: "Permissions" },
} as const;

type Permission = "accessibility" | "screenRecording";
type PermissionState = "granted" | "notGranted" | "unknown";
/** `brigadier computer status`, as Rust says it. */
type Status = { on: boolean; helper: "off" | "absent" | "starting" | "ready" | "failed"; error?: string; noCursor?: string | null } & Record<Permission, PermissionState>;

const PERMISSIONS: readonly Permission[] = ["accessibility", "screenRecording"];
const STATUS_MS = 2000;
// The last status read, kept across launches: the page paints it at once and reads again quietly [D322].
const KEPT = "computerUse.status";
const keptStatus = (): Status | undefined => JSON.parse(localStorage.getItem(KEPT) ?? "null") ?? undefined;
/** The status with each grant Rust can't say now as it was last known. */
const known = (next: Status, last: Status | undefined): Status =>
  last ? { ...next, ...Object.fromEntries(PERMISSIONS.map((each) => [each, next[each] === "unknown" ? last[each] : next[each]])) } : next;

const STATE_LABEL: Record<PermissionState, string> = {
  granted: "Granted",
  notGranted: "Not granted",
  unknown: "Unknown",
};

/**
 * Settings › Computer use, the old page cut to its switch, Show cursor [D956], Web pages in Brigadier's browser [D2032] and the two macOS permissions [D911, D912]: Rust's status,
 * read again every 2 s while the page shows, the last one kept painting at once. The switch moves at once and holds until a status after the change.
 */
export function ComputerUsePage() {
  const last = useRef(keptStatus());
  const [read, setRead] = useState<{ status?: Status; error?: string; fresh?: boolean }>({ status: last.current });
  const [wanted, setWanted] = useState<boolean | null>(null);
  const save = useSave();
  const cursorSave = useSave();
  const webSave = useSave();
  const settings = useSettings().value;
  const load = () =>
    run(["computer", "status"]).then(
      (reply) => {
        const next = reply as Status;
        last.current = known(next, last.current);
        localStorage.setItem(KEPT, JSON.stringify({ ...last.current, error: undefined }));
        // Rust says "unknown" while its helper starts, or when it didn't before ever answering: the last known grant stands, as Rust's own does.
        setRead({ status: next.helper === "starting" || next.helper === "failed" ? last.current : next, fresh: true });
      },
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
  // Nothing read this visit yet, or the helper still starting: an unknown grant is being checked, never shown as Unknown.
  const starting = !read.fresh || status?.helper === "starting";
  const toggle = (next: boolean) => {
    setWanted(next);
    save.run(() => run(["computer", next ? "on" : "off"]).then(load).finally(() => setWanted(null)));
  };
  const row = COMPUTER_USE_ROWS.enable;
  const cursor = COMPUTER_USE_ROWS.cursor;
  const web = COMPUTER_USE_ROWS.web;
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
          {settings && (
            <SettingsRow label={web.label} description={web.description} error={webSave.error}>
              <Switch aria-label={web.label} checked={settings.computer_web} onCheckedChange={(next) => webSave.run(() => setSetting("computer_web", next))} />
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Permissions">
        <SettingsCard>
          {PERMISSIONS.map((permission) => (
            <PermissionRow key={permission} permission={permission} status={status} checking={checking} starting={starting} enabled={on} />
          ))}
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}

/** Test screen access's words (proposed) [C91]. */
const TEST = { label: "Test screen access", busy: "Testing…", done: "Done. macOS may ask you to allow it: choose Allow.", noWindow: "Couldn't find Brigadier's window." } as const;

function PermissionRow({ permission, status, checking: switching, starting, enabled }: { permission: Permission; status: Status | null; checking: boolean; starting: boolean; enabled: boolean }) {
  const grant = useSave();
  const open = useSave();
  const test = useSave();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);
  const row = COMPUTER_USE_ROWS[permission];
  const state = status ? status[permission] : "unknown";
  const checking = switching || (starting && state === "unknown");
  // Only once Screen Recording reads granted; its words go with the button.
  const testable = permission === "screenRecording" && state === "granted" && !checking && enabled;
  const ask = () => {
    setBusy(true);
    return run(["computer", "grant", permission]).finally(() => setBusy(false));
  };
  // One throwaway capture of this window on the user's click, so macOS's capture alert comes while they're here [C91, D2032].
  const capture = async () => {
    setTested(false);
    setTesting(true);
    try {
      const own = await window.brigadier?.ownWindow();
      if (!own) throw new Error(TEST.noWindow);
      await run(["computer", "test", String(own.pid), String(own.window)]);
      setTested(true);
    } finally {
      setTesting(false);
    }
  };
  return (
    <SettingsRow label={row.label} description={testable && tested ? TEST.done : row.description} error={grant.error ?? open.error ?? (testable ? test.error : null)}>
      <Badge data-slot="permission-state" variant={state === "granted" ? "success" : state === "notGranted" ? "warning" : "secondary"}>
        {checking ? "Checking…" : STATE_LABEL[state]}
      </Badge>
      {state !== "granted" && !checking && (
        <Button variant="soft" size="sm" disabled={!enabled || busy} onClick={() => grant.run(ask)}>
          Grant…
        </Button>
      )}
      {testable && (
        <Button variant="soft" size="sm" disabled={testing} onClick={() => test.run(capture)}>
          {testing ? TEST.busy : TEST.label}
        </Button>
      )}
      <Button variant="soft" size="sm" aria-label={`Open System Settings for ${row.label}`} onClick={() => open.run(() => window.brigadier?.openPrivacySettings(permission))}>
        Open System Settings
      </Button>
    </SettingsRow>
  );
}
