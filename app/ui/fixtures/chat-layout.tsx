// Mockup only: Settings › General's "Chat layout" row on fake settings. ?v=a is variant A; ?v=real is the real
// General page, saving to a fake daemon that keeps its settings in memory. Not the app.
import "../src/theme.css";
import "./fixtures.css";
// Settings' pages before General, as the app loads them: General and the pages list import each other.
import "../src/settings/pages";

import { useState } from "react";
import { createRoot } from "react-dom/client";

import { type ChatLayout, ChatLayoutChoice } from "../src/settings/chat-layout";
import { SettingsCard } from "../src/components/settings-card";
import { SettingsRow } from "../src/components/settings-row";
import { connected } from "../src/daemon";
import { type Settings, loadSettings } from "../src/settings/api";
import { GeneralPage } from "../src/settings/general";
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

/** What main hands the page in the app: a port to the daemon, here one that answers `settings` and the lid from memory. */
function fakeDaemon() {
  const { port1, port2 } = new MessageChannel();
  const state: Record<string, unknown> = { ...FAKE };
  const say = (frame: object) => {
    const json = new TextEncoder().encode(JSON.stringify(frame));
    const out = new Uint8Array(4 + json.length);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    port2.postMessage(out);
  };
  port2.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
    const { id, op, args = [] } = JSON.parse(new TextDecoder().decode(data.subarray(4)));
    if (op !== "run") return;
    const [command, key, value] = args as string[];
    if (command === "settings" && key === "chat-layout") Object.assign(state, { thread_width: value === "bubbles" ? "centered" : "full", message_layout: value });
    else if (command === "settings" && key) state[key] = value === "true" ? true : value === "false" ? false : value;
    if (command === "settings") say({ re: id, ok: true, ...state });
    else if (command === "awake") say({ re: id, ok: true, lid: "ready" });
    else say({ re: id, ok: false, message: "Not in this mockup" });
  };
  window.postMessage("daemon-port", "*", [port1]);
  say({ status: "running", pid: 1, version: "mockup", build: 0 });
  void connected().then(loadSettings);
}

const real = new URLSearchParams(location.search).get("v") === "real";
if (real) fakeDaemon();
createRoot(document.getElementById("root")!).render(
  real ? (
    <GeneralPage />
  ) : (
    <SettingsPage title="General">
      <VariantA />
    </SettingsPage>
  ),
);
