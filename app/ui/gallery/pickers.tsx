// The composer's pickers (slice 3): the model and permission pills, their popups held open, the Full access confirm, plus live copies.
import { useState } from "react";

import { FullAccessDialog, SwitchAgentDialog, type ModelChoice, type ModelGroup, ModelPicker, type PermissionLevel, PermissionPicker } from "../src/components/composer/pickers";
import { Held, Row, Section, State } from "./parts";

const noop = () => {};

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
];

const LARGE: ModelChoice = { provider: "cloud", model: "large", effort: "high" };

export function PickersGallery() {
  return (
    <Section title="Composer pickers">
      <Row name="Model pill">
        <State label="With a mark and effort">
          <ModelPicker groups={GROUPS} value={LARGE} onChange={noop} />
        </State>
        <State label="Hover" frozen="hover">
          <ModelPicker groups={GROUPS} value={LARGE} onChange={noop} />
        </State>
        <State label="No mark, no effort">
          <ModelPicker groups={GROUPS} value={{ provider: "local", model: "llama", effort: null }} onChange={noop} />
        </State>
        <State label="Disabled">
          <ModelPicker groups={GROUPS} value={LARGE} onChange={noop} disabled />
        </State>
      </Row>
      <Row name="Model picker">
        <State label="Open: agents, models, effort">
          <Held className="flex h-100 w-140 items-end justify-end">{(box) => <ModelPicker groups={GROUPS} value={LARGE} onChange={noop} held={box} />}</Held>
        </State>
        <State label="A model without effort levels: no footer">
          <Held className="flex h-100 w-140 items-end justify-end">
            {(box) => <ModelPicker groups={GROUPS} value={{ provider: "cloud", model: "mini", effort: null }} onChange={noop} held={box} />}
          </Held>
        </State>
      </Row>
      <Row name="Switch to another agent">
        <State label="Picked another agent's model">
          <Held className="h-56 w-88 overflow-hidden rounded-surface">{(box) => <SwitchAgentDialog to="Other agent" onCancel={noop} onConfirm={noop} held={box} />}</Held>
        </State>
      </Row>
      <Row name="Permission pill">
        <State label="Ask">
          <PermissionPicker value="ask" onChange={noop} />
        </State>
        <State label="Accept edits">
          <PermissionPicker value="acceptEdits" onChange={noop} />
        </State>
        <State label="Full access">
          <PermissionPicker value="full" onChange={noop} />
        </State>
        <State label="Hover" frozen="hover">
          <PermissionPicker value="acceptEdits" onChange={noop} />
        </State>
      </Row>
      <Row name="Permission menu">
        <State label="Open">
          <Held className="flex h-60 w-130 items-end">{(box) => <PermissionPicker value="acceptEdits" onChange={noop} held={box} />}</Held>
        </State>
        <State label="An agent with two levels">
          <Held className="flex h-60 w-130 items-end">{(box) => <PermissionPicker value="ask" levels={["ask", "full"]} onChange={noop} held={box} />}</Held>
        </State>
        <State label="An untrusted folder: Ask only">
          <Held className="flex h-68 w-130 items-end">{(box) => <PermissionPicker value="full" onChange={noop} untrusted held={box} />}</Held>
        </State>
      </Row>
      <Row name="Full access confirm">
        <State label="Open">
          <Held className="h-140 w-104 overflow-hidden rounded-surface">
            {(box) => <FullAccessDialog open onCancel={noop} onConfirm={noop} held={box} />}
          </Held>
        </State>
      </Row>
      <Row name="Live">
        <Live />
      </Row>
    </Section>
  );
}

/** Pick a model and effort (another agent's asks first); Full access asks first. */
function Live() {
  const [model, setModel] = useState(LARGE);
  const [permission, setPermission] = useState<PermissionLevel>("ask");
  return (
    <State label="Live">
      <ModelPicker groups={GROUPS} value={model} onChange={setModel} />
      <PermissionPicker value={permission} onChange={setPermission} />
    </State>
  );
}
