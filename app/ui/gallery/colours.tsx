// Pending the owner's pick (D20): the red buttons and the other status colours, old against Apple's system
// colours. Deleted once the owner picks.
import { Badge } from "../src/components/badge";
import { Button } from "../src/components/button";
import { Checkbox } from "../src/components/checkbox";
import { cx } from "../src/components/cx";
import { Switch } from "../src/components/switch";
import type { ReactNode } from "react";
import { Section, State } from "./parts";

// Each choice lays its colours over the theme's (theme.css, "Pending owner pick").
const RED = [
  ["A · old", ""],
  ["B · Apple red at the old transparency", "pending-apple-red-tint"],
  ["C · Apple's way: solid red, white text", "pending-apple-red-solid"],
] as const;
const STATUS = [
  ["old", ""],
  ["Apple", "pending-apple-status"],
] as const;

function Choice({ label, palette, children }: { label: string; palette: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-label text-muted-foreground">{label}</h3>
      <div className={cx("flex flex-col gap-4", palette)}>{children}</div>
    </div>
  );
}

function RedStates({ variant }: { variant: "soft-destructive" | "destructive" }) {
  return (
    <div className="flex items-start gap-6">
      <State label={variant}>
        <Button size="sm" variant={variant}>Delete</Button>
      </State>
      <State label="hover" frozen="hover">
        <Button size="sm" variant={variant}>Delete</Button>
      </State>
      <State label="pressed" frozen="hover active">
        <Button size="sm" variant={variant}>Delete</Button>
      </State>
      <State label="disabled">
        <Button size="sm" variant={variant} disabled>Delete</Button>
      </State>
    </div>
  );
}

export function Colours() {
  return (
    <Section title="Colours (pending your pick)">
      <div className="flex flex-wrap gap-x-12 gap-y-6">
        {RED.map(([label, palette]) => (
          <Choice key={label} label={label} palette={palette}>
            <RedStates variant="soft-destructive" />
            <RedStates variant="destructive" />
            <State label="badge">
              <Badge variant="destructive">destructive</Badge>
            </State>
          </Choice>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-12 gap-y-6">
        {STATUS.map(([label, palette]) => (
          <Choice key={label} label={`other status colours · ${label}`} palette={palette}>
            <div className="flex items-start gap-6">
              <State label="warning">
                <Badge variant="warning">warning</Badge>
              </State>
              <State label="success">
                <Badge variant="success">success</Badge>
              </State>
              <State label="link-blue">
                <Button size="inline" variant="link-blue">Show all</Button>
              </State>
              <State label="checkbox on">
                <Checkbox aria-label="Checkbox on" defaultChecked />
              </State>
              <State label="switch on">
                <Switch aria-label="Switch on" defaultChecked />
              </State>
            </div>
          </Choice>
        ))}
      </div>
    </Section>
  );
}
