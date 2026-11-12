// Slice 1's components live: each variant and size side by side, disabled where it has one.
import { Badge } from "../src/components/badge";
import { Button, type ButtonProps } from "../src/components/button";
import { Checkbox, CheckboxMark } from "../src/components/checkbox";
import { TooltipIconButton } from "../src/components/icon-button";
import { Input } from "../src/components/input";
import { Kbd } from "../src/components/kbd";
import { Switch } from "../src/components/switch";
import { TitlebarTips, Tooltip, TooltipContent, TooltipTrigger } from "../src/components/tooltip";
import { Copy, X } from "../src/icons";
import { Row, Section, State } from "./parts";

const VARIANTS = ["default", "outline", "ghost", "soft", "soft-destructive", "secondary", "destructive", "link", "link-blue"] as const;
const SIZES = ["xs", "sm", "md", "inline"] as const;
const ICON_SIZES = ["icon-xs", "icon-sm", "icon-md", "icon"] as const;

function ButtonStates(props: ButtonProps) {
  return (
    <>
      <State label="live">
        <Button {...props} />
      </State>
      <State label="disabled">
        <Button {...props} disabled />
      </State>
    </>
  );
}

/** A tip on a button, shown on hover. */
function Tip({ label, shortcut, side }: { label: string; shortcut?: string; side?: "top" | "bottom" }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button size="sm" variant="outline" />}>Trigger</TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </TooltipContent>
    </Tooltip>
  );
}

function Buttons() {
  return (
    <Section title="Button">
      {VARIANTS.map((variant) => (
        <Row key={variant} name={`variant ${variant} · size ${variant.startsWith("link") ? "inline" : "sm"}`}>
          <ButtonStates variant={variant} size={variant.startsWith("link") ? "inline" : "sm"}>
            {variant === "link-blue" ? "Show all" : "Continue"}
          </ButtonStates>
        </Row>
      ))}
      <Row name="sizes">
        {SIZES.map((size) => (
          <State key={size} label={size}>
            <Button size={size} variant={size === "inline" ? "link-blue" : "default"}>
              <Copy />
              Copy
            </Button>
          </State>
        ))}
        {ICON_SIZES.map((size) => (
          <State key={size} label={size}>
            <Button size={size} variant="outline" aria-label="Copy">
              <Copy />
            </Button>
          </State>
        ))}
      </Row>
      <Row name="with a key hint">
        <State label="default">
          <Button size="sm">
            Send <Kbd>⌘↵</Kbd>
          </Button>
        </State>
        <State label="soft">
          <Button size="sm" variant="soft">
            Cancel <Kbd>Esc</Kbd>
          </Button>
        </State>
      </Row>
    </Section>
  );
}

function IconButtons() {
  return (
    <Section title="Icon button with tooltip">
      {(["ghost", "toolbar", "strip"] as const).map((look) => (
        <Row key={look} name={`look ${look}`}>
          <State label="live (hover for the tip)">
            <TitlebarTips>
              <TooltipIconButton look={look} tooltip="Copy" shortcut="⌘C">
                <Copy />
              </TooltipIconButton>
              <TooltipIconButton look={look} tooltip="Close">
                <X />
              </TooltipIconButton>
            </TitlebarTips>
          </State>
          <State label="switched on">
            <TooltipIconButton look={look} tooltip="Copy" tip={false} pressed>
              <Copy />
            </TooltipIconButton>
          </State>
          <State label="with dot">
            <TooltipIconButton look={look} tooltip="Copy" tip={false} dot="bg-warning">
              <Copy />
            </TooltipIconButton>
          </State>
          <State label="disabled">
            <TooltipIconButton look={look} tooltip="Copy" tip={false} disabled>
              <Copy />
            </TooltipIconButton>
          </State>
        </Row>
      ))}
      <Row name="tooltip (hover each)">
        <State label="above">
          <Tip side="top" label="Close" />
        </State>
        <State label="with a key">
          <Tip label="Dictate" shortcut="⌃⇧D" />
        </State>
        <State label="long text wraps">
          <Tip label="Starts a new session in the background and keeps this one open" />
        </State>
      </Row>
    </Section>
  );
}

function Fields() {
  return (
    <>
      <Section title="Kbd">
        <Row>
          <State label="key">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
            <Kbd>Esc</Kbd>
          </State>
          <State label="chip">
            <span className="text-sm text-muted-foreground">
              Press <Kbd variant="chip">⌘↵</Kbd> to send
            </span>
          </State>
        </Row>
      </Section>
      <Section title="Input">
        <Row>
          <State label="live">
            <div className="w-52">
              <Input placeholder="Search settings" />
            </div>
          </State>
          <State label="filled">
            <div className="w-52">
              <Input defaultValue="~/Development/brigadier" />
            </div>
          </State>
          <State label="disabled">
            <div className="w-52">
              <Input placeholder="Search settings" disabled />
            </div>
          </State>
          <State label="error">
            <div className="w-52">
              <Input defaultValue="not a url" aria-invalid />
            </div>
          </State>
        </Row>
      </Section>
      <Section title="Checkbox">
        <Row>
          <State label="live">
            <Checkbox aria-label="Live" />
          </State>
          <State label="checked">
            <Checkbox aria-label="Checked" defaultChecked />
          </State>
          <State label="mixed">
            <Checkbox aria-label="Mixed" indeterminate />
          </State>
          <State label="disabled">
            <Checkbox aria-label="Disabled" disabled />
            <Checkbox aria-label="Disabled checked" disabled defaultChecked />
          </State>
          <State label="mark (look only)">
            <CheckboxMark checked={false} />
            <CheckboxMark checked />
          </State>
        </Row>
      </Section>
      <Section title="Switch">
        <Row>
          <State label="live">
            <Switch aria-label="Live" />
          </State>
          <State label="on">
            <Switch aria-label="On" defaultChecked />
          </State>
          <State label="disabled">
            <Switch aria-label="Disabled" disabled />
            <Switch aria-label="Disabled on" disabled defaultChecked />
          </State>
        </Row>
      </Section>
      <Section title="Badge">
        <Row>
          {(["default", "secondary", "outline", "warning", "success", "destructive"] as const).map((variant) => (
            <State key={variant} label={variant}>
              <Badge variant={variant}>{variant === "default" ? "New" : variant}</Badge>
            </State>
          ))}
        </Row>
      </Section>
    </>
  );
}

export function Kit() {
  return (
    <>
      <Buttons />
      <IconButtons />
      <Fields />
    </>
  );
}
