// Mockup only: Settings › General's one "Chat layout" row, three ways (?v=a|b|c), on fake settings. Not the app.
import "../src/theme.css";
import "./fixtures.css";

import { useState } from "react";
import { createRoot } from "react-dom/client";

import { cx } from "../src/components/cx";
import { Segment, SegmentedRoot, Segmented } from "../src/components/segmented";
import { SettingsCard } from "../src/components/settings-card";
import { SettingsRow } from "../src/components/settings-row";
import { SettingsPage, SettingsSection } from "../src/settings/parts";

type Mode = "bubbles" | "stacked";

/** A tiny thread: centered with your message as a bubble on the right, or across the panel with it as a full-width block. */
function Picture({ mode, size }: { mode: Mode; size: "sm" | "md" }) {
  const stacked = mode === "stacked";
  return (
    <div className={cx("flex flex-col rounded-md border border-divider bg-background p-1", size === "sm" ? "h-14 w-24" : "h-16 w-28")}>
      <div className={cx("flex flex-1 flex-col justify-end gap-1 py-0.5", stacked ? "px-0.5" : "mx-auto w-3/5")}>
        <div className={cx("h-1.5 rounded-full bg-foreground/30", stacked ? "w-full rounded-xs" : "ml-auto w-3/5")} />
        <div className="h-0.5 w-full rounded-full bg-foreground/45" />
        <div className="h-0.5 w-4/5 rounded-full bg-foreground/45" />
        <div className="h-0.5 w-11/12 rounded-full bg-foreground/45" />
      </div>
      <div className={cx("mt-1 h-2 rounded-full bg-foreground/15", stacked ? "w-full" : "mx-auto w-3/5")} />
    </div>
  );
}

/** The two modes as pictures to pick from, the old app's Sidebar row. */
function Tiles({ value, onChange, size, words }: { value: Mode; onChange: (mode: Mode) => void; size: "sm" | "md"; words: Record<Mode, { label: string; hint?: string }> }) {
  return (
    <SegmentedRoot aria-label="Chat layout" value={[value]} onValueChange={([next]) => next && onChange(next as Mode)} className="flex gap-3">
      {(["bubbles", "stacked"] as const).map((mode) => (
        <Segment
          key={mode}
          value={mode}
          className={cx(
            "flex flex-col items-center gap-1.5 rounded-lg p-1 text-xs text-foreground/60 transition-colors outline-none hover:text-foreground data-[pressed]:text-foreground",
            "[&>div:first-child]:transition-shadow data-[pressed]:[&>div:first-child]:ring-2 data-[pressed]:[&>div:first-child]:ring-ring focus-visible:[&>div:first-child]:ring-2 focus-visible:[&>div:first-child]:ring-ring/50",
          )}
        >
          <Picture mode={mode} size={size} />
          <span className="font-medium">{words[mode].label}</span>
          {words[mode].hint && <span className="-mt-1 text-quiet-foreground">{words[mode].hint}</span>}
        </Segment>
      ))}
    </SegmentedRoot>
  );
}

const C_LINES: Record<Mode, string> = {
  bubbles: "Centered, your messages in bubbles on the right",
  stacked: "Across the panel, everything in one column",
};

function ChatLayoutRow({ variant }: { variant: string }) {
  const [mode, setMode] = useState<Mode>("bubbles");
  if (variant === "b")
    return (
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-col gap-0.5">
          <div className="text-label font-medium">Chat layout</div>
          <div className="text-xs text-quiet-foreground">How the conversation sits in the panel</div>
        </div>
        <Tiles
          value={mode}
          onChange={setMode}
          size="md"
          words={{ bubbles: { label: "Chat", hint: "Centered, bubbles" }, stacked: { label: "Document", hint: "Full width, stacked" } }}
        />
      </div>
    );
  if (variant === "c")
    return (
      <SettingsRow label="Chat layout" description={C_LINES[mode]}>
        <Tiles value={mode} onChange={setMode} size="sm" words={{ bubbles: { label: "Centered" }, stacked: { label: "Full width" } }} />
      </SettingsRow>
    );
  return (
    <SettingsRow label="Chat layout" description="Centered with your messages in bubbles, or stacked across the panel">
      <Tiles value={mode} onChange={setMode} size="sm" words={{ bubbles: { label: "Bubbles" }, stacked: { label: "Stacked" } }} />
    </SettingsRow>
  );
}

function Page() {
  const variant = new URLSearchParams(location.search).get("v") ?? "a";
  const [followUp, setFollowUp] = useState<"queue" | "steer">("queue");
  return (
    <SettingsPage title="General">
      <SettingsSection title="Thread">
        <SettingsCard>
          <ChatLayoutRow variant={variant} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Composer">
        <SettingsCard>
          <SettingsRow label="Follow-up behaviour" description="What a message sent while an agent works does; ⌘Enter does the other for one message">
            <Segmented
              label="Follow-up behaviour"
              value={followUp}
              options={[
                { value: "queue", label: "Queue" },
                { value: "steer", label: "Steer" },
              ]}
              onChange={setFollowUp}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
