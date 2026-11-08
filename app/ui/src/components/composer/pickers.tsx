import { useRef, useState } from "react";

import { Check, Dock, Folder, Globe, HandRaised, ShieldExclamation, ShieldTerminal, Warning } from "../../icons";
import { Button } from "../button";
import { cx } from "../cx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../menu";
import { ComposerPill } from "./composer";

// A popup held open in the gallery's box never shifts to stay in view.
export const STILL = { side: "none", align: "none" } as const;

/** How the agent's actions are approved. The words are the UI's; the level is Rust's. */
export type PermissionLevel = "ask" | "auto" | "full";

const LEVELS: { level: PermissionLevel; label: string; detail: string; Icon: typeof HandRaised }[] = [
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
  onLearnMore,
  held,
}: {
  value: PermissionLevel;
  onChange: (level: PermissionLevel) => void;
  /** The levels the agent has, from its adapter; one it lacks isn't offered. */
  levels?: readonly PermissionLevel[];
  untrusted?: boolean;
  /** Opens the permission levels' help; without it there is no "Learn more". */
  onLearnMore?: () => void;
  /** The gallery's box to hold the menu open in. */
  held?: HTMLElement;
}) {
  const [confirming, setConfirming] = useState(false);
  const value = untrusted ? "ask" : chosen;
  const { label, Icon } = LEVELS.find((each) => each.level === value)!;
  return (
    <>
      <DropdownMenu modal={false} open={held ? true : undefined}>
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
          container={held}
          collisionAvoidance={held ? STILL : undefined}
          className="w-125 max-w-full p-1.5"
        >
          <div className="flex items-end justify-between gap-6 px-2 pt-1 pb-1.5 text-sm">
            <p className="text-muted-foreground">How should the agent’s actions be approved?</p>
            {onLearnMore && (
              <button type="button" className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground focus-visible:focus-ring" onClick={onLearnMore}>
                Learn more
              </button>
            )}
          </div>
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
        onLearnMore={onLearnMore}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          onChange("full");
        }}
      />
    </>
  );
}

/** What Full access lets the agent do, in the confirmation's card. */
const POWERS = [
  { Icon: Folder, tone: "text-link", title: "Files and folders", line: "Read, create, modify, or delete files anywhere on this computer" },
  { Icon: Dock, tone: "text-muted-foreground", title: "Terminal commands", line: "Run commands, install software, and change system settings" },
  { Icon: Globe, tone: "text-link", title: "Internet", line: "Access websites and send data" },
];

/** "Turn on Full Access?": what the agent could do without asking, and the risks. Only Confirm changes the level. */
export function FullAccessDialog({
  open,
  onCancel,
  onConfirm,
  onLearnMore,
  held,
}: {
  open: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  onLearnMore?: () => void;
  /** The gallery's box to hold it open in, not modal and not taking focus. */
  held?: HTMLElement;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  return (
    <Dialog open={open} modal={!held} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent showCloseButton={false} container={held} initialFocus={held ? false : cancel}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-lg">
            <Warning className="size-icon-md" />
            Turn on Full Access?
          </DialogTitle>
          <DialogDescription>
            Brigadier’s agents will be able to run commands, use the internet, and create and edit files anywhere on this computer without your
            permission. This includes but is not limited to:
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-border rounded-surface bg-fill-subtle px-3">
          {POWERS.map(({ Icon, tone, title, line }) => (
            <li key={title} className="flex items-center gap-3 py-2.5">
              <Icon className={cx("size-icon-lg shrink-0", tone)} />
              <span className="flex min-w-0 flex-col">
                <span className="font-medium">{title}</span>
                <span className="text-xs text-muted-foreground">{line}</span>
              </span>
            </li>
          ))}
        </ul>
        <p className="text-muted-foreground">
          Agents run commands like your own terminal, without asking. This comes with risks like loss or exposure of sensitive data and prompt
          injection. You can turn this off.{" "}
          {onLearnMore && (
            <button type="button" className="cursor-pointer text-link hover:underline focus-visible:focus-ring" onClick={onLearnMore}>
              Learn more
            </button>
          )}
        </p>
        <DialogFooter>
          <Button ref={cancel} variant="secondary" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="soft-destructive" onClick={onConfirm}>
            <Warning />
            Confirm
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
