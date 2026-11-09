// The composer's pickers (slice 3): the model and permission pickers, one live copy each.
import { useState } from "react";

import { type ModelChoice, type ModelGroup, ModelPicker } from "../src/components/composer/model-picker";
import { type PermissionLevel, PermissionPicker } from "../src/components/composer/pickers";
import { Section } from "./parts";

// Stand-in marks: no agent's real logo in gallery code (onboarding takes them from the adapters).
const RING = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="5.5"/></svg>';
const DIAMOND = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/></svg>';

const GROUPS: ModelGroup[] = [
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
      </Section>
      <Section title="Permission picker">
        <div className="self-start">
          <PermissionPicker value={permission} onChange={setPermission} />
        </div>
      </Section>
    </>
  );
}
