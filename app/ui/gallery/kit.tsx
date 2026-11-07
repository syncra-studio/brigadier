// Every slice 1 component in every state. The first copy in each row is live.
import type { ButtonProps } from "../src/components/button";
import { Copy, X } from "../src/icons";
import { type KitSet, OpenTip, Row, Section, State } from "./parts";
import { InputShapePick, KbdCornerPick } from "./picks";

const VARIANTS = ["default", "outline", "ghost", "soft", "soft-destructive", "secondary", "destructive", "link", "link-blue"] as const;
const SIZES = ["xs", "sm", "md", "inline"] as const;
const ICON_SIZES = ["icon-xs", "icon-sm", "icon-md", "icon"] as const;

function ButtonStates({ k, ...props }: ButtonProps & { k: KitSet }) {
  return (
    <>
      <State label="live">
        <k.Button {...props} />
      </State>
      <State label="hover" frozen="hover">
        <k.Button {...props} />
      </State>
      <State label="focus" frozen="focus">
        <k.Button {...props} />
      </State>
      <State label="pressed" frozen="hover active">
        <k.Button {...props} />
      </State>
      <State label="disabled">
        <k.Button {...props} disabled />
      </State>
    </>
  );
}

function Buttons() {
  return (
    <Section title="Button">
      {VARIANTS.map((variant) => (
        <Row key={variant} name={`variant ${variant} · size ${variant.startsWith("link") ? "inline" : "sm"}`}>
          {(k) => (
            <>
              <ButtonStates k={k} variant={variant} size={variant.startsWith("link") ? "inline" : "sm"}>
                {variant === "link-blue" ? "Show all" : "Continue"}
              </ButtonStates>
            </>
          )}
        </Row>
      ))}
      <Row name="sizes">
        {(k) => (
          <>
            {SIZES.map((size) => (
              <State key={size} label={size}>
                <k.Button size={size} variant={size === "inline" ? "link-blue" : "default"}>
                  <Copy />
                  Copy
                </k.Button>
              </State>
            ))}
            {ICON_SIZES.map((size) => (
              <State key={size} label={size}>
                <k.Button size={size} variant="outline" aria-label="Copy">
                  <Copy />
                </k.Button>
              </State>
            ))}
          </>
        )}
      </Row>
      <Row name="with a key hint">
        {(k) => (
          <>
            <State label="default">
              <k.Button size="sm">
                Send <k.Kbd>⌘↵</k.Kbd>
              </k.Button>
            </State>
            <State label="soft">
              <k.Button size="sm" variant="soft">
                Cancel <k.Kbd>Esc</k.Kbd>
              </k.Button>
            </State>
          </>
        )}
      </Row>
    </Section>
  );
}

function IconButtons() {
  return (
    <Section title="Icon button with tooltip">
      {(["ghost", "toolbar", "strip"] as const).map((look) => (
        <Row key={look} name={`look ${look}`}>
          {(k) => (
            <>
              <State label="live (hover for the tip)">
                <k.TitlebarTips>
                  <k.TooltipIconButton look={look} tooltip="Copy" shortcut="⌘C">
                    <Copy />
                  </k.TooltipIconButton>
                  <k.TooltipIconButton look={look} tooltip="Close">
                    <X />
                  </k.TooltipIconButton>
                </k.TitlebarTips>
              </State>
              {(["hover", "focus", "hover active"] as const).map((frozen) => (
                <State key={frozen} label={frozen === "hover active" ? "pressed" : frozen} frozen={frozen}>
                  <k.TooltipIconButton look={look} tooltip="Copy" tip={false}>
                    <Copy />
                  </k.TooltipIconButton>
                </State>
              ))}
              <State label="switched on">
                <k.TooltipIconButton look={look} tooltip="Copy" tip={false} pressed>
                  <Copy />
                </k.TooltipIconButton>
              </State>
              <State label="menu open">
                <k.TooltipIconButton look={look} tooltip="Copy" tip={false} aria-expanded>
                  <Copy />
                </k.TooltipIconButton>
              </State>
              <State label="with dot">
                <k.TooltipIconButton look={look} tooltip="Copy" tip={false} dot="bg-warning">
                  <Copy />
                </k.TooltipIconButton>
              </State>
              <State label="disabled">
                <k.TooltipIconButton look={look} tooltip="Copy" tip={false} disabled>
                  <Copy />
                </k.TooltipIconButton>
              </State>
              <State label="tip open">
                <OpenTip
                  label="Copy"
                  shortcut="⌘C"
                  trigger={
                    <k.TooltipIconButton look={look} tooltip="Copy" tip={false}>
                      <Copy />
                    </k.TooltipIconButton>
                  }
                />
              </State>
            </>
          )}
        </Row>
      ))}
      <Row name="tooltip">
        {(k) => (
          <>
            <State label="above">
              <OpenTip side="top" label="Close" trigger={<k.Button size="sm" variant="outline">Trigger</k.Button>} />
            </State>
            <State label="with a key">
              <OpenTip label="Dictate" shortcut="⌃⇧D" trigger={<k.Button size="sm" variant="outline">Trigger</k.Button>} />
            </State>
            <State label="long text wraps">
              <OpenTip
                wide
                label="Starts a new session in the background and keeps this one open"
                trigger={<k.Button size="sm" variant="outline">Trigger</k.Button>}
              />
            </State>
          </>
        )}
      </Row>
    </Section>
  );
}

function Fields() {
  return (
    <Section title="Kbd · Input · Checkbox · Switch · Badge">
      <Row name="kbd">
        {(k) => (
          <>
            <State label="key">
              <k.Kbd>⌘</k.Kbd>
              <k.Kbd>K</k.Kbd>
              <k.Kbd>Esc</k.Kbd>
            </State>
            <State label="chip">
              <span className="text-sm text-muted-foreground">
                Press <k.Kbd variant="chip">⌘↵</k.Kbd> to send
              </span>
            </State>
          </>
        )}
      </Row>
      <KbdCornerPick />
      <Row name="input">
        {(k) => (
          <>
            <State label="live">
              <div className="w-52">
                <k.Input placeholder="Search settings" />
              </div>
            </State>
            <State label="focus" frozen="focus">
              <div className="w-52">
                <k.Input placeholder="Search settings" />
              </div>
            </State>
            <State label="filled">
              <div className="w-52">
                <k.Input defaultValue="~/Development/brigadier" />
              </div>
            </State>
            <State label="disabled">
              <div className="w-52">
                <k.Input placeholder="Search settings" disabled />
              </div>
            </State>
            <State label="error">
              <div className="w-52">
                <k.Input defaultValue="not a url" aria-invalid />
              </div>
            </State>
          </>
        )}
      </Row>
      <InputShapePick />
      <Row name="checkbox">
        {(k) => (
          <>
            <State label="live">
              <k.Checkbox aria-label="Live" />
            </State>
            <State label="checked">
              <k.Checkbox aria-label="Checked" defaultChecked />
            </State>
            <State label="mixed">
              <k.Checkbox aria-label="Mixed" indeterminate />
            </State>
            <State label="focus" frozen="focus">
              <k.Checkbox aria-label="Focus" />
              <k.Checkbox aria-label="Focus checked" defaultChecked />
            </State>
            <State label="disabled">
              <k.Checkbox aria-label="Disabled" disabled />
              <k.Checkbox aria-label="Disabled checked" disabled defaultChecked />
            </State>
            <State label="mark (look only)">
              <k.CheckboxMark checked={false} />
              <k.CheckboxMark checked />
            </State>
          </>
        )}
      </Row>
      <Row name="switch">
        {(k) => (
          <>
            <State label="live">
              <k.Switch aria-label="Live" />
            </State>
            <State label="on">
              <k.Switch aria-label="On" defaultChecked />
            </State>
            <State label="focus" frozen="focus">
              <k.Switch aria-label="Focus" />
              <k.Switch aria-label="Focus on" defaultChecked />
            </State>
            <State label="disabled">
              <k.Switch aria-label="Disabled" disabled />
              <k.Switch aria-label="Disabled on" disabled defaultChecked />
            </State>
          </>
        )}
      </Row>
      <Row name="badge">
        {(k) => (
          <>
            {(["default", "secondary", "outline", "warning", "success", "destructive"] as const).map((variant) => (
              <State key={variant} label={variant}>
                <k.Badge variant={variant}>{variant === "default" ? "New" : variant}</k.Badge>
              </State>
            ))}
          </>
        )}
      </Row>
    </Section>
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
