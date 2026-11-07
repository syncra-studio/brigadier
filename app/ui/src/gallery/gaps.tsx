// Temporary (D11): each theme gap shown with the nearest existing token and with the old app's value
// ([data-old], theme.css pending block). Deleted once the owner has picked.
import type { ReactNode } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { TooltipIconButton } from "../components/icon-button";
import { Input } from "../components/input";
import { Kbd } from "../components/kbd";
import { Switch } from "../components/switch";
import { Copy, X } from "../icons";
import { OpenTip, Section, State } from "./parts";

type Gap = { name: string; old: string; nearest: string; where: string; specimen: ReactNode };

const fills = (
  <>
    <State label="soft">
      <Button size="sm" variant="soft">
        Manage
      </Button>
    </State>
    <State label="soft hover" frozen="hover">
      <Button size="sm" variant="soft">
        Manage
      </Button>
    </State>
    <State label="outline">
      <Button size="sm" variant="outline">
        Open
      </Button>
    </State>
    <State label="ghost hover" frozen="hover">
      <Button size="sm" variant="ghost">
        Open
      </Button>
    </State>
    <State label="input">
      <div className="w-32">
        <Input placeholder="Search" />
      </div>
    </State>
    <State label="key">
      <Kbd>⌘K</Kbd>
    </State>
    <State label="switch off">
      <Switch aria-label="Off" />
    </State>
    <State label="toolbar pressed · pressed hover · active">
      <TooltipIconButton look="toolbar" tooltip="Copy" tip={false} pressed>
        <Copy />
      </TooltipIconButton>
      <span data-frozen="hover">
        <TooltipIconButton look="toolbar" tooltip="Copy" tip={false} pressed>
          <Copy />
        </TooltipIconButton>
      </span>
      <span data-frozen="active">
        <TooltipIconButton look="toolbar" tooltip="Copy" tip={false}>
          <Copy />
        </TooltipIconButton>
      </span>
    </State>
  </>
);

// Ordered most to least visible.
const GAPS: Gap[] = [
  {
    name: "toggle-on · toggle-on-fg",
    old: "blue (oklch 0.63 0.18 259), white tick",
    nearest: "primary, primary-fg tick",
    where: "checked checkbox (9 files), switch on (13)",
    specimen: (
      <State label="checked · mixed · on">
        <Checkbox aria-label="Checked" defaultChecked />
        <Checkbox aria-label="Mixed" indeterminate />
        <Switch aria-label="On" defaultChecked />
      </State>
    ),
  },
  {
    name: "opacity-disabled",
    old: "50% (the switch had 60%)",
    nearest: "none: a disabled control looks enabled",
    where: "every disabled button, input, switch",
    specimen: (
      <State label="disabled">
        <Button size="sm" disabled>
          Save
        </Button>
        <div className="w-32">
          <Input placeholder="Disabled" disabled />
        </div>
        <Switch aria-label="Disabled" disabled defaultChecked />
      </State>
    ),
  },
  {
    name: "link",
    old: "blue (oklch 0.618 0.127 259.6)",
    nearest: "primary",
    where: "link-blue button (8 uses)",
    specimen: (
      <State label="link-blue">
        <Button size="inline" variant="link-blue">
          Show all
        </Button>
      </State>
    ),
  },
  {
    name: "destructive-wash · warning-wash · success-wash",
    old: "destructive 10% (20% hover), warning 15%, success 15%",
    nearest: "chrome (muted hover), muted, muted",
    where: "soft-destructive button (4), warning badge (8), success badge (3)",
    specimen: (
      <>
        <State label="soft-destructive · hover">
          <Button size="sm" variant="soft-destructive">
            Remove
          </Button>
          <span data-frozen="hover">
            <Button size="sm" variant="soft-destructive">
              Remove
            </Button>
          </span>
        </State>
        <State label="badges">
          <Badge variant="warning">Needs sign-in</Badge>
          <Badge variant="success">Ready</Badge>
        </State>
      </>
    ),
  },
  {
    name: "fill-subtle · fill · fill-hover · fill-active, on the window",
    old: "see-through foreground 5% · 8% · 10% · 16%",
    nearest: "solid card · chrome · popover · muted",
    where: "soft (50), outline (30), ghost hover (97), input (28), keys, switch off, toolbar (14)",
    specimen: fills,
  },
  {
    name: "the same fills, on a card",
    old: "see-through: they tint whatever is under them",
    nearest: "solid: on a card, the soft fill matches the card and hovers fade",
    where: "Settings cards and rows",
    specimen: <div className="flex flex-wrap gap-x-8 gap-y-4 rounded-surface bg-card p-4">{fills}</div>,
  },
  {
    name: "primary-hover",
    old: "primary 90%",
    nearest: "primary: no hover change",
    where: "default (primary) button",
    specimen: (
      <>
        <State label="rest">
          <Button size="sm">Continue</Button>
        </State>
        <State label="hover" frozen="hover">
          <Button size="sm">Continue</Button>
        </State>
      </>
    ),
  },
  {
    name: "current-wash",
    old: "the text's own colour at 12%",
    nearest: "muted",
    where: "kbd chip (5), a key on a button",
    specimen: (
      <State label="on primary · on soft · chip">
        <Button size="sm">
          Send <Kbd>⌘↵</Kbd>
        </Button>
        <Button size="sm" variant="soft">
          Cancel <Kbd>Esc</Kbd>
        </Button>
        <Kbd variant="chip">⌘↵</Kbd>
      </State>
    ),
  },
  {
    name: "toolbar-foreground",
    old: "foreground 50%",
    nearest: "muted-foreground (brighter)",
    where: "titlebar and pane-toolbar icons at rest (14)",
    specimen: (
      <State label="rest">
        <TooltipIconButton look="toolbar" tooltip="Copy" tip={false}>
          <Copy />
        </TooltipIconButton>
        <TooltipIconButton look="toolbar" tooltip="Close" tip={false}>
          <X />
        </TooltipIconButton>
      </State>
    ),
  },
  {
    name: "destructive-fill",
    old: "destructive 60% (70% hover)",
    nearest: "destructive",
    where: "destructive button (1), destructive badge (2)",
    specimen: (
      <>
        <State label="rest · hover">
          <Button size="sm" variant="destructive">
            Delete
          </Button>
          <span data-frozen="hover">
            <Button size="sm" variant="destructive">
              Delete
            </Button>
          </span>
        </State>
        <State label="badge">
          <Badge variant="destructive">Failed</Badge>
        </State>
      </>
    ),
  },
  {
    name: "focus-outline",
    old: "1px ring colour, inside the edge",
    nearest: "the browser's own focus ring",
    where: "every control, keyboard focus only",
    specimen: (
      <State label="focus" frozen="focus">
        <Button size="sm" variant="outline">
          Open
        </Button>
        <div className="w-32">
          <Input placeholder="Search" />
        </div>
        <Switch aria-label="Focus" />
      </State>
    ),
  },
  {
    name: "duration-fast · scale-press · scale-popup · spacing-popup-shift",
    old: "150ms fades and slides; press shrinks to 90%; a tip grows from 95% and slides 0.5rem",
    nearest: "none: every change is instant",
    where: "every hover, the switch thumb, ghost icon press, tooltips",
    specimen: (
      <State label="live: hover, press, toggle">
        <Button size="sm" variant="soft">
          Hover me
        </Button>
        <TooltipIconButton tooltip="Copy">
          <Copy />
        </TooltipIconButton>
        <Switch aria-label="Toggle me" />
      </State>
    ),
  },
  {
    name: "radius-xs",
    old: "0.1875rem (3px)",
    nearest: "radius-sm (6px)",
    where: "kbd keys (12)",
    specimen: (
      <State label="keys">
        <Kbd>⌘</Kbd>
        <Kbd>K</Kbd>
        <Kbd>Esc</Kbd>
      </State>
    ),
  },
  {
    name: "radius-icon-button",
    old: "0.625rem (10px)",
    nearest: "radius-control (8px)",
    where: "every icon button (66)",
    specimen: (
      <State label="hover" frozen="hover">
        <TooltipIconButton look="toolbar" tooltip="Copy" tip={false}>
          <Copy />
        </TooltipIconButton>
        <Button size="icon" variant="outline" aria-label="Copy">
          <Copy />
        </Button>
      </State>
    ),
  },
  {
    name: "shadow-tooltip",
    old: "0 8px 18px, black 25%",
    nearest: "shadow-overlay (0 12px 32px, black 35%)",
    where: "tooltips",
    specimen: (
      <State label="tip open">
        <OpenTip label="Copy" shortcut="⌘C" trigger={<Button size="sm" variant="outline">Trigger</Button>} />
      </State>
    ),
  },
  {
    name: "invalid",
    old: "destructive 50% edge (its ring was 40%)",
    nearest: "destructive",
    where: "an input or button with an error",
    specimen: (
      <State label="error">
        <div className="w-32">
          <Input defaultValue="not a url" aria-invalid />
        </div>
      </State>
    ),
  },
];

// Mapped to an existing token with no visible change, or old inconsistencies merged (D3).
const MAPPED = [
  "Outline fill (muted 50%, 30 uses), input fill (muted 60%, 28) and ghost hover (accent 50%, 97) are all within 1% of foreground 8%: merged into fill.",
  "Disabled: buttons and inputs used 50%, the switch 60%: 50% picked (most used).",
  "Invalid edge: border 50% and ring 40% together: one invalid colour at 50%.",
  "Secondary button hover (muted 80%) → popover. Key edge (border 60%) → divider. Disabled input fill (input 80%) → input.",
  "Strip icon text (foreground 85%) → foreground. Key in a tooltip (foreground 10%) → fill-hover.",
  "Checkbox corner 5px → radius-sm 6px. Tooltip corner 1rem → capsule (the same on one line).",
  "Dropped as barely visible: tooltip letter-spacing −0.01em, switch thumb shadow, link underline offset 4px, tooltip z-index.",
  "Easings: switch ease-out and tooltip ease → ease-standard (the old default curve, already in the theme).",
  "Unused in the old app, so not rebuilt: button sizes lg and icon-lg, badge variants ghost and link, asChild.",
];

export function Gaps() {
  return (
    <>
      {GAPS.map((gap) => (
        <Section key={gap.name} title={gap.name}>
          <p className="text-sm text-muted-foreground">
            Old: {gap.old} · Nearest: {gap.nearest} · Used: {gap.where}
          </p>
          <div className="grid grid-cols-2 gap-6">
            <div className="flex flex-col gap-3">
              <span className="text-label font-medium">Nearest token</span>
              <div className="flex flex-wrap items-start gap-x-8 gap-y-4">{gap.specimen}</div>
            </div>
            <div data-old className="flex flex-col gap-3">
              <span className="text-label font-medium">Old app</span>
              <div className="flex flex-wrap items-start gap-x-8 gap-y-4">{gap.specimen}</div>
            </div>
          </div>
        </Section>
      ))}
      <Section title="Mapped without a comparison">
        <ul className="flex list-disc flex-col gap-2 ps-5 text-sm text-muted-foreground">
          {MAPPED.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </Section>
    </>
  );
}
