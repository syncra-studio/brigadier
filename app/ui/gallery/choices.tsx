// Slice 3's controls in every state. The first copy in each row is live.
import { useState } from "react";

import { CheckboxRow } from "../src/components/checkbox-row";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../src/components/collapsible";
import { Radio, RadioGroup } from "../src/components/radio";
import { ScrollFade } from "../src/components/scroll-fade";
import { type Choice, Segmented } from "../src/components/segmented";
import { Skeleton } from "../src/components/skeleton";
import { ChevronDown, Copy, InfoCircle, Warning } from "../src/icons";
import { Row, Section, State } from "./parts";

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


export function Choices() {
  return (
    <>
      <Section title="Segmented">
        <Row name="pills · on a track (fill) · icons with tips · a choice with a reason · disabled">
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
        </Row>
      </Section>
      <Section title="Radio · Checkbox row">
        <Row name="radio · checkbox row">
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
        </Row>
      </Section>
      <Section title="Collapsible · Skeleton · Scroll fade">
        <Row name="collapsible · skeleton · scroll fade (top, bottom raised)">
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
            <div className="relative h-56 w-56 overflow-hidden rounded-surface border border-divider">
              <ScrollFade edge="top" />
              <div className="h-full overflow-y-auto px-3 py-5 text-sm text-muted-foreground">
                {Array.from({ length: 14 }, (_, i) => (
                  <p key={i}>Line {i + 1} of the thread</p>
                ))}
              </div>
              <ScrollFade edge="bottom" raised />
            </div>
          </State>
        </Row>
      </Section>
    </>
  );
}
