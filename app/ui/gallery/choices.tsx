// Slice 3's controls in every state, Current beside Old app. The first copy in each row is live.
import { useState } from "react";

import { CheckboxRow } from "../src/components/checkbox-row";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../src/components/collapsible";
import { Radio, RadioGroup } from "../src/components/radio";
import { ScrollFade } from "../src/components/scroll-fade";
import { type Choice, Segmented } from "../src/components/segmented";
import { Skeleton } from "../src/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../src/components/tabs";
import { Toggle, ToggleGroup, ToggleGroupItem } from "../src/components/toggle";
import { ChevronDown, Copy, InfoCircle, Warning } from "../src/icons";
import { Compare, Section, State } from "./parts";

function TabsDemo({ disabled }: { disabled?: boolean }) {
  return (
    <Tabs defaultValue="events" className="w-72">
      <TabsList>
        <TabsTrigger value="events">Events</TabsTrigger>
        <TabsTrigger value="brain">Brain</TabsTrigger>
        <TabsTrigger value="providers" disabled={disabled}>
          Providers
        </TabsTrigger>
      </TabsList>
      <TabsContent value="events" className="text-sm text-muted-foreground">
        Events panel
      </TabsContent>
      <TabsContent value="brain" className="text-sm text-muted-foreground">
        Brain panel
      </TabsContent>
      <TabsContent value="providers" className="text-sm text-muted-foreground">
        Providers panel
      </TabsContent>
    </Tabs>
  );
}

const RANGES: Choice<string>[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "all", label: "All time" },
];
const WITH_REASON: Choice<string>[] = [...RANGES.slice(0, 2), { value: "all", label: "All time", reason: "Needs a newer daemon" }];
const ICONS: Choice<string>[] = [
  { value: "info", label: <InfoCircle />, tip: "Details" },
  { value: "warn", label: <Warning />, tip: "Warnings" },
];

function SegmentedDemo({ options = RANGES, fill, disabled }: { options?: Choice<string>[]; fill?: boolean; disabled?: boolean }) {
  const [value, setValue] = useState(options[0]!.value);
  return (
    <div className={fill ? "w-64" : undefined}>
      <Segmented label="Time range" value={value} options={options} onChange={setValue} fill={fill} disabled={disabled} />
    </div>
  );
}

function RadioDemo({ disabled }: { disabled?: boolean }) {
  return (
    <RadioGroup defaultValue="inbox" disabled={disabled} className="flex flex-col gap-2">
      {["inbox", "projects"].map((value) => (
        <label key={value} className="flex items-center gap-2 text-sm">
          <Radio value={value} />
          {value === "inbox" ? "One list" : "By project"}
        </label>
      ))}
    </RadioGroup>
  );
}

function CheckboxRowDemo({ note, disabled }: { note?: string; disabled?: boolean }) {
  const [checked, setChecked] = useState(true);
  return (
    <div className="w-64">
      <CheckboxRow label="Show chats" note={note} checked={checked} disabled={disabled} onCheckedChange={setChecked} />
    </div>
  );
}

function CollapsibleDemo({ open }: { open?: boolean }) {
  return (
    <Collapsible defaultOpen={open} className="w-64">
      <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-sm focus-visible:focus-ring">
        Ran 3 commands
        <ChevronDown className="size-icon-sm transition-all group-data-panel-open:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="flex flex-col gap-1 pt-2 text-sm text-muted-foreground">
          <li>pnpm install</li>
          <li>pnpm typecheck</li>
          <li>scripts/limits</li>
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TogglesRow({ variant }: { variant: "default" | "outline" }) {
  return (
    <>
      <State label="live">
        <Toggle variant={variant} aria-label="Match case">
          <Copy />
        </Toggle>
      </State>
      <State label="hover" frozen="hover">
        <Toggle variant={variant} aria-label="Match case">
          <Copy />
        </Toggle>
      </State>
      <State label="focus" frozen="focus">
        <Toggle variant={variant} aria-label="Match case">
          <Copy />
        </Toggle>
      </State>
      <State label="pressed">
        <Toggle variant={variant} defaultPressed aria-label="Match case">
          <Copy />
        </Toggle>
      </State>
      <State label="disabled">
        <Toggle variant={variant} disabled aria-label="Match case">
          <Copy />
        </Toggle>
      </State>
      <State label="sm · lg · with words">
        <Toggle variant={variant} size="sm" aria-label="Match case">
          <Copy />
        </Toggle>
        <Toggle variant={variant} size="lg" aria-label="Match case">
          <Copy />
        </Toggle>
        <Toggle variant={variant}>Bold</Toggle>
      </State>
    </>
  );
}

function GroupDemo({ spacing, variant, multiple }: { spacing: "none" | "tight" | "loose"; variant?: "outline"; multiple?: boolean }) {
  return (
    <ToggleGroup spacing={spacing} variant={variant} multiple={multiple} defaultValue={["left"]}>
      {["left", "center", "right"].map((value) => (
        <ToggleGroupItem key={value} value={value}>
          {value}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

export function Choices() {
  return (
    <>
      <Section title="Tabs">
        <Compare name="live · hover · focus · with a disabled tab">
          <State label="live">
            <TabsDemo />
          </State>
          <State label="hover" frozen="hover">
            <TabsDemo />
          </State>
          <State label="focus" frozen="focus">
            <TabsDemo />
          </State>
          <State label="disabled tab">
            <TabsDemo disabled />
          </State>
        </Compare>
      </Section>
      <Section title="Segmented">
        <Compare name="pills · on a track (fill) · icons with tips · a choice with a reason · disabled">
          <State label="live">
            <SegmentedDemo />
          </State>
          <State label="hover" frozen="hover">
            <SegmentedDemo />
          </State>
          <State label="focus" frozen="focus">
            <SegmentedDemo />
          </State>
          <State label="fill">
            <SegmentedDemo fill />
          </State>
          <State label="icons, tips">
            <SegmentedDemo options={ICONS} />
          </State>
          <State label="reason (hover All time)">
            <SegmentedDemo options={WITH_REASON} />
          </State>
          <State label="disabled">
            <SegmentedDemo disabled />
          </State>
        </Compare>
      </Section>
      <Section title="Toggle · Toggle group (unused in the old app, D58)">
        <Compare name="toggle · default">
          <TogglesRow variant="default" />
        </Compare>
        <Compare name="toggle · outline">
          <TogglesRow variant="outline" />
        </Compare>
        <Compare name="toggle group · joined outline · tight · loose · several pressed">
          <State label="joined, outline">
            <GroupDemo spacing="none" variant="outline" />
          </State>
          <State label="tight">
            <GroupDemo spacing="tight" />
          </State>
          <State label="loose, multiple">
            <GroupDemo spacing="loose" multiple />
          </State>
        </Compare>
      </Section>
      <Section title="Radio · Checkbox row">
        <Compare name="radio · checkbox row">
          <State label="live">
            <RadioDemo />
          </State>
          <State label="focus" frozen="focus">
            <RadioDemo />
          </State>
          <State label="disabled">
            <RadioDemo disabled />
          </State>
          <State label="checkbox row">
            <CheckboxRowDemo />
          </State>
          <State label="with a note, disabled">
            <CheckboxRowDemo disabled note="Turn on Projects in Settings first." />
          </State>
        </Compare>
      </Section>
      <Section title="Collapsible · Skeleton · Scroll fade">
        <Compare name="collapsible · skeleton · scroll fade (top, bottom raised)">
          <State label="closed (live)">
            <CollapsibleDemo />
          </State>
          <State label="open">
            <CollapsibleDemo open />
          </State>
          <State label="skeleton">
            <div className="flex w-56 flex-col gap-2">
              <Skeleton className="h-4 w-4/5" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          </State>
          <State label="scroll fade">
            <div className="relative h-40 w-56 overflow-hidden rounded-surface border border-divider">
              <ScrollFade edge="top" />
              <div className="h-full overflow-y-auto px-3 py-5 text-sm text-muted-foreground">
                {Array.from({ length: 14 }, (_, i) => (
                  <p key={i}>Line {i + 1} of the thread</p>
                ))}
              </div>
              <ScrollFade edge="bottom" raised />
            </div>
          </State>
        </Compare>
      </Section>
    </>
  );
}
