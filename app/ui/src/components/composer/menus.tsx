import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalTypeaheadMenuPlugin, MenuOption, type MenuRenderFn, type MenuTextMatch } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $createTextNode, $isTextNode, COMMAND_PRIORITY_HIGH, type LexicalNode, type TextNode } from "lexical";
import { type ComponentProps, type ReactNode, type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Paperclip } from "../../icons";
import { cx } from "../cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, itemClasses, MenuRow } from "../menu";
import type { ComposerFieldHandle } from "./field";
import { CommandKindIcon, MentionKindIcon } from "./kind-icons";
import { ChipNode } from "./chip";
import type { Chip } from "./draft";
import { PlusButton } from "./composer";
import { ToolIcon } from "./tools";

/**
 * A row of the `@` menu: what a mention names. `label` is what its chip keeps (a path, a chat's title, a worker's
 * name). A `direct` row is no mention: picking it sends the next message to that worker alone. PROPOSED.
 */
export type Mention = {
  id: string;
  type: "file" | "folder" | "chat" | "worker" | "direct" | "tab" | "note";
  label: string;
  /** The row's name, when it isn't the label (a file's name for its path). */
  name?: string;
  /** Grey text after the name (a file's folder). */
  detail?: string;
  /** Grey text at the row's end. */
  hint?: string;
};

/** A part of the `@` menu: its heading (none for ranked results), rows and a grey note under them. PROPOSED. */
export type MentionGroup = { title: string | null; items: Mention[]; note?: string };

/**
 * What the `@` menu shows: Rust's latest reply, echoing the query it answers, asked for as the query changes
 * (`onQuery(null)`: the menu closed). A reply to an older query is dropped; the last current one stays.
 */
export type Mentions = {
  results: { query: string; groups: MentionGroup[] } | null;
  onQuery: (query: string | null) => void;
  /** A "Message directly" row was picked: the next message goes to that worker. */
  onDirect?: (worker: string) => void;
};

/** A command of the `/` menu, from the agent's adapter. PROPOSED. */
export type SlashCommand = {
  id: string;
  label: string;
  description?: string;
  /** Listed under its kind's heading: Commands, Tools, Skills, MCP prompts. A tool is Brigadier's own (./tools.tsx). */
  kind: "command" | "tool" | "skill" | "mcp";
  /** Where it comes from (an MCP server's name, a skill's folder), for opening it. */
  source?: string;
  /** Its own icon from Rust: an SVG mark or a same-origin image; without one, its kind's. */
  icon?: string | null;
  hint?: string;
  disabled?: boolean;
  /** Runs at once when picked (/compact); otherwise picking types its `label` where the `/` was, the rest kept. */
  instant: boolean;
};

/** `commands` null: not listed yet (the menu says it's loading, never "No commands"). */
export type Commands = { commands: SlashCommand[] | null; onRun: (command: SlashCommand) => void };

/**
 * Where `query` matches `text`, as the menus match: at its start, anywhere in it, or letter by letter in order.
 * The matched letters' positions and how good the match is (0 start, 1 anywhere, 2 in order); null: no match.
 */
export function fuzzyMatch(text: string, query: string): { rank: 0 | 1 | 2; at: number[] } | null {
  const lower = text.toLowerCase();
  const want = query.toLowerCase();
  const run = (from: number) => Array.from(want, (_, index) => from + index);
  if (lower.startsWith(want)) return { rank: 0, at: run(0) };
  const inside = lower.indexOf(want);
  if (inside >= 0) return { rank: 1, at: run(inside) };
  const at: number[] = [];
  let from = 0;
  for (const letter of want) {
    const found = lower.indexOf(letter, from);
    if (found < 0) return null;
    at.push(found);
    from = found + 1;
  }
  return { rank: 2, at };
}

/** Commands matching `query`, best first within each kind, the kinds in order so no heading repeats. */
function commandMatches(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const order = { command: 0, tool: 1, skill: 2, mcp: 3 };
  const rank = (command: SlashCommand) => Math.min(fuzzyMatch(command.label, query)?.rank ?? 3, fuzzyMatch(command.id, query)?.rank ?? 3);
  return commands
    .map((command) => ({ command, rank: rank(command) }))
    .filter(({ rank }) => rank < 3)
    .toSorted((a, b) => order[a.command.kind] - order[b.command.kind] || a.rank - b.rank)
    .map(({ command }) => command);
}

/** A row's name in white, the letters the query matched in bold (`hit`: their class, a model chip's also bright). */
export function MatchedText({ text, query, hit: hitClass = "font-semibold" }: { text: string; query: string; hit?: string }) {
  const match = query ? fuzzyMatch(text, query) : null;
  if (!match) return text;
  const hit = new Set(match.at);
  const runs: { from: number; text: string; hit: boolean }[] = [];
  Array.from(text).forEach((letter, index) => {
    const last = runs.at(-1);
    if (last && last.hit === hit.has(index)) last.text += letter;
    else runs.push({ from: index, text: letter, hit: hit.has(index) });
  });
  return runs.map((each) => (
    <span key={each.from} className={cx(each.hit && hitClass)}>
      {each.text}
    </span>
  ));
}

/**
 * `@` or `/` opens its menu where a word starts (at a line's start or after a space), never inside a word (a
 * path like `src/a`, an address); a space closes it.
 */
const wordTrigger =
  (char: string) =>
  (text: string): MenuTextMatch | null => {
    const word = /\S*$/u.exec(text)?.[0] ?? "";
    if (!word.startsWith(char)) return null;
    return { leadOffset: text.length - word.length, matchingString: word.slice(char.length), replaceableString: word };
  };
const AT = wordTrigger("@");
const SLASH = wordTrigger("/");

class Row<T> extends MenuOption {
  constructor(
    readonly value: T,
    key: string,
  ) {
    super(key);
  }
}

/** `node` in the text, then a space after it unless one follows, the caret after that. */
function $putWithSpace(node: LexicalNode, replacing: TextNode | null): void {
  if (replacing) replacing.replace(node);
  const next = node.getNextSibling();
  if ($isTextNode(next) && /^\s/.test(next.getTextContent())) {
    next.select(1, 1);
    return;
  }
  const space = $createTextNode(" ");
  node.insertAfter(space);
  space.select(1, 1);
}

/**
 * The `@` and `/` menus' panel: inside the composer card, as wide as it and just above it (over the rail,
 * hidden meanwhile); it scrolls past 10.5 rows. Headings and notes are `MenuHeading` and `MenuNote`.
 * The look [D332]: opaque in a hairline, 4px above the card, rows scrolling inside its 4px gutter, never cut.
 */
export function ComposerMenu({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div
      data-slot="composer-menu"
      // Unlabelled inside Lexical's anchor, which is the listbox the field's aria-controls names.
      role={label ? "listbox" : undefined}
      aria-label={label}
      className="absolute start-0 bottom-full z-popup mb-1 flex max-h-command-list w-full flex-col overflow-hidden rounded-menu border border-border bg-popover p-1 text-foreground outline-none"
    >
      <div data-slot="composer-menu-list" className="flex min-h-0 flex-col overflow-y-auto">{children}</div>
    </div>
  );
}

/** Waiting longer than a moment: a reply that comes within it shows with nothing drawn before it, as the file viewer's [D1310, D2109]. */
function useSlow(waiting: boolean): boolean {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    setSlow(false);
    if (!waiting) return;
    const timer = setTimeout(() => setSlow(true), 150);
    return () => clearTimeout(timer);
  }, [waiting]);
  return slow;
}

/** The composer card the field is in, once it's in the page: Lexical's menu anchor goes there. */
function useCard(): HTMLElement | null {
  const [editor] = useLexicalComposerContext();
  const [card, setCard] = useState<HTMLElement | null>(null);
  useEffect(() => editor.registerRootListener((root) => setCard(root?.closest<HTMLElement>("[data-slot=composer-card]") ?? null)), [editor]);
  // Lexical mounts its menu's empty role=listbox at once and adds it back on open: left in, it reads as an open menu to everything that yields to one (Esc Esc, a card's keys).
  useLayoutEffect(() => card?.querySelectorAll(":scope > [role=listbox]:empty").forEach((anchor) => anchor.remove()), [card]);
  return card;
}

/**
 * The panel, in Lexical's anchor (the listbox its `#typeahead-menu` scroll helper and aria-controls expect). The
 * anchor is `display: contents` in the card, so the panel sits by the card, not at the caret Lexical places it.
 */
function Panel({ anchor, children }: { anchor: RefObject<HTMLElement | null>; children: ReactNode }) {
  return anchor.current ? createPortal(<ComposerMenu>{children}</ComposerMenu>, anchor.current) : null;
}
const ANCHOR = "contents!";

// The rows' size, 8px above a heading and 4px under it, 4px above the list's first [D332].
export const MenuHeading = ({ children }: { children: ReactNode }) => <p className="px-2 pt-2 pb-1 text-label text-muted-foreground list-top:pt-1">{children}</p>;
export const MenuNote = ({ children }: { children: ReactNode }) => <p className="flex min-h-menu-item items-center px-2 text-label text-muted-foreground">{children}</p>;

export const KIND_HEADINGS = { command: "Commands", tool: "Tools", skill: "Skills", mcp: "MCP prompts" } as const;

/** A mention's row: its kind's icon, the name (matched letters bright), its folder in grey after it; a chat, tagged. */
export function MentionRow({ item, query }: { item: Mention; query: string }) {
  return (
    <MenuRow
      icon={<MentionKindIcon type={item.type} id={item.id} label={item.label} />}
      title={<MatchedText text={item.name ?? item.label} query={query} />}
      detail={item.detail}
      hint={item.type === "chat" ? "Chat" : item.hint}
      mono={item.type === "worker"}
    />
  );
}

/** A command's row: its icon, the name, its line in grey after it. */
export function CommandRow({ command, query }: { command: SlashCommand; query: string }) {
  return (
    <MenuRow
      icon={command.kind === "tool" ? <ToolIcon id={command.id} /> : <CommandKindIcon kind={command.kind} icon={command.icon} />}
      title={<MatchedText text={command.label} query={query} />}
      detail={command.description}
      hint={command.hint}
    />
  );
}

/** One of a composer menu's rows, its content a `MenuRow`; highlighted by the keys or the pointer. */
export function ComposerMenuOption({ selected, disabled, className, ...props }: ComponentProps<"div"> & { selected: boolean; disabled?: boolean }) {
  return (
    <div
      role="option"
      aria-selected={selected}
      aria-disabled={disabled || undefined}
      data-highlighted={selected || undefined}
      data-disabled={disabled || undefined}
      // A click picks it without the field losing the keyboard.
      onMouseDown={(event) => event.preventDefault()}
      className={cx(itemClasses, "w-full shrink-0 text-start", className)}
      {...props}
    />
  );
}

/** Where the pointer last moved over a menu row. */
const pointer = { x: -1, y: -1 };

/** One option row: highlighted by the keys or the pointer, picked by a click without the field losing focus. */
function OptionRow<T>({
  option,
  index,
  props,
  disabled,
  children,
}: {
  option: Row<T>;
  index: number;
  props: Parameters<MenuRenderFn<Row<T>>>[1];
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <ComposerMenuOption
      ref={(element) => option.setRefElement(element)}
      // The id Lexical's aria-activedescendant names.
      id={`typeahead-item-${index}`}
      selected={props.selectedIndex === index}
      disabled={disabled}
      // A move, as the old app's rows, and a real one: a list scrolled by the arrows under a still pointer keeps the
      // arrows' row, though the browser says the pointer moved onto another [D2105].
      onMouseMove={(event) => {
        if (event.clientX === pointer.x && event.clientY === pointer.y) return;
        Object.assign(pointer, { x: event.clientX, y: event.clientY });
        if (props.selectedIndex !== index) props.setHighlightedIndex(index);
      }}
      onClick={() => props.selectOptionAndCleanUp(option)}
    >
      {children}
    </ComposerMenuOption>
  );
}

/** The `@` menu: Rust's groups for the query, each row an icon, the matched name, a grey detail; picked, a chip. */
export function MentionPlugin({ results, onQuery, onDirect }: Mentions) {
  const [query, setQuery] = useState("");
  // The last reply to the query as typed: one to an older query never shows.
  const kept = useRef<MentionGroup[]>([]);
  const answered = results?.query === query;
  if (answered) kept.current = results.groups;
  const groups = kept.current;
  const options = useMemo(() => groups.flatMap((group) => group.items.map((item) => new Row(item, `${group.title}:${item.id}`))), [groups]);
  const empty = options.length === 0 && !groups.some((group) => group.note);
  const [open, setOpen] = useState(false);
  const slow = useSlow(open && empty && !answered);
  const card = useCard();
  if (!card) return null;
  return (
    <LexicalTypeaheadMenuPlugin<Row<Mention>>
      parent={card}
      anchorClassName={ANCHOR}
      triggerFn={AT}
      commandPriority={COMMAND_PRIORITY_HIGH}
      options={options}
      onQueryChange={(next) => {
        setQuery(next ?? "");
        onQuery(next);
      }}
      onOpen={() => setOpen(true)}
      onClose={() => {
        kept.current = [];
        setOpen(false);
        onQuery(null);
      }}
      onSelectOption={(option, replacing, close) => {
        const { id, type, label } = option.value;
        // Message directly leaves no mention in the text: only the To: chip.
        if (type === "direct") {
          replacing?.remove();
          onDirect?.(id);
        } else $putWithSpace(new ChipNode({ kind: "mention", id, type, label }), replacing);
        close();
      }}
      menuRenderFn={(anchor, props) => {
        let at = 0;
        if (empty && !answered && !slow) return null;
        return (
          <Panel anchor={anchor}>
            {groups.map((group, index) => {
              if (group.items.length === 0 && !group.note) return null;
              return (
                <div key={group.title ?? `results-${index}`} className="contents">
                  {group.title && <MenuHeading>{group.title}</MenuHeading>}
                  {group.items.map((item) => {
                    const row = at++;
                    const option = props.options[row]!;
                    return (
                      <OptionRow key={option.key} option={option} index={row} props={props}>
                        <MentionRow item={item} query={query} />
                      </OptionRow>
                    );
                  })}
                  {group.note && <MenuNote>{group.note}</MenuNote>}
                </div>
              );
            })}
            {/* Until the first reply to the query comes, the last rows stay; with none yet, it's searching. */}
            {empty && <MenuNote>{answered ? "No results" : "Searching…"}</MenuNote>}
          </Panel>
        );
      }}
    />
  );
}

/**
 * The `/` menu: the agent's commands under their group headings, filtered as typed. One not `instant` goes in as its
 * own chip (a tool's, not a skill's of its name) for the `/` and its query; any other runs (`onRun`), leaving no trace.
 */
export function SlashPlugin({ commands, onRun }: Commands) {
  const [query, setQuery] = useState("");
  const options = useMemo(() => commandMatches(commands ?? [], query).map((command) => new Row(command, command.id)), [commands, query]);
  const [open, setOpen] = useState(false);
  const slow = useSlow(open && commands === null);
  const card = useCard();
  if (!card) return null;
  return (
    <LexicalTypeaheadMenuPlugin<Row<SlashCommand>>
      parent={card}
      anchorClassName={ANCHOR}
      triggerFn={SLASH}
      commandPriority={COMMAND_PRIORITY_HIGH}
      options={options}
      onQueryChange={(next) => setQuery(next ?? "")}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      onSelectOption={(option, replacing, close) => {
        const command = option.value;
        if (command.disabled) return;
        if (!command.instant) $putWithSpace(new ChipNode({ kind: "command", id: command.id, type: command.kind, label: command.label }), replacing);
        else {
          replacing?.remove();
          // After the pick's update, so the command sees the text without its `/`.
          queueMicrotask(() => onRun(command));
        }
        close();
      }}
      menuRenderFn={(anchor, props) =>
        commands === null && !slow ? null : (
          <Panel anchor={anchor}>
            {props.options.map((option, index) => {
              const command = option.value;
              const group = KIND_HEADINGS[command.kind];
              const previous = index > 0 ? KIND_HEADINGS[props.options[index - 1]!.value.kind] : null;
              return (
                <div key={option.key} className="contents">
                  {group && group !== previous && <MenuHeading>{group}</MenuHeading>}
                  <OptionRow option={option} index={index} props={props} disabled={command.disabled}>
                    <CommandRow command={command} query={query} />
                  </OptionRow>
                </div>
              );
            })}
            {props.options.length === 0 && <MenuNote>{commands ? "No commands" : "Loading…"}</MenuNote>}
          </Panel>
        )
      }
    />
  );
}

/** The chats the + lists, as the old app's menu kept them to a few. */
const CHAT_ROWS = 5;

/**
 * The + ("Add files and more"): a menu as wide as the composer card, just above it (over the rail, hidden
 * meanwhile): "Add" then Files, which opens the system's file picker, then the `/` menu's tools, skills and MCP prompts
 * and the `@` menu's chats in their own rows, each picked into the end of the text. Closed, the keyboard goes
 * back to typing.
 */
export function PlusMenu({
  onFiles,
  field: composerField,
  commands,
  chats,
}: {
  onFiles: (files: File[]) => void;
  field: RefObject<ComposerFieldHandle | null>;
  commands: Commands;
  chats: readonly Mention[];
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [card, setCard] = useState<HTMLElement | null>(null);
  const field = () => card?.querySelector<HTMLElement>("[contenteditable]") ?? null;
  const add = (chip: Chip) => {
    const parts = composerField.current!.parts();
    const last = parts.at(-1);
    const apart = last !== undefined && !(typeof last === "string" && /\s$/.test(last));
    composerField.current!.set([...parts, ...(apart ? [" "] : []), chip, " "]);
  };
  const kind = (wanted: "tool" | "skill" | "mcp") => {
    const listed = commands.commands?.filter((command) => command.kind === wanted) ?? [];
    return (
      listed.length > 0 && (
        <>
          <DropdownMenuLabel variant="heading">{KIND_HEADINGS[wanted]}</DropdownMenuLabel>
          {listed.map((command) => (
            <DropdownMenuItem
              key={command.id}
              disabled={command.disabled}
              onClick={() => (command.instant ? commands.onRun(command) : add({ kind: "command", id: command.id, type: command.kind, label: command.label }))}
            >
              <CommandRow command={command} query="" />
            </DropdownMenuItem>
          ))}
        </>
      )
    );
  };
  return (
    <>
      <DropdownMenu onOpenChange={(open) => setCard(open ? (trigger.current?.closest<HTMLElement>("[data-slot=composer-card]") ?? null) : card)}>
        <DropdownMenuTrigger render={<PlusButton ref={trigger} data-slot="plus-trigger" />} />
        <DropdownMenuContent side="top" align="start" anchor={card} className="max-h-command-list w-anchor" finalFocus={() => field() ?? true}>
          <DropdownMenuLabel variant="heading">Add</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => input.current?.click()}>
            <MenuRow icon={<Paperclip />} title="Files" />
          </DropdownMenuItem>
          {kind("tool")}
          {kind("skill")}
          {kind("mcp")}
          {chats.length > 0 && <DropdownMenuLabel variant="heading">Chats</DropdownMenuLabel>}
          {chats.slice(0, CHAT_ROWS).map((chat) => (
            <DropdownMenuItem key={chat.id} onClick={() => add({ kind: "mention", id: chat.id, type: "chat", label: chat.label })}>
              <MentionRow item={chat} query="" />
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          if (files.length > 0) onFiles(files);
        }}
      />
    </>
  );
}
