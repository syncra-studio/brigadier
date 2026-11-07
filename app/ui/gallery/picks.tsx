// Pending the owner's pick (D31): Kbd corners and input shapes, in the kit only. Deleted once picked.
import { Button } from "../src/components/button";
import { Input } from "../src/components/input";
import { Kbd } from "../src/components/kbd";
import { Choice, Row, State } from "./parts";

const KBD = [
  ["A · 3px (now; a chip in a button is a capsule today)", ""],
  ["B · 4px", "pending-kbd-4"],
  ["C · 5px (the checkbox's corner)", "pending-kbd-5"],
  ["D · 6px", "pending-kbd-6"],
] as const;

const INPUT = [
  ["A · now (the old look)", ""],
  ["B · Apple style (HIG gives no numbers: an approximation of the macOS field)", "pending-input-apple"],
  ["C · capsule", "pending-input-capsule"],
] as const;

export function KbdCornerPick() {
  return (
    <Row name="Kbd corner (pick one)" current>
      {() =>
        KBD.map(([label, pick]) => (
          <Choice key={label} label={label} className={pick}>
            <State label="key">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
              <Kbd>Esc</Kbd>
            </State>
            <State label="in a button">
              <Button size="sm">
                Send <Kbd>⌘↵</Kbd>
              </Button>
            </State>
          </Choice>
        ))
      }
    </Row>
  );
}

export function InputShapePick() {
  return (
    <Row name="Input shape (pick one)" current>
      {() =>
        INPUT.map(([label, pick]) => (
          <Choice key={label} label={label} className={pick}>
            {(
              [
                ["rest", undefined, {}],
                ["hover", "hover", {}],
                ["focus", "focus", {}],
                ["disabled", undefined, { disabled: true }],
                ["error", undefined, { "aria-invalid": true, defaultValue: "not a url" }],
              ] as const
            ).map(([state, frozen, props]) => (
              <State key={state} label={state} frozen={frozen}>
                <div className="w-40">
                  <Input placeholder="Search settings" {...props} />
                </div>
              </State>
            ))}
          </Choice>
        ))
      }
    </Row>
  );
}
