import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { LexicalTypeaheadMenuPlugin, MenuOption, type MenuRenderFn, type MenuTextMatch } from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $createTextNode, $isTextNode, COMMAND_PRIORITY_HIGH, type LexicalNode, type TextNode } from "lexical";
import { type ComponentProps, type ReactNode, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { Paperclip } from "../../icons";
import { cx } from "../cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger, itemClasses, MenuRow, menuSurface } from "../menu";
import { MentionIcon } from "./attachments";
import { ChipNode } from "./chip";
import { PlusButton } from "./composer";

/** A row of the `@` menu: what a mention names. `label` is what its chip keeps (a path, a chat's title). PROPOSED. */
export type Mention = {
  id: string;
  type: "file" | "folder" | "chat";
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

/** What the `@` menu shows: Rust's results for the typed query, asked for as it changes (null: the menu closed). */
export type Mentions = { groups: MentionGroup[]; onQuery: (query: string | null) => void };

/** A command of the `/` menu, from the agent's adapter. PROPOSED. */
export type SlashCommand = {
  id: string;
  label: string;
  description?: string;
  /** A heading it's listed under ("Skills"); ungrouped ones come first. */
  group?: string;
  icon?: ReactNode;
  hint?: string;
  disabled?: boolean;
  /** What picking it types where the `/` was (an agent's "/review"), the rest kept; without it, it runs. */
  text?: string;
};

export type Commands = { commands: SlashCommand[]; onRun: (command: SlashCommand) => void };

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

/** Commands matching `query`, best first within each group, the groups kept in order so no heading repeats. */
function commandMatches(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const groups = [...new Set(commands.map((command) => command.group))];
  const rank = (command: SlashCommand) => Math.min(fuzzyMatch(command.label, query)?.rank ?? 3, fuzzyMatch(command.id, query)?.rank ?? 3);
  return commands
    .map((command) => ({ command, rank: rank(command) }))
    .filter(({ rank }) => rank < 3)
    .toSorted((a, b) => groups.indexOf(a.command.group) - groups.indexOf(b.command.group) || a.rank - b.rank)
    .map(({ command }) => command);
}

/** A row's name, what the query matched in full white and the rest dimmed. */
export function MatchedText({ text, query }: { text: string; query: string }) {
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
    <span key={each.from} className={each.hit ? "text-foreground" : "text-muted-foreground"}>
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
 */
export function ComposerMenu({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div
      data-slot="composer-menu"
      role="listbox"
      aria-label={label}
      className={cx(menuSurface, "absolute start-0 bottom-full mb-2 flex max-h-command-list w-full flex-col overflow-y-auto")}
    >
      {children}
    </div>
  );
}

function Panel(props: { label: string; children: ReactNode }) {
  const [editor] = useLexicalComposerContext();
  const card = editor.getRootElement()?.closest("[data-slot=composer-card]");
  return card ? createPortal(<ComposerMenu {...props} />, card) : null;
}

export const MenuHeading = ({ children }: { children: ReactNode }) => <p className="px-2 pt-2 pb-1 text-sm text-muted-foreground">{children}</p>;
export const MenuNote = ({ children }: { children: ReactNode }) => <p className="px-2 py-1 text-sm text-muted-foreground">{children}</p>;

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
      selected={props.selectedIndex === index}
      disabled={disabled}
      onMouseEnter={() => props.setHighlightedIndex(index)}
      onClick={() => props.selectOptionAndCleanUp(option)}
    >
      {children}
    </ComposerMenuOption>
  );
}

/** The `@` menu: Rust's groups for the query, each row an icon, the matched name, a grey detail; picked, a chip. */
export function MentionPlugin({ groups, onQuery }: Mentions) {
  const [query, setQuery] = useState("");
  const options = useMemo(() => groups.flatMap((group) => group.items.map((item) => new Row(item, `${group.title}:${item.id}`))), [groups]);
  return (
    <LexicalTypeaheadMenuPlugin<Row<Mention>>
      triggerFn={AT}
      commandPriority={COMMAND_PRIORITY_HIGH}
      options={options}
      onQueryChange={(next) => {
        setQuery(next ?? "");
        onQuery(next);
      }}
      onClose={() => onQuery(null)}
      onSelectOption={(option, replacing, close) => {
        const { id, type, label } = option.value;
        $putWithSpace(new ChipNode({ kind: "mention", id, type, label }), replacing);
        close();
      }}
      menuRenderFn={(_, props) => {
        let at = 0;
        const empty = options.length === 0 && !groups.some((group) => group.note);
        return (
          <Panel label="Mentions">
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
                        <MenuRow
                          icon={<MentionIcon type={item.type} label={item.label} />}
                          title={<MatchedText text={item.name ?? item.label} query={query} />}
                          detail={item.detail}
                          hint={item.hint}
                          mono
                        />
                      </OptionRow>
                    );
                  })}
                  {group.note && <MenuNote>{group.note}</MenuNote>}
                </div>
              );
            })}
            {empty && <MenuNote>No results</MenuNote>}
          </Panel>
        );
      }}
    />
  );
}

/**
 * The `/` menu: the agent's commands under their group headings, filtered as typed. A command with `text` types
 * it in place of the `/` and its query; any other runs (`onRun`) and leaves no trace in the text.
 */
export function SlashPlugin({ commands, onRun }: Commands) {
  const [query, setQuery] = useState("");
  const options = useMemo(() => commandMatches(commands, query).map((command) => new Row(command, command.id)), [commands, query]);
  return (
    <LexicalTypeaheadMenuPlugin<Row<SlashCommand>>
      triggerFn={SLASH}
      commandPriority={COMMAND_PRIORITY_HIGH}
      options={options}
      onQueryChange={(next) => setQuery(next ?? "")}
      onSelectOption={(option, replacing, close) => {
        const command = option.value;
        if (command.disabled) return;
        if (command.text !== undefined) $putWithSpace($createTextNode(command.text), replacing);
        else {
          replacing?.remove();
          // After the pick's update, so the command sees the text without its `/`.
          queueMicrotask(() => onRun(command));
        }
        close();
      }}
      menuRenderFn={(_, props) => (
        <Panel label="Slash commands">
          {props.options.map((option, index) => {
            const command = option.value;
            const group = command.group ?? null;
            const previous = props.options[index - 1]?.value.group ?? null;
            return (
              <div key={option.key} className="contents">
                {group && group !== previous && <MenuHeading>{group}</MenuHeading>}
                <OptionRow option={option} index={index} props={props} disabled={command.disabled}>
                  <MenuRow icon={command.icon} title={<MatchedText text={command.label} query={query} />} detail={command.description} hint={command.hint} />
                </OptionRow>
              </div>
            );
          })}
          {props.options.length === 0 && <MenuNote>No commands</MenuNote>}
        </Panel>
      )}
    />
  );
}

/**
 * The + ("Add files and more"): a menu as wide as the composer card, just above it (over the rail, hidden
 * meanwhile), "Add" then Files, which opens the system's file picker. Closed, the keyboard goes back to typing.
 */
export function PlusMenu({ onFiles }: { onFiles: (files: File[]) => void }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [card, setCard] = useState<HTMLElement | null>(null);
  const field = () => card?.querySelector<HTMLElement>("[contenteditable]") ?? null;
  return (
    <>
      <DropdownMenu onOpenChange={(open) => setCard(open ? (trigger.current?.closest<HTMLElement>("[data-slot=composer-card]") ?? null) : card)}>
        <DropdownMenuTrigger render={<PlusButton ref={trigger} data-slot="plus-trigger" />} />
        <DropdownMenuContent side="top" align="start" anchor={card} className="max-h-command-list w-anchor" finalFocus={() => field() ?? true}>
          <DropdownMenuLabel variant="heading">Add</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => input.current?.click()}>
            <MenuRow icon={<Paperclip />} title="Files" />
          </DropdownMenuItem>
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
