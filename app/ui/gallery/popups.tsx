// Slice 2: every popup in every state, Current beside Old app. Frozen ones are held open in place,
// non-modal (D10); the first copy in each row is live, with its real modal behaviour.
import { Toast } from "@base-ui/react/toast";
import { useEffect, useState } from "react";

import { Button } from "../src/components/button";
import { Copy, Spinner, X } from "../src/icons";
import { Compare, Held, type KitSet, Section, State } from "./parts";

// A frozen popup never shifts to stay in view.
const STILL = { side: "none", align: "none" } as const;

// The point a right-click would open a context menu at: the box's top corner.
const corner = (box: HTMLElement) => ({
  getBoundingClientRect: () => {
    const { x, y } = box.getBoundingClientRect();
    return new DOMRect(x, y, 0, 0);
  },
});

function MenuItems({ k }: { k: KitSet }) {
  const [sort, setSort] = useState("recent");
  const [pinned, setPinned] = useState(true);
  return (
    <>
      <k.DropdownMenuLabel>Session</k.DropdownMenuLabel>
      <k.DropdownMenuItem data-frozen="highlight">
        <k.MenuRow icon={<Copy />} title="Copy link" hint={<k.DropdownMenuShortcut>⌘L</k.DropdownMenuShortcut>} />
      </k.DropdownMenuItem>
      <k.DropdownMenuItem>
        <k.MenuRow icon={<Copy />} title="Duplicate" />
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
      <k.DropdownMenuItem variant="destructive">
        <k.MenuRow icon={<X />} title="Delete" />
      </k.DropdownMenuItem>
      <k.DropdownMenuItem variant="destructive" data-frozen="highlight">
        <k.MenuRow icon={<X />} title="Delete (highlighted)" />
      </k.DropdownMenuItem>
    </>
  );
}

function DropdownMenus() {
  return (
    <Section title="Dropdown menu">
      <Compare name="live · open (frozen) · sub-menu open">
        {(k) => (
          <>
            <State label="live">
              <k.DropdownMenu>
                <k.DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>Open menu</k.DropdownMenuTrigger>
                <k.DropdownMenuContent align="start">
                  <MenuItems k={k} />
                  <k.DropdownMenuSub>
                    <k.DropdownMenuSubTrigger>Open in</k.DropdownMenuSubTrigger>
                    <k.DropdownMenuSubContent>
                      <k.DropdownMenuItem>Finder</k.DropdownMenuItem>
                      <k.DropdownMenuItem>Terminal</k.DropdownMenuItem>
                    </k.DropdownMenuSubContent>
                  </k.DropdownMenuSub>
                </k.DropdownMenuContent>
              </k.DropdownMenu>
            </State>
            <State label="open">
              <Held className="h-88 w-48">
                {(box) => (
                  <k.DropdownMenu open modal={false}>
                    <k.DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>Open menu</k.DropdownMenuTrigger>
                    <k.DropdownMenuContent container={box} align="start" collisionAvoidance={STILL}>
                      <MenuItems k={k} />
                    </k.DropdownMenuContent>
                  </k.DropdownMenu>
                )}
              </Held>
            </State>
            <State label="sub-menu open">
              <Held className="h-32 w-64">
                {(box) => (
                  <k.DropdownMenu open modal={false}>
                    <k.DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>Open menu</k.DropdownMenuTrigger>
                    <k.DropdownMenuContent container={box} align="start" collisionAvoidance={STILL}>
                      <k.DropdownMenuItem>Rename</k.DropdownMenuItem>
                      <k.DropdownMenuSub open>
                        <k.DropdownMenuSubTrigger>Open in</k.DropdownMenuSubTrigger>
                        <k.DropdownMenuSubContent container={box} collisionAvoidance={STILL}>
                          <k.DropdownMenuItem>Finder</k.DropdownMenuItem>
                          <k.DropdownMenuItem>Terminal</k.DropdownMenuItem>
                        </k.DropdownMenuSubContent>
                      </k.DropdownMenuSub>
                    </k.DropdownMenuContent>
                  </k.DropdownMenu>
                )}
              </Held>
            </State>
          </>
        )}
      </Compare>
      <Compare name="menu rows: detail · two lines · mono hint">
        {(k) => (
          <Held className="h-40 w-72">
            {(box) => (
              <k.DropdownMenu open modal={false}>
                <k.DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>Rows</k.DropdownMenuTrigger>
                <k.DropdownMenuContent container={box} align="start" collisionAvoidance={STILL} className="w-72">
                  <k.DropdownMenuItem>
                    <k.MenuRow icon={<Copy />} title="Opus" detail="the most capable" />
                  </k.DropdownMenuItem>
                  <k.DropdownMenuItem className="py-2">
                    <k.MenuRow icon={<Copy />} title="Fix the login bug" detail="~/Development/brigadier" hint="2h" twoLine />
                  </k.DropdownMenuItem>
                  <k.DropdownMenuItem>
                    <k.MenuRow title="main" hint="a1b2c3d" mono />
                  </k.DropdownMenuItem>
                </k.DropdownMenuContent>
              </k.DropdownMenu>
            )}
          </Held>
        )}
      </Compare>
    </Section>
  );
}

function ContextMenus() {
  return (
    <Section title="Context menu">
      <Compare name="live (right-click the box) · open (frozen)">
        {(k) => {
          const items = (
            <>
              <k.ContextMenuItem>Rename</k.ContextMenuItem>
              <k.ContextMenuItem>Duplicate</k.ContextMenuItem>
              <k.ContextMenuSeparator />
              <k.ContextMenuItem variant="destructive">Delete</k.ContextMenuItem>
            </>
          );
          return (
            <>
              <State label="live">
                <k.ContextMenu>
                  <k.ContextMenuTrigger className="flex h-24 w-40 items-center justify-center rounded-surface border border-dashed border-border text-label text-muted-foreground">
                    Right-click here
                  </k.ContextMenuTrigger>
                  <k.ContextMenuContent>
                    {items}
                    <k.ContextMenuSub>
                      <k.ContextMenuSubTrigger>Open in</k.ContextMenuSubTrigger>
                      <k.ContextMenuSubContent>
                        <k.ContextMenuItem>Finder</k.ContextMenuItem>
                      </k.ContextMenuSubContent>
                    </k.ContextMenuSub>
                  </k.ContextMenuContent>
                </k.ContextMenu>
              </State>
              <State label="open">
                {/* Held by a dropdown's non-modal root: a context menu's own root always traps focus, which
                    would lock the gallery. Its surface and rows are the same parts. */}
                <Held className="h-28 w-36">
                  {(box) => (
                    <k.DropdownMenu open modal={false}>
                      <k.DropdownMenuContent container={box} anchor={corner(box)} side="bottom" align="start" collisionAvoidance={STILL}>
                        {items}
                      </k.DropdownMenuContent>
                    </k.DropdownMenu>
                  )}
                </Held>
              </State>
            </>
          );
        }}
      </Compare>
    </Section>
  );
}

function Popovers() {
  return (
    <Section title="Popover">
      <Compare name="live · open (frozen)">
        {(k) => {
          const body = (
            <div className="flex w-56 flex-col">
              <k.DropdownMenuLabel>Site information</k.DropdownMenuLabel>
              <p className="px-2 pb-2 text-sm text-muted-foreground">A floating card for a little more detail.</p>
            </div>
          );
          return (
            <>
              <State label="live">
                <k.Popover>
                  <k.PopoverTrigger render={<Button size="sm" variant="outline" />}>Open popover</k.PopoverTrigger>
                  <k.PopoverContent>{body}</k.PopoverContent>
                </k.Popover>
              </State>
              <State label="open">
                <Held className="h-32 w-60">
                  {(box) => (
                    <k.Popover open modal={false}>
                      <k.PopoverTrigger render={<Button size="sm" variant="outline" />}>Open popover</k.PopoverTrigger>
                      <k.PopoverContent container={box} align="start" collisionAvoidance={STILL} initialFocus={false}>
                        {body}
                      </k.PopoverContent>
                    </k.Popover>
                  )}
                </Held>
              </State>
            </>
          );
        }}
      </Compare>
    </Section>
  );
}

const THEMES = [
  { value: "system", label: "System" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light", hint: "Bright surfaces, for daylight" },
] as const;
type ThemeChoice = (typeof THEMES)[number]["value"];

function Selects() {
  return (
    <Section title="Select">
      <Compare name="live · hover · focus · placeholder · with icon · disabled · open (frozen)">
        {(k) => <SelectStates k={k} />}
      </Compare>
    </Section>
  );
}

function SelectStates({ k }: { k: KitSet }) {
  const [theme, setTheme] = useState<ThemeChoice>("dark");
  const select = (props: { open?: boolean; container?: HTMLElement; collisionAvoidance?: typeof STILL; disabled?: boolean }) => (
    <k.Select label="Theme" value={theme} options={THEMES} onChange={setTheme} align="start" {...props} />
  );
  return (
    <>
      <State label="live">{select({})}</State>
      <State label="hover" frozen="hover">
        {select({})}
      </State>
      <State label="focus" frozen="focus">
        {select({})}
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
      <State label="disabled">{select({ disabled: true })}</State>
      <State label="open">
        <Held className="h-44 w-60">{(box) => select({ open: true, container: box, collisionAvoidance: STILL })}</Held>
      </State>
    </>
  );
}

function Dialogs() {
  return (
    <Section title="Dialog · Confirm dialog">
      <Compare name="dialog: live · open (frozen)">
        {(k) => (
          <>
            <State label="live">
              <k.Dialog>
                <k.DialogTrigger render={<Button size="sm" variant="outline" />}>Open dialog</k.DialogTrigger>
                <k.DialogContent>
                  <k.DialogHeader>
                    <k.DialogTitle>Rename session</k.DialogTitle>
                    <k.DialogDescription>Give it a name you'll find again.</k.DialogDescription>
                  </k.DialogHeader>
                  <k.DialogFooter showCloseButton />
                </k.DialogContent>
              </k.Dialog>
            </State>
            <State label="open">
              <Held className="h-44 w-96 overflow-hidden rounded-surface">
                {(box) => (
                  <k.Dialog open modal={false}>
                    <k.DialogContent container={box} initialFocus={false}>
                      <k.DialogHeader>
                        <k.DialogTitle>Rename session</k.DialogTitle>
                        <k.DialogDescription>Give it a name you'll find again.</k.DialogDescription>
                      </k.DialogHeader>
                      <k.DialogFooter showCloseButton />
                    </k.DialogContent>
                  </k.Dialog>
                )}
              </Held>
            </State>
          </>
        )}
      </Compare>
      <Compare name="confirm: live · open · destructive · busy (frozen)">{(k) => <Confirms k={k} />}</Compare>
    </Section>
  );
}

function Confirms({ k }: { k: KitSet }) {
  const [open, setOpen] = useState(false);
  const frozen = (label: string, props: { destructive?: boolean; busy?: boolean }) => (
    <State label={label}>
      <Held className="h-44 w-96 overflow-hidden rounded-surface">
        {(box) => (
          <k.Dialog open modal={false}>
            <k.DialogContent container={box} initialFocus={false}>
              <k.ConfirmForm
                title="Delete this session?"
                description="Its messages and files go too. This can't be undone."
                confirm="Delete"
                onConfirm={() => {}}
                onCancel={() => {}}
                {...props}
              />
            </k.DialogContent>
          </k.Dialog>
        )}
      </Held>
    </State>
  );
  return (
    <>
      <State label="live">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          Ask to delete
        </Button>
        <k.ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="Delete this session?"
          description="Its messages and files go too. This can't be undone."
          confirm="Delete"
          destructive
          onConfirm={() => setOpen(false)}
        />
      </State>
      {frozen("open", {})}
      {frozen("destructive", { destructive: true })}
      {frozen("busy", { destructive: true, busy: true })}
    </>
  );
}

function Toasts() {
  return (
    <Section title="Toast">
      <Compare name="live (shows above the buttons) · neutral · success · error with an action · long (frozen)">
        {(k) => <ToastStates k={k} />}
      </Compare>
    </Section>
  );
}

function ToastStates({ k }: { k: KitSet }) {
  // Frozen toasts never time out; each column keeps its own.
  const [frozen] = useState(() => Toast.createToastManager());
  useEffect(() => {
    const ids = [
      frozen.add({ title: "Archived chat", type: "neutral", timeout: 0, data: { actions: [] } }),
      frozen.add({ title: "Changes reverted", type: "success", timeout: 0, data: { actions: [] } }),
      frozen.add({ title: "Couldn't push", type: "error", timeout: 0, data: { actions: [{ label: "Retry", run: () => {} }] } }),
      frozen.add({
        title: "Couldn't reach the daemon: the socket closed before it answered, so nothing was saved",
        type: "error",
        timeout: 0,
        data: { actions: [] },
      }),
    ];
    return () => ids.forEach((id) => frozen.close(id));
  }, [frozen]);
  return (
    <>
      <State label="live">
        <div className="relative flex h-24 w-80 items-end gap-2">
          <k.Toaster className="top-0" />
          <Button size="xs" variant="outline" onClick={() => k.showToast("Archived chat")}>
            Neutral
          </Button>
          <Button size="xs" variant="outline" onClick={() => k.showToast("Changes reverted", { tone: "success" })}>
            Success
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => k.showToast("Couldn't push", { tone: "error", actions: [{ label: "Retry", run: () => {} }] })}
          >
            Error
          </Button>
        </div>
      </State>
      <State label="frozen">
        <div className="relative h-52 w-96">
          <k.Toaster className="top-0" manager={frozen} />
        </div>
      </State>
    </>
  );
}

function Spinners() {
  return (
    <Section title="Spinner">
      <Compare name="sizes · on a busy button (it stops under Reduce Motion)">
        {() => (
          <>
            {(["size-icon-xs", "size-icon-sm", "size-icon-md", "size-icon-lg"] as const).map((size) => (
              <State key={size} label={size.replace("size-", "")}>
                <Spinner className={`${size} animate-spin motion-reduce:animate-none`} />
              </State>
            ))}
            <State label="busy button">
              <Button size="sm" disabled>
                <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />
                Delete
              </Button>
            </State>
          </>
        )}
      </Compare>
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
      <Toasts />
      <Spinners />
    </>
  );
}
