// Slice 3's layout and shared parts live: the sidebar frame, and each part's variants side by side.
import { useId, useState } from "react";

import { Button } from "../src/components/button";
import { CopyButton } from "../src/components/copy-button";
import { EmptyState } from "../src/components/empty-state";
import { ErrorLine } from "../src/components/error-line";
import { TooltipIconButton } from "../src/components/icon-button";
import { LabeledDivider } from "../src/components/labeled-divider";
import { NavHeader, NavList, NavRow, NavSection } from "../src/components/nav";
import { ProgressLine } from "../src/components/progress-line";
import { RowAction, RowActionsSlot } from "../src/components/row-action";
import { Section as KitSection } from "../src/components/section";
import { RowText, SettingsCard } from "../src/components/settings-card";
import { SettingsRow } from "../src/components/settings-row";
import { type SidebarCollapse, SidebarPanel, SidebarProvider, useSidebar } from "../src/components/sidebar";
import { StateDot } from "../src/components/state-dot";
import { Switch } from "../src/components/switch";
import { ChevronRight, Copy, Dot, InfoCircle, X } from "../src/icons";
import { Row, Section, State } from "./parts";

function Rows({ current = "a" }: { current?: string }) {
  return (
    <NavList>
      {[
        ["a", "Fix the login redirect"],
        ["b", "Write the release notes"],
        ["c", "Sort the inbox"],
      ].map(([id, title]) => (
        <li key={id} className="group/row relative">
          <NavRow aria-current={id === current ? "page" : undefined}>
            <Dot />
            <span className="truncate">{title}</span>
          </NavRow>
          <RowActionsSlot>
            <RowAction aria-label="Archive">
              <X />
            </RowAction>
          </RowActionsSlot>
        </li>
      ))}
    </NavList>
  );
}

function SidebarContents() {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-3 px-2">
      <NavHeader
        title="Brigadier"
        actions={
          <TooltipIconButton tooltip="New session" look="toolbar">
            <Copy />
          </TooltipIconButton>
        }
      />
      <NavSection title="Sessions" open={open} onOpenChange={setOpen} actions={<RowAction aria-label="Sort"><InfoCircle /></RowAction>}>
        <Rows />
      </NavSection>
      <NavSection title="Pinned">
        <Rows current="" />
      </NavSection>
    </div>
  );
}

function Strip() {
  return (
    <div className="flex flex-col items-center gap-1 pt-3">
      <TooltipIconButton tooltip="New session" look="strip" side="right">
        <Copy />
      </TooltipIconButton>
    </div>
  );
}

/** The sidebar's own toggle: in a narrow window it opens the panel only for now, not the remembered choice. */
function ToggleButton() {
  const { toggleSidebar } = useSidebar();
  return (
    <Button size="sm" variant="soft" onClick={toggleSidebar}>
      Toggle (or ⌘B)
    </Button>
  );
}

/** The kit's sidebar frame in a box of its own (`transform-gpu` holds its fixed parts inside), the content beside it. */
function SidebarDemo() {
  const [open, setOpen] = useState(true);
  const [width, setWidth] = useState<number | null>(null);
  const [collapse, setCollapse] = useState<SidebarCollapse>("strip");
  return (
    <div className="relative h-140 w-full transform-gpu overflow-hidden rounded-surface border border-divider bg-chrome">
      <SidebarProvider open={open} onOpenChange={setOpen} width={width} onWidthChange={setWidth} collapse={collapse} onCollapseChange={setCollapse}>
        <SidebarPanel strip={<Strip />}>
          <SidebarContents />
        </SidebarPanel>
        <div className="flex flex-1 flex-col items-start gap-2 p-4 pt-titlebar text-sm text-muted-foreground">
          <ToggleButton />
          <span>Drag the panel's edge to resize; below half its least width it collapses.</span>
          <span>The frame only: its rows are samples.</span>
          {width !== null && <span>Width {width}px</span>}
        </div>
      </SidebarProvider>
    </div>
  );
}

function SettingsDemo({ error }: { error?: string }) {
  const [on, setOn] = useState(true);
  const id = useId();
  return (
    <SettingsCard className="w-120">
      <SettingsRow label="Open at login" description="Start Brigadier when you log in." htmlFor={id}>
        <Switch id={id} checked={on} onCheckedChange={setOn} />
      </SettingsRow>
      <SettingsRow label="Daemon port" description="Where the app reaches the daemon." error={error}>
        <Button size="sm" variant="soft">
          Change
        </Button>
      </SettingsRow>
      <div className="flex items-center gap-3 px-4 py-3">
        <StateDot tone="ready" />
        <RowText title="Local model" line="Ready · 7B · on this Mac" />
        <ChevronRight className="size-icon-sm text-muted-foreground" />
      </div>
    </SettingsCard>
  );
}

const STEPS = { title: "Downloading the model", done: 3, total: 8, meta: "until 07:30", description: "Part 4 of 8 · 1.2 GB left" };

export function Panes() {
  return (
    <>
      <Section title="Sidebar frame and nav rows">
        <SidebarDemo />
      </Section>
      <Section title="Error line">
        <Row>
          <State label="default">
            <ErrorLine error="Couldn't save: the disk is full." />
          </State>
          <State label="sm">
            <ErrorLine size="sm" error="The run failed · the provider closed the stream." />
          </State>
        </Row>
      </Section>
      <Section title="Empty state">
        <Row>
          <State label="line">
            <div className="w-60">
              <EmptyState title="No sessions yet" />
            </div>
          </State>
          <State label="card">
            <SettingsCard className="w-72">
              <EmptyState variant="card" icon={InfoCircle} title="No models added" />
            </SettingsCard>
          </State>
          <State label="centered">
            <div className="w-72">
              <EmptyState variant="centered" icon={InfoCircle} title="Nothing here" detail="Sessions you start show here." />
            </div>
          </State>
        </Row>
      </Section>
      <Section title="Copy button">
        <div className="self-start">
          <CopyButton text="brigadier --version" />
        </div>
      </Section>
      <Section title="Labeled divider">
        <div className="w-72">
          <LabeledDivider>Usage limit reset · 9:39 PM</LabeledDivider>
        </div>
      </Section>
      <Section title="Settings section">
        <KitSection title="Where it works">
          <span className="text-sm">~/Development/brigadier</span>
        </KitSection>
      </Section>
      <Section title="State dot">
        <Row>
          <State label="ready · needs · off · new reply">
            <StateDot tone="ready" />
            <StateDot tone="needs" />
            <StateDot />
            <StateDot tone="unread" />
          </State>
        </Row>
      </Section>
      <Section title="Settings card · Settings row · Row text">
        <Row>
          <State label="card">
            <SettingsDemo />
          </State>
          <State label="row error">
            <SettingsDemo error="Port 7421 is in use." />
          </State>
          <State label="padded">
            <SettingsCard padded className="w-72">
              <RowText title="Storage" line="2.4 GB of 10 GB" />
              <RowText quiet title="Sessions · 1.1 GB" />
            </SettingsCard>
          </State>
        </Row>
      </Section>
      <Section title="Progress line">
        <Row>
          <State label="running">
            <div className="w-72">
              <ProgressLine {...STEPS} />
            </div>
          </State>
          <State label="success">
            <div className="w-72">
              <ProgressLine {...STEPS} meta="4 min" description={undefined} outcome={{ status: "success", summary: "Model ready." }} />
            </div>
          </State>
          <State label="partial">
            <div className="w-72">
              <ProgressLine {...STEPS} outcome={{ status: "partial", summary: "6 of 8 parts saved." }} />
            </div>
          </State>
          <State label="failed">
            <div className="w-72">
              <ProgressLine {...STEPS} outcome={{ status: "failed", summary: "The connection dropped." }} />
            </div>
          </State>
          <State label="cancelled">
            <div className="w-72">
              <ProgressLine {...STEPS} outcome={{ status: "cancelled" }} />
            </div>
          </State>
        </Row>
      </Section>
    </>
  );
}
