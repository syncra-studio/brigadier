import { useRef, useState } from "react";

import { Check, ChevronDown, Dock, Folder, Globe, HandRaised, ShieldExclamation, ShieldTerminal, Terminal, Warning } from "../../icons";
import { Button } from "../button";
import { ConfirmForm } from "../confirm-dialog";
import { cx } from "../cx";
import { Dialog, DialogContent } from "../dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../menu";
import { ComposerPill } from "./composer";

/** How the agent's actions are approved. The words are the UI's; the level is Rust's. */
export type PermissionLevel = "ask" | "auto" | "full";

export const LEVELS: { level: PermissionLevel; label: string; detail: string; Icon: typeof HandRaised }[] = [
  { level: "ask", label: "Ask", detail: "Asks before edits and commands", Icon: HandRaised },
  { level: "auto", label: "Auto", detail: "Works on its own, asks before risky actions", Icon: ShieldTerminal },
  { level: "full", label: "Full access", detail: "Unrestricted access to the internet and all your files", Icon: ShieldExclamation },
];

const ALL_LEVELS = LEVELS.map((each) => each.level);

/**
 * The permission pill and menu, opening upward: "How should the agent's actions be approved?", each level with
 * its icon and one line, a check on the one in use, Full access in orange and confirmed before it turns on. In
 * a folder the user doesn't trust it shows Ask, the only level there, and the others can't be picked.
 */
export function PermissionPicker({
  value: chosen,
  onChange,
  levels = ALL_LEVELS,
  untrusted = false,
}: {
  value: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
  /** The levels the agent has, from its adapter; one it lacks isn't offered. */
  levels?: readonly PermissionLevel[];
  untrusted?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const value = untrusted ? "ask" : chosen;
  const { label, Icon } = LEVELS.find((each) => each.level === value)!;
  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger
          render={
            <ComposerPill
              aria-label={`Permission level: ${label}`}
              data-slot="permission-picker"
              className="max-w-xs"
            />
          }
        >
          {/* Orange on the parts: the pill's base sets its own text colour. */}
          <Icon className={cx("size-icon-md", value === "full" && "text-full-access")} />
          <span className={cx("truncate", value === "full" && "text-full-access")}>{label}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="start"
          data-slot="permission-menu"
          className="w-125 max-w-full p-1.5"
        >
          <p className="px-2 pt-1 pb-1.5 text-sm text-muted-foreground">How should the agent’s actions be approved?</p>
          {untrusted && (
            // As wide as the menu, never widening it.
            <p className="w-0 min-w-full px-2 pb-1.5 text-xs text-muted-foreground">
              This folder isn't trusted, so sessions here ask first. Change it in the project's settings.
            </p>
          )}
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next: PermissionLevel) => {
              if (next === "full" && value !== "full") setConfirming(true);
              else onChange(next);
            }}
          >
            {LEVELS.filter((each) => levels.includes(each.level)).map(({ level, label: name, detail, Icon: LevelIcon }) => {
              const orange = level === "full";
              return (
                <DropdownMenuRadioItem
                  key={level}
                  value={level}
                  disabled={untrusted && level !== "ask"}
                  indicator={<Check className="size-icon-md" />}
                  className={cx("py-1.5", orange && "text-full-access")}
                >
                  {/* The old row's wider gap; the item's own is set in its base. */}
                  <span className="flex min-w-0 items-center gap-3">
                    <LevelIcon className="size-icon-md" />
                    <span className="flex min-w-0 flex-col">
                      <span>{name}</span>
                      <span className={cx("whitespace-nowrap", orange ? "text-full-access" : "text-muted-foreground")}>{detail}</span>
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <FullAccessDialog
        open={confirming}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onChange("full");
        }}
      />
    </>
  );
}

/** What Full Access reaches. */
const REACHES = [
  { Icon: Folder, label: "Files" },
  { Icon: Dock, label: "Commands" },
  { Icon: Globe, label: "Internet" },
];

/** "Turn on Full Access?" in one sentence and what it reaches (D172). Only Confirm changes the level; Cancel takes the focus. */
export function FullAccessDialog({
  open,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent showCloseButton={false} initialFocus={cancel}>
        <ConfirmForm
          title={
            <span className="flex items-center gap-2">
              <Warning className="size-icon-md" />
              Turn on Full Access?
            </span>
          }
          description="Agents can use all of these without asking."
          confirm="Turn on Full Access"
          destructive
          cancelRef={cancel}
          onCancel={onCancel}
          onConfirm={onConfirm}
        >
          <ul className="flex gap-4 text-sm text-muted-foreground">
            {REACHES.map(({ Icon, label }) => (
              <li key={label} className="flex items-center gap-1.5">
                <Icon className="size-icon-sm" />
                {label}
              </li>
            ))}
          </ul>
        </ConfirmForm>
      </DialogContent>
    </Dialog>
  );
}
