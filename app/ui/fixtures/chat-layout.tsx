// Mockup only: Settings › General's "Chat layout" row on fake settings. ?v=a is variant A; ?v=real is the real
// Thread section, whose picks need the app's daemon to save. Not the app.
import "../src/theme.css";
import "./fixtures.css";
// Settings' pages before General, as the app loads them: General and the pages list import each other.
import "../src/settings/pages";

import { useState } from "react";
import { createRoot } from "react-dom/client";

import { type ChatLayout, ChatLayoutChoice } from "../src/settings/chat-layout";
import { SettingsCard } from "../src/components/settings-card";
import { SettingsRow } from "../src/components/settings-row";
import type { Settings } from "../src/settings/api";
import { ThreadSection } from "../src/settings/general";
import { SettingsPage, SettingsSection } from "../src/settings/parts";

const FAKE: Settings = {
  follow_up: "queue",
  default_level: "ask",
  notify_finished: "background",
  notify_needs_you: true,
  sound: true,
  notices: "sent",
  awake: "off",
  awake_lid: false,
  workers: "3",
  memory: false,
  web_links_in: "brigadier",
  local_links_in: "brigadier",
  computer_cursor: true,
  thread_width: "centered",
  message_layout: "bubbles",
  models_starred: [],
};

function VariantA() {
  const [mode, setMode] = useState<ChatLayout>("bubbles");
  return (
    <SettingsSection title="Thread">
      <SettingsCard>
        <SettingsRow label="Chat layout" description="Centered with your messages in bubbles, or stacked across the panel">
          <ChatLayoutChoice label="Chat layout" value={mode} onChange={setMode} />
        </SettingsRow>
      </SettingsCard>
    </SettingsSection>
  );
}

const real = new URLSearchParams(location.search).get("v") === "real";
createRoot(document.getElementById("root")!).render(<SettingsPage title="General">{real ? <ThreadSection settings={FAKE} /> : <VariantA />}</SettingsPage>);
