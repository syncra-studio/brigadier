// The composer's pickers (slice 3): the model and permission pickers, one live copy each.
import { useState } from "react";

import { type ModelChoice, type ModelGroup, ModelPicker } from "../src/components/composer/model-picker";
import { type PermissionLevel, PermissionPicker } from "../src/components/composer/pickers";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../src/components/dialog";
import { AgentCard } from "../src/onboarding/agents";
import type { Agent } from "../src/onboarding/api";
import { Held, Row, Section, State } from "./parts";

// Stand-in marks: no agent's real logo in gallery code (onboarding takes them from the adapters).
const RING = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="5.5"/></svg>';
const DIAMOND = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/></svg>';

export const GROUPS: ModelGroup[] = [
  {
    provider: "cloud",
    label: "Cloud agent",
    mark: RING,
    models: [
      { id: "large", name: "Large model", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      { id: "fast", name: "Fast model", efforts: ["low", "medium", "high"], defaultEffort: "low" },
      { id: "mini", name: "Mini model with a long name that truncates", efforts: [] },
    ],
  },
  { provider: "other", label: "Other agent", mark: DIAMOND, models: [{ id: "big", name: "Big model", efforts: ["low", "high", "max"], defaultEffort: "high" }] },
  { provider: "local", label: "Local models", mark: null, models: [{ id: "llama", name: "Local 8B", efforts: [] }] },
  { provider: "new", label: "New agent", mark: null, models: [] },
  { provider: "absent", label: "Absent agent", mark: DIAMOND, models: [], unavailable: "install" },
  { provider: "away", label: "Signed-out agent", mark: RING, models: [], unavailable: "sign-in" },
];

const AWAY: Agent = { name: "away", label: "Agent", install: true, sign_in: "Sign in", mark: RING, setup: null, path: "/usr/local/bin/away", signed_in: false };
const SIGN_IN = { id: "setup-away", action: "sign-in", running: true, code: null, signal: null } as const;
const SET_UP: [string, Agent][] = [
  ["sign in", AWAY],
  ["browser", { ...AWAY, setup: { ...SIGN_IN, code_page: null } }],
  ["device code", { ...AWAY, setup: { ...SIGN_IN, code_page: "https://example.com/device", device_code: "ABCD-12345" } }],
  ["code page", { ...AWAY, setup: { ...SIGN_IN, code_page: "https://example.com/code" } }],
];

/** The model picker's Set up dialog, as `SetUpAgentDialog` draws it, held open. */
function SetUp({ agent }: { agent: Agent }) {
  return (
    <Held className="h-80 w-128 overflow-hidden rounded-surface">
      {(box) => (
        <Dialog open modal={false}>
          <DialogContent container={box} initialFocus={false}>
            <DialogHeader>
              <DialogTitle>Set up {agent.label}</DialogTitle>
            </DialogHeader>
            <ul className="flex min-w-0 flex-col">
              <AgentCard agent={agent} online starting={false} retrying={false} failed={undefined} onAction={() => {}} onCancel={() => {}} onRetry={() => {}} />
            </ul>
          </DialogContent>
        </Dialog>
      )}
    </Held>
  );
}

const LARGE: ModelChoice = { provider: "cloud", model: "large", effort: "high" };

export function PickersGallery() {
  const [model, setModel] = useState(LARGE);
  const [permission, setPermission] = useState<PermissionLevel>("ask");
  return (
    <>
      <Section title="Model picker">
        <div className="self-start">
          <ModelPicker groups={GROUPS} value={model} onChange={setModel} />
        </div>
        <Row name="Set up: sign in · in the browser · device code · code page">
          {SET_UP.map(([label, agent]) => (
            <State key={label} label={label}>
              <SetUp agent={agent} />
            </State>
          ))}
        </Row>
      </Section>
      <Section title="Permission picker">
        <div className="self-start">
          <PermissionPicker value={permission} onChange={setPermission} />
        </div>
      </Section>
    </>
  );
}
