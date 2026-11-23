import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { Segmented } from "../components/segmented";
import { Select } from "../components/select";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Switch } from "../components/switch";
import { useDaemon } from "../daemon";
import { errorText } from "../onboarding/api";
import { startTour } from "../onboarding/tour";
import { type Settings, lidHint, loadLid, setLid, setSetting, useLid, useSettings } from "./api";
import { ChatLayoutChoice } from "./chat-layout";
import { sendNotice } from "./notices";
import { SettingsPage, SettingsSection } from "./parts";
import { closeSettings } from "./shell";

/** The General page's rows, for the page and for Settings search (the old app's words). */
export const GENERAL_ROWS = {
  chatLayout: { label: "Chat layout", description: "Centered with your messages in bubbles, or stacked across the panel", section: "Thread" },
  followUp: { label: "Follow-up behaviour", description: "What a message sent while an agent works does", section: "Composer" },
  notifyFinished: { label: "Notify when a session finishes", description: "A notification when a chat or session is done", section: "Notifications" },
  needsYou: { label: "When something needs you", description: "Approvals and questions waiting for your answer", section: "Notifications" },
  sound: { label: "Play a sound", description: "macOS's notification sound with each notification", section: "Notifications" },
  systemSettings: { label: "macOS notifications", description: "Allow, banners and Focus are set in System Settings", section: "Notifications" },
  keepAwake: { label: "Keep the computer awake", description: "Whether this computer may sleep while Brigadier is open", section: "Power" },
  lidClosed: { label: "Keep going with the lid closed", description: "Applied whenever the computer is kept awake", section: "Power" },
  tour: { label: "Take the tour", description: "A short walk through the sidebar, tabs and the rest of the app", section: "Help" },
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

/** What macOS lets notices do, asked again each time the window comes back, as from System Settings [D611]; null where it can't be asked. */
function useNoticeState() {
  const [state, setState] = useState<Notices | null>(null);
  const load = () => window.brigadier?.notificationState().then(setState, (cause: unknown) => console.error(cause));
  useEffect(() => {
    void load();
    window.addEventListener("focus", load);
    return () => window.removeEventListener("focus", load);
  }, []);
  return { state, load };
}

export function GeneralPage() {
  const { value: settings, error } = useSettings();
  const { daemon } = useDaemon();
  const live = useNoticeState();
  return (
    <SettingsPage title="General">
      {!settings ? (
        <SettingsCard>
          <SettingsRow label="Settings" description={error ? undefined : "Loading…"} error={error} />
        </SettingsCard>
      ) : (
        <div className={cx("flex flex-col gap-10", !daemon && "pointer-events-none opacity-disabled")}>
          <ThreadSection settings={settings} />
          <ComposerSection settings={settings} />
          <NotificationsSection settings={settings} notices={live.state ?? settings.notices} reload={live.load} />
          <PowerSection settings={settings} />
        </div>
      )}
      {/* The tour over the app, so Settings closes first [D3109]. */}
      <SettingsSection title="Help">
        <SettingsCard>
          <SettingsRow label={GENERAL_ROWS.tour.label} description={GENERAL_ROWS.tour.description}>
            <Button
              variant="soft"
              size="sm"
              onClick={() => {
                closeSettings();
                // After the app is back in front, so the tour lights its parts.
                requestAnimationFrame(startTour);
              }}
            >
              Start
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
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

/** How the thread is laid out, one choice for both settings, applied at once [D914, D915]. */
export function ThreadSection({ settings }: { settings: Settings }) {
  const save = useSave();
  return (
    <SettingsSection title="Thread">
      <SettingsCard>
        <SettingsRow label={GENERAL_ROWS.chatLayout.label} description={GENERAL_ROWS.chatLayout.description} error={save.error}>
          <ChatLayoutChoice
            label={GENERAL_ROWS.chatLayout.label}
            value={settings.message_layout}
            // Only what differs is sent, so picking the shown tile again mends a mixed pair, as left by an older build or a half-failed save.
            onChange={(mode) => {
              const width = mode === "bubbles" ? "centered" : "full";
              save.run(() =>
                Promise.all([
                  settings.thread_width !== width && setSetting("thread_width", width),
                  settings.message_layout !== mode && setSetting("message_layout", mode),
                ]),
              );
            }}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

function ComposerSection({ settings }: { settings: Settings }) {
  const save = useSave();
  return (
    <SettingsSection title="Composer">
      <SettingsCard>
        <SettingsRow label={GENERAL_ROWS.followUp.label} description={`${GENERAL_ROWS.followUp.description}; ⌘Enter does the other for one message`} error={save.error}>
          <Segmented label={GENERAL_ROWS.followUp.label} value={settings.follow_up} options={FOLLOW_UPS} onChange={(value) => save.run(() => setSetting("follow_up", value))} />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

/** macOS's word on notices, or, where it can't be asked, what it did with the last one [D2024]. */
export type Notices = Settings["notices"] | "hidden";

/**
 * Notifications, the old app's rows [D2022], plus the sound [D2012]. The status line says what macOS allows [D611].
 * The rows stay usable, and look it, whatever it allows: they apply once notices show.
 */
export function NotificationsSection({ settings, notices, reload }: { settings: Settings; notices: Notices; reload: () => unknown }) {
  const status = useSave();
  const finished = useSave();
  const needs = useSave();
  const sound = useSave();
  return (
    <SettingsSection title="Notifications">
      <SettingsCard>
        {notices === "blocked" && (
          <SettingsRow label="Notifications are off" description="Turn them on in System Settings to use the options below" error={status.error}>
            <Button variant="soft" size="sm" onClick={() => status.run(() => window.brigadier?.openNotificationSettings())}>
              Open System Settings
            </Button>
          </SettingsRow>
        )}
        {notices === "hidden" && (
          <SettingsRow label="Notifications are allowed but don't show" description="Turn on Desktop or Notification Center for Brigadier in System Settings" error={status.error}>
            <Button variant="soft" size="sm" onClick={() => status.run(() => window.brigadier?.openNotificationSettings())}>
              Open System Settings
            </Button>
          </SettingsRow>
        )}
        {notices === "unasked" && (
          <SettingsRow label="Notifications aren't on yet" description="Allow them to hear when work is done or needs you" error={status.error}>
            <Button variant="soft" size="sm" onClick={() => status.run(() => sendNotice({ title: "Notifications are on", body: "Brigadier will tell you when work is done or needs you." }).then(reload))}>
              Allow
            </Button>
          </SettingsRow>
        )}
        <SettingsRow label={GENERAL_ROWS.notifyFinished.label} description={GENERAL_ROWS.notifyFinished.description} error={finished.error}>
          <Select label={GENERAL_ROWS.notifyFinished.label} value={settings.notify_finished} options={NOTIFY_FINISHED} onChange={(value) => finished.run(() => setSetting("notify_finished", value))} />
        </SettingsRow>
        <SwitchRow row={GENERAL_ROWS.needsYou} checked={settings.notify_needs_you} save={needs} onChange={(on) => setSetting("notify_needs_you", on)} />
        <SwitchRow row={GENERAL_ROWS.sound} checked={settings.sound} save={sound} onChange={(on) => setSetting("sound", on)} />
        {/* Always there but when the status line already holds the button [D2086]. */}
        {notices !== "blocked" && notices !== "hidden" && (
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

export function SwitchRow({
  row,
  checked,
  disabled,
  save,
  onChange,
}: {
  row: { label: string; description: string };
  checked: boolean;
  disabled?: boolean;
  save: ReturnType<typeof useSave>;
  onChange: (on: boolean) => Promise<unknown>;
}) {
  return (
    <SettingsRow label={row.label} description={row.description} error={save.error}>
      <Switch aria-label={row.label} checked={checked} disabled={disabled} onCheckedChange={(on) => save.run(() => onChange(on))} />
    </SettingsRow>
  );
}

/** Power: Keep awake, the same value as the sidebar's menu [D88, D2016], and with the lid closed too, as the old app [D333]. */
function PowerSection({ settings }: { settings: Settings }) {
  const save = useSave();
  const lidSave = useSave();
  const lid = useLid();
  useEffect(loadLid, []);
  return (
    <SettingsSection title="Power">
      <SettingsCard>
        <SettingsRow label={GENERAL_ROWS.keepAwake.label} description={GENERAL_ROWS.keepAwake.description} error={save.error}>
          <Select label={GENERAL_ROWS.keepAwake.label} value={settings.awake} options={KEEP_AWAKE} onChange={(value) => save.run(() => setSetting("awake", value))} />
        </SettingsRow>
        <SettingsRow label={GENERAL_ROWS.lidClosed.label} description={lidHint(settings, lid)} error={lidSave.error}>
          <Switch
            aria-label={GENERAL_ROWS.lidClosed.label}
            checked={settings.awake_lid}
            disabled={lid.settingUp}
            onCheckedChange={(on) => lidSave.run(() => setLid(on))}
          />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}
