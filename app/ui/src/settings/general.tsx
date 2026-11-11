import { useId, useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { Segmented } from "../components/segmented";
import { Select } from "../components/select";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Switch } from "../components/switch";
import { useDaemon } from "../daemon";
import { errorText } from "../onboarding/api";
import { type Settings, setSetting, useSettings } from "./api";
import { sendNotice } from "./notices";
import { SettingsPage, SettingsSection } from "./parts";

/** The General page's rows, for the page and for Settings search (the old app's words). */
export const GENERAL_ROWS = {
  followUp: { label: "Follow-up behaviour", description: "What a message sent while an agent works does", section: "Composer" },
  notifyFinished: { label: "Notify when a session finishes", description: "A notification when a chat or session is done", section: "Notifications" },
  needsYou: { label: "When something needs you", description: "Approvals and questions waiting for your answer", section: "Notifications" },
  sound: { label: "Play a sound", description: "macOS's notification sound with each notification", section: "Notifications" },
  systemSettings: { label: "macOS notifications", description: "Allow, banners and Focus are set in System Settings", section: "Notifications" },
  keepAwake: { label: "Keep the computer awake", description: "Whether this computer may sleep while Brigadier is open", section: "Power" },
  lidClosed: { label: "Keep going with the lid closed", description: "Applied whenever the computer is kept awake", section: "Power" },
  version: { label: "Version", description: "The Brigadier you're running", section: "About" },
  build: { label: "Build", description: "The build this Brigadier was made as", section: "About" },
} as const;

export const KEEP_AWAKE: readonly { value: Settings["awake"]; label: string; hint: string }[] = [
  { value: "off", label: "Off", hint: "The computer sleeps as it normally would" },
  { value: "work", label: "While agents work", hint: "The screen stays on and the computer doesn't sleep while an agent is working" },
  { value: "always", label: "Always", hint: "The screen stays on and the computer doesn't sleep until you turn this off" },
];

const NOTIFY_FINISHED: readonly { value: Settings["notify_finished"]; label: string; hint: string }[] = [
  { value: "background", label: "In the background", hint: "Only while Brigadier isn't the app in front" },
  { value: "always", label: "Always", hint: "Also while you're in Brigadier" },
  { value: "never", label: "Never", hint: "No notification when work is done" },
];

const FOLLOW_UPS = [
  { value: "queue", label: "Queue" },
  { value: "steer", label: "Steer" },
] as const;

/** A change shown at once; what it failed with stays under its row until the next try [D30]. */
export function useSave() {
  const [error, setError] = useState<string | null>(null);
  const run = (work: () => Promise<unknown> | void) => {
    setError(null);
    Promise.resolve()
      .then(work)
      .catch((cause: unknown) => setError(errorText(cause)));
  };
  return { error, run };
}

export function GeneralPage() {
  const { value: settings, error } = useSettings();
  const { daemon } = useDaemon();
  return (
    <SettingsPage title="General">
      {!settings ? (
        <SettingsCard>
          <SettingsRow label="Settings" description={error ? undefined : "Loading…"} error={error} />
        </SettingsCard>
      ) : (
        <div className={cx("flex flex-col gap-10", !daemon && "pointer-events-none opacity-disabled")}>
          <ComposerSection settings={settings} />
          <NotificationsSection settings={settings} />
          <PowerSection settings={settings} />
        </div>
      )}
      <SettingsSection title="About">
        <SettingsCard>
          <SettingsRow label={GENERAL_ROWS.version.label} description={GENERAL_ROWS.version.description}>
            <span className="text-label text-muted-foreground tabular-nums">{daemon ? `Brigadier ${daemon.version}` : "Brigadier"}</span>
          </SettingsRow>
          {Boolean(daemon?.build) && (
            <SettingsRow label={GENERAL_ROWS.build.label} description={GENERAL_ROWS.build.description}>
              <span className="text-label text-muted-foreground tabular-nums">{daemon?.build}</span>
            </SettingsRow>
          )}
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}

function ComposerSection({ settings }: { settings: Settings }) {
  const save = useSave();
  return (
    <SettingsSection title="Composer">
      <SettingsCard>
        <SettingsRow label={GENERAL_ROWS.followUp.label} description={`${GENERAL_ROWS.followUp.description}; ⌥Enter does the other for one message`} error={save.error}>
          <Segmented label={GENERAL_ROWS.followUp.label} value={settings.follow_up} options={FOLLOW_UPS} onChange={(value) => save.run(() => setSetting("follow_up", value))} />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

/** Notifications, the old app's rows [D2022], plus the sound [D2012]. The status line is worked out from what macOS did with the last notice [D2024]. */
function NotificationsSection({ settings }: { settings: Settings }) {
  const status = useSave();
  const finished = useSave();
  const needs = useSave();
  const sound = useSave();
  // The rows stay usable while notifications are off, dimmed: they apply once they're on.
  const off = settings.notices !== "sent";
  return (
    <SettingsSection title="Notifications">
      <SettingsCard>
        {settings.notices === "blocked" && (
          <SettingsRow label="Notifications are off" description="Turn them on in System Settings to use the options below" error={status.error}>
            <Button variant="soft" size="sm" onClick={() => status.run(() => window.brigadier?.openNotificationSettings())}>
              Open System Settings
            </Button>
          </SettingsRow>
        )}
        {settings.notices === "unasked" && (
          <SettingsRow label="Notifications aren't on yet" description="Allow them to hear when work is done or needs you" error={status.error}>
            <Button variant="soft" size="sm" onClick={() => status.run(() => sendNotice({ title: "Notifications are on", body: "Brigadier will tell you when work is done or needs you." }))}>
              Allow
            </Button>
          </SettingsRow>
        )}
        <SettingsRow className={cx(off && "opacity-disabled")} label={GENERAL_ROWS.notifyFinished.label} description={GENERAL_ROWS.notifyFinished.description} error={finished.error}>
          <Select label={GENERAL_ROWS.notifyFinished.label} value={settings.notify_finished} options={NOTIFY_FINISHED} onChange={(value) => finished.run(() => setSetting("notify_finished", value))} />
        </SettingsRow>
        <SwitchRow dimmed={off} row={GENERAL_ROWS.needsYou} checked={settings.notify_needs_you} save={needs} onChange={(on) => setSetting("notify_needs_you", on)} />
        <SwitchRow dimmed={off} row={GENERAL_ROWS.sound} checked={settings.sound} save={sound} onChange={(on) => setSetting("sound", on)} />
        {/* Always there but when the off line already holds the button: macOS doesn't tell an app it was turned off later [D2086]. */}
        {settings.notices !== "blocked" && (
          <SettingsRow label={GENERAL_ROWS.systemSettings.label} description={GENERAL_ROWS.systemSettings.description} error={status.error}>
            <Button variant="soft" size="sm" onClick={() => status.run(() => window.brigadier?.openNotificationSettings())}>
              Notification settings…
            </Button>
          </SettingsRow>
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function SwitchRow({
  row,
  checked,
  dimmed = false,
  disabled,
  save,
  onChange,
}: {
  row: { label: string; description: string };
  checked: boolean;
  dimmed?: boolean;
  disabled?: boolean;
  save: ReturnType<typeof useSave>;
  onChange: (on: boolean) => Promise<unknown>;
}) {
  return (
    <SettingsRow className={cx(dimmed && "opacity-disabled")} label={row.label} description={row.description} error={save.error}>
      <Switch aria-label={row.label} checked={checked} disabled={disabled} onCheckedChange={(on) => save.run(() => onChange(on))} />
    </SettingsRow>
  );
}

/** Power: Keep awake, the same value as the sidebar's menu [D88, D2016]; the lid switch stays drawn and off until the signed helper [D254, D2022]. */
function PowerSection({ settings }: { settings: Settings }) {
  const save = useSave();
  const lid = useId();
  return (
    <SettingsSection title="Power">
      <SettingsCard>
        <SettingsRow label={GENERAL_ROWS.keepAwake.label} description={GENERAL_ROWS.keepAwake.description} error={save.error}>
          <Select label={GENERAL_ROWS.keepAwake.label} value={settings.awake} options={KEEP_AWAKE} onChange={(value) => save.run(() => setSetting("awake", value))} />
        </SettingsRow>
        {/* shortcut: drawn only, the lid needs the signed helper (D254); wire it when that lands. */}
        <SettingsRow label={<span id={lid}>{GENERAL_ROWS.lidClosed.label}</span>} description={GENERAL_ROWS.lidClosed.description}>
          <Switch aria-labelledby={lid} checked={false} disabled />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
