// Menus, popovers, dialogs and toasts: one live copy each. Select and Spinner keep what using them can't reach.
import { useState } from "react";

import { Button } from "../src/components/button";
import { Copy, X } from "../src/icons";
import * as k from "./current";
import { Row, Section, State } from "./parts";

function DropdownMenus() {
  const [sort, setSort] = useState("recent");
  const [pinned, setPinned] = useState(true);
  return (
    <Section title="Dropdown menu">
      <k.DropdownMenu>
        <k.DropdownMenuTrigger render={<Button size="sm" variant="outline" className="self-start" />}>Open menu</k.DropdownMenuTrigger>
        <k.DropdownMenuContent align="start" className="w-72">
          <k.DropdownMenuLabel>Session</k.DropdownMenuLabel>
          <k.DropdownMenuItem>
            <k.MenuRow icon={<Copy />} title="Copy link" hint={<k.DropdownMenuShortcut>⌘L</k.DropdownMenuShortcut>} />
          </k.DropdownMenuItem>
          <k.DropdownMenuItem>
            <k.MenuRow icon={<Copy />} title="Opus" detail="the most capable" />
          </k.DropdownMenuItem>
          <k.DropdownMenuItem className="py-2">
            <k.MenuRow icon={<Copy />} title="Fix the login bug" detail="~/Development/brigadier" hint="2h" twoLine />
          </k.DropdownMenuItem>
          <k.DropdownMenuItem>
            <k.MenuRow title="main" hint="a1b2c3d" mono />
          </k.DropdownMenuItem>
          <k.DropdownMenuItem disabled>
            <k.MenuRow icon={<Copy />} title="Move (disabled)" />
          </k.DropdownMenuItem>
          <k.DropdownMenuSeparator />
          <k.DropdownMenuLabel variant="heading">Sort</k.DropdownMenuLabel>
          <k.DropdownMenuRadioGroup value={sort} onValueChange={setSort}>
            <k.DropdownMenuRadioItem value="recent">Recent</k.DropdownMenuRadioItem>
            <k.DropdownMenuRadioItem value="name">Name</k.DropdownMenuRadioItem>
          </k.DropdownMenuRadioGroup>
          <k.DropdownMenuCheckboxItem checked={pinned} onCheckedChange={setPinned}>
            Pinned first
          </k.DropdownMenuCheckboxItem>
          <k.DropdownMenuSeparator />
          <k.DropdownMenuSub>
            <k.DropdownMenuSubTrigger>Open in</k.DropdownMenuSubTrigger>
            <k.DropdownMenuSubContent>
              <k.DropdownMenuItem>Finder</k.DropdownMenuItem>
              <k.DropdownMenuItem>Terminal</k.DropdownMenuItem>
            </k.DropdownMenuSubContent>
          </k.DropdownMenuSub>
          <k.DropdownMenuItem variant="destructive">
            <k.MenuRow icon={<X />} title="Delete" />
          </k.DropdownMenuItem>
        </k.DropdownMenuContent>
      </k.DropdownMenu>
    </Section>
  );
}

function ContextMenus() {
  return (
    <Section title="Context menu">
      <k.ContextMenu>
        <k.ContextMenuTrigger className="flex h-24 w-40 items-center justify-center rounded-surface border border-dashed border-border text-label text-muted-foreground">
          Right-click here
        </k.ContextMenuTrigger>
        <k.ContextMenuContent>
          <k.ContextMenuItem>Rename</k.ContextMenuItem>
          <k.ContextMenuItem>Duplicate</k.ContextMenuItem>
          <k.ContextMenuSeparator />
          <k.ContextMenuItem variant="destructive">Delete</k.ContextMenuItem>
          <k.ContextMenuSub>
            <k.ContextMenuSubTrigger>Open in</k.ContextMenuSubTrigger>
            <k.ContextMenuSubContent>
              <k.ContextMenuItem>Finder</k.ContextMenuItem>
            </k.ContextMenuSubContent>
          </k.ContextMenuSub>
        </k.ContextMenuContent>
      </k.ContextMenu>
    </Section>
  );
}

function Popovers() {
  return (
    <Section title="Popover">
      <k.Popover>
        <k.PopoverTrigger render={<Button size="sm" variant="outline" className="self-start" />}>Open popover</k.PopoverTrigger>
        <k.PopoverContent>
          <div className="flex w-56 flex-col">
            <k.DropdownMenuLabel>Site information</k.DropdownMenuLabel>
            <p className="px-2 pb-2 text-sm text-muted-foreground">A floating card for a little more detail.</p>
          </div>
        </k.PopoverContent>
      </k.Popover>
    </Section>
  );
}

const THEMES = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light", hint: "Bright surfaces, for daylight" },
] as const;

function Selects() {
  const [theme, setTheme] = useState<(typeof THEMES)[number]["value"]>("dark");
  return (
    <Section title="Select">
      <Row>
        <State label="live">
          <k.Select label="Theme" value={theme} options={THEMES} onChange={setTheme} align="start" />
        </State>
        <State label="placeholder">
          <k.SelectTrigger label="Model" placeholder>
            Choose a model
          </k.SelectTrigger>
        </State>
        <State label="with icon">
          <k.SelectTrigger label="Model" icon={<Copy className="size-icon-sm" />}>
            Opus 5.5
          </k.SelectTrigger>
        </State>
        <State label="disabled">
          <k.Select label="Theme" value={theme} options={THEMES} onChange={setTheme} align="start" disabled />
        </State>
      </Row>
    </Section>
  );
}

function Dialogs() {
  return (
    <Section title="Dialog">
      <k.Dialog>
        <k.DialogTrigger render={<Button size="sm" variant="outline" className="self-start" />}>Open dialog</k.DialogTrigger>
        <k.DialogContent>
          <k.DialogHeader>
            <k.DialogTitle>Rename session</k.DialogTitle>
            <k.DialogDescription>Give it a name you'll find again.</k.DialogDescription>
          </k.DialogHeader>
          <k.DialogFooter showCloseButton />
        </k.DialogContent>
      </k.Dialog>
    </Section>
  );
}

/** Confirming shows it busy for a moment, as a real action does. */
function Confirms() {
  const [open, setOpen] = useState(false);
  const [destructive, setDestructive] = useState(false);
  const [busy, setBusy] = useState(false);
  const ask = (red: boolean) => {
    setDestructive(red);
    setOpen(true);
  };
  return (
    <Section title="Confirm dialog">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => ask(false)}>
          Ask
        </Button>
        <Button size="sm" variant="outline" onClick={() => ask(true)}>
          Ask to delete
        </Button>
      </div>
      <k.ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={destructive ? "Delete this session?" : "Stage these changes?"}
        description={destructive ? "Its messages and files go too. This can't be undone." : "They go into the next commit."}
        confirm={destructive ? "Delete" : "Stage"}
        destructive={destructive}
        busy={busy}
        onConfirm={() => {
          setBusy(true);
          setTimeout(() => {
            setBusy(false);
            setOpen(false);
          }, 1200);
        }}
      />
    </Section>
  );
}

function Toasts() {
  return (
    <Section title="Toast">
      <div className="relative flex h-40 w-96 items-end gap-2">
        <k.Toaster className="top-0" />
        <Button size="xs" variant="outline" onClick={() => k.showToast("Archived chat")}>
          Neutral
        </Button>
        <Button size="xs" variant="outline" onClick={() => k.showToast("Changes reverted", { tone: "success" })}>
          Success
        </Button>
        <Button size="xs" variant="outline" onClick={() => k.showToast("Couldn't push", { tone: "error", actions: [{ label: "Retry", run: () => {} }] })}>
          Error
        </Button>
        <Button size="xs" variant="outline" onClick={() => k.showToast("Couldn't reach the daemon: the socket closed before it answered, so nothing was saved", { tone: "error" })}>
          Long
        </Button>
      </div>
    </Section>
  );
}

function Spinners() {
  return (
    <Section title="Spinner">
      <Row>
        {(["size-icon-xs", "size-icon-sm", "size-icon-md", "size-icon-lg"] as const).map((size) => (
          <State key={size} label={size.replace("size-", "")}>
            <k.Spinner className={`${size} ${k.spin}`} />
          </State>
        ))}
        <State label="busy button">
          <Button size="sm" disabled>
            <k.Spinner className={`size-icon-xs ${k.spin}`} />
            Delete
          </Button>
        </State>
      </Row>
    </Section>
  );
}

export function Popups() {
  return (
    <>
      <DropdownMenus />
      <ContextMenus />
      <Popovers />
      <Selects />
      <Dialogs />
      <Confirms />
      <Toasts />
      <Spinners />
    </>
  );
}
