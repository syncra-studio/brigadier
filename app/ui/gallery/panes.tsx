// Slice 3's layout and shared parts in every state, Current beside Old app (the sidebar once: it listens
// to the whole window). The first copy in each row is live.
import { useId, useState } from "react";

import { Button } from "../src/components/button";
import { CopyButton } from "../src/components/copy-button";
import { EmptyState } from "../src/components/empty-state";
import { ErrorLine } from "../src/components/error-line";
import { TooltipIconButton } from "../src/components/icon-button";
import { LabeledDivider } from "../src/components/labeled-divider";
import { NavFold, NavHeader, NavList, NavRow, NavSection } from "../src/components/nav";
import { ProgressLine } from "../src/components/progress-line";
import { RowAction, RowActionsSlot } from "../src/components/row-action";
import { Section as KitSection } from "../src/components/section";
import { RowText, SettingsCard } from "../src/components/settings-card";
import { SettingsRow } from "../src/components/settings-row";
import { type SidebarCollapse, SidebarPanel, SidebarProvider, useSidebar } from "../src/components/sidebar";
import { StateDot } from "../src/components/state-dot";
import { Switch } from "../src/components/switch";
import { ChevronRight, Copy, Dot, InfoCircle, X } from "../src/icons";
import * as Apple from "./apple/settings";
import { Compare, Row, Section, State } from "./parts";

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
      <TooltipIconButton tooltip="Peek (rest the pointer here)" look="strip" data-sidebar-peek-trigger side="right">
        <Dot />
      </TooltipIconButton>
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

/** A sidebar in a box of its own (`transform-gpu` holds its fixed parts inside), the content beside it. */
function SidebarDemo({ start = true, collapse = "strip", live }: { start?: boolean; collapse?: SidebarCollapse; live?: boolean }) {
  const [open, setOpen] = useState(start);
  const [width, setWidth] = useState<number | null>(null);
  return (
    <div className="relative h-96 w-160 transform-gpu overflow-hidden rounded-surface border border-divider bg-chrome">
      <SidebarProvider
        open={open}
        onOpenChange={live ? setOpen : () => {}}
        width={width}
        onWidthChange={setWidth}
        collapse={collapse}
      >
        <SidebarPanel strip={<Strip />}>
          <SidebarContents />
        </SidebarPanel>
        <div className="flex flex-1 flex-col items-start gap-2 p-4 pt-titlebar text-sm text-muted-foreground">
          {live && <ToggleButton />}
          <span>{live ? "Drag the panel's edge to resize; below half its least width it collapses." : "The content."}</span>
          {width !== null && <span>Width {width}px</span>}
        </div>
      </SidebarProvider>
    </div>
  );
}

function FoldDemo() {
  const [open, setOpen] = useState(true);
  return (
    <div className="w-60">
      <Button size="xs" variant="soft" onClick={() => setOpen(!open)}>
        {open ? "Fold" : "Open"}
      </Button>
      <NavFold open={open}>
        <Rows />
      </NavFold>
    </div>
  );
}

const KIT = { SettingsCard, SettingsRow, RowText };

function SettingsDemo({ error, k = KIT }: { error?: string; k?: typeof KIT | typeof Apple }) {
  const [on, setOn] = useState(true);
  const id = useId();
  return (
    <k.SettingsCard className="w-84">
      <k.SettingsRow label="Open at login" description="Start Brigadier when you log in." htmlFor={id}>
        <Switch id={id} checked={on} onCheckedChange={setOn} />
      </k.SettingsRow>
      <k.SettingsRow label="Daemon port" description="Where the app reaches the daemon." error={error}>
        <Button size="sm" variant="soft">
          Change
        </Button>
      </k.SettingsRow>
      <div className={k === KIT ? "flex items-center gap-3 px-4 py-3" : "flex min-h-10 items-center gap-2.5 px-2.5 py-1.75"}>
        <StateDot tone="ready" />
        <k.RowText title="Local model" line="Ready · 7B · on this Mac" />
        <ChevronRight className="size-icon-sm text-muted-foreground" />
      </div>
    </k.SettingsCard>
  );
}

function SettingsStates({ k = KIT }: { k?: typeof KIT | typeof Apple }) {
  return (
    <>
      <State label="card">
        <SettingsDemo k={k} />
      </State>
      <State label="row error">
        <SettingsDemo k={k} error="Port 7421 is in use." />
      </State>
      <State label="padded">
        <k.SettingsCard padded className="w-72">
          <k.RowText title="Storage" line="2.4 GB of 10 GB" />
          <k.RowText quiet title="Sessions · 1.1 GB" />
        </k.SettingsCard>
      </State>
    </>
  );
}

const STEPS = { title: "Downloading the model", done: 3, total: 8, meta: "until 07:30", description: "Part 4 of 8 · 1.2 GB left" };

export function Panes() {
  return (
    <>
      <Section title="Sidebar (live once: it listens to the whole window)">
        <Row name="live · expanded, strip, hidden">
          <State label="live (strip when collapsed)">
            <SidebarDemo live />
          </State>
          <State label="collapsed to a strip (rest on the dot to peek)">
            <SidebarDemo start={false} />
          </State>
          <State label="hidden (rest on the box's start edge to peek)">
            <SidebarDemo start={false} collapse="hidden" />
          </State>
        </Row>
      </Section>
      <Section title="Nav parts · Row action">
        <Compare name="rows (one current) · hover · focus · a section folding · row actions on hover">
          <State label="live">
            <div className="w-60">
              <Rows />
            </div>
          </State>
          <State label="hover" frozen="hover">
            <div className="w-60">
              <NavRow>
                <Dot />
                Hovered row
              </NavRow>
            </div>
          </State>
          <State label="focus" frozen="focus">
            <div className="w-60">
              <NavRow>
                <Dot />
                Focused row
              </NavRow>
            </div>
          </State>
          <State label="fold (live)">
            <FoldDemo />
          </State>
          <State label="row action · hover · focus">
            <RowAction aria-label="Archive">
              <X />
            </RowAction>
            <span data-frozen="hover">
              <RowAction aria-label="Archive">
                <X />
              </RowAction>
            </span>
            <span data-frozen="focus">
              <RowAction aria-label="Archive">
                <X />
              </RowAction>
            </span>
          </State>
        </Compare>
      </Section>
      <Section title="Error line · Empty state">
        <Compare name="error line · empty state: line, card, centered">
          <State label="error line">
            <ErrorLine error="Couldn't save: the disk is full." />
          </State>
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
        </Compare>
      </Section>
      <Section title="Copy button · Labeled divider · Section · State dot">
        <Compare name="copy (live: click it) · hover · focus · divider · section · dots">
          <State label="live">
            <CopyButton text="brigadier --version" />
          </State>
          <State label="hover" frozen="hover">
            <CopyButton text="brigadier --version" />
          </State>
          <State label="focus" frozen="focus">
            <CopyButton text="brigadier --version" />
          </State>
          <State label="labeled divider">
            <div className="w-72">
              <LabeledDivider>Usage limit reset · 9:39 PM</LabeledDivider>
            </div>
          </State>
          <State label="section">
            <KitSection title="Where it works">
              <span className="text-sm">~/Development/brigadier</span>
            </KitSection>
          </State>
          <State label="ready · needs · off · new reply">
            <StateDot tone="ready" />
            <StateDot tone="needs" />
            <StateDot />
            <StateDot tone="unread" />
          </State>
        </Compare>
      </Section>
      <Section title="Settings card · Settings row · Row text">
        <Compare name="rows split by hairlines · a row with an error · padded" apple={<SettingsStates k={Apple} />}>
          <SettingsStates />
        </Compare>
      </Section>
      <Section title="Progress line">
        <Compare name="running · done · partly done · failed · cancelled">
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
        </Compare>
      </Section>
    </>
  );
}
