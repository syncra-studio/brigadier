import { useEffect, useRef, useState } from "react";

import { cx } from "../components/cx";
import { EmptyState } from "../components/empty-state";
import { Kbd } from "../components/kbd";
import { SettingsCard } from "../components/settings-card";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { KeyboardShortcut, MagnifyingGlassSearch, XCircleFilled } from "../icons";
import { SHORTCUTS, type Shortcut, firesOn, keysOf, recordKeyPress } from "../shortcuts";
import { useSettings } from "./api";
import { SettingsPage } from "./parts";

/** What Settings search finds on the page: every shortcut by its name and line. */
export const SHORTCUTS_ROWS = SHORTCUTS.map((shortcut) => ({ label: shortcut.name, description: shortcut.line }));

/** The search: words typed, a key press recorded, or recording one now. */
type Search = { type: "words"; words: string } | { type: "press"; press: string } | { type: "recording" };

/** ⌘⏎ does what the follow-up setting doesn't: steer by default, queue where Settings makes steering the default. */
const QUEUE = { name: "Queue", line: "While an answer works, send the message to wait its turn" };

const findsWords = (shortcut: Shortcut, words: string[]) => {
  const text = `${shortcut.name} ${shortcut.line} ${shortcut.where ?? ""}`.toLowerCase();
  return words.every((word) => text.includes(word));
};

/**
 * Settings › Keyboard shortcuts, the old app's [D2013]: every shortcut in one card, each with what it does (and
 * where, when another place gives its keys to something else) and its keys. The search finds them by words, or by
 * keystrokes: the keyboard button records the next press (Esc cancels) and shows what it does.
 */
export function ShortcutsPage() {
  const [search, setSearch] = useState<Search>({ type: "words", words: "" });
  const field = useRef<HTMLInputElement>(null);
  const steers = useSettings().value?.follow_up === "steer";
  const all = SHORTCUTS.map((shortcut) => (steers && shortcut.id === "follow-up-other" ? { ...shortcut, ...QUEUE } : shortcut));
  const shown =
    search.type === "press"
      ? all.filter((shortcut) => firesOn(shortcut.id, search.press))
      : search.type === "words"
        ? all.filter((shortcut) => findsWords(shortcut, search.words.toLowerCase().split(/\s+/).filter(Boolean)))
        : all;

  // Recording owns the keyboard until a key is pressed, Esc, or the page goes.
  const recording = search.type === "recording";
  useEffect(() => {
    if (!recording) return;
    return recordKeyPress((press) => setSearch(press ? { type: "press", press } : { type: "words", words: "" }));
  }, [recording]);

  const clear = () => {
    setSearch({ type: "words", words: "" });
    requestAnimationFrame(() => field.current?.focus());
  };

  return (
    <SettingsPage title="Keyboard shortcuts">
      <div className="flex flex-col gap-6">
        <div
          data-slot="settings-search"
          className={cx(
            "flex h-control-md min-w-0 items-center gap-2 rounded-capsule border bg-fill px-2.5 has-focus-visible:focus-ring",
            recording ? "border-ring" : "border-fill-active",
          )}
        >
          <MagnifyingGlassSearch aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
          {search.type === "recording" ? (
            <span role="status" className="min-w-0 flex-1 truncate text-sm text-quiet-foreground">
              Press a shortcut… Esc cancels.
            </span>
          ) : search.type === "press" ? (
            <span className="flex min-w-0 flex-1 items-center gap-2 text-sm text-quiet-foreground">
              <Kbd variant="chip">{search.press}</Kbd>
            </span>
          ) : (
            <input
              ref={field}
              value={search.words}
              placeholder="Search shortcuts"
              aria-label="Search shortcuts"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 cursor-text bg-transparent text-sm outline-none placeholder:text-faint-foreground"
              onChange={(event) => setSearch({ type: "words", words: event.target.value })}
              onKeyDown={(event) => {
                if (event.key !== "Escape" || !search.words) return;
                event.stopPropagation();
                setSearch({ type: "words", words: "" });
              }}
            />
          )}
          {((search.type === "words" && search.words) || search.type === "press") && (
            <button
              type="button"
              aria-label="Clear search"
              className="flex shrink-0 cursor-pointer items-center rounded-capsule text-faint-foreground hover:text-foreground focus-visible:focus-ring"
              onClick={clear}
            >
              <XCircleFilled className="size-icon-sm" />
            </button>
          )}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Search by keystrokes"
                  aria-pressed={recording}
                  className={cx(
                    "flex shrink-0 cursor-pointer items-center rounded-xs hover:text-foreground focus-visible:focus-ring",
                    recording ? "text-foreground" : "text-quiet-foreground",
                  )}
                  onClick={() => setSearch(recording ? { type: "words", words: "" } : { type: "recording" })}
                />
              }
            >
              <KeyboardShortcut className="size-icon-md" />
            </TooltipTrigger>
            <TooltipContent>Search by keystrokes</TooltipContent>
          </Tooltip>
        </div>
        {shown.length > 0 ? (
          <SettingsCard>
            {shown.map((shortcut) => (
              <ShortcutRow key={shortcut.id} shortcut={shortcut} />
            ))}
          </SettingsCard>
        ) : (
          <EmptyState variant="centered" title="No shortcuts match" />
        )}
      </div>
    </SettingsPage>
  );
}

function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
  return (
    <div data-slot="shortcut-row" data-setting={shortcut.name} className="grid grid-cols-2 items-center gap-6 px-4 py-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <div className="text-label font-medium break-words">{shortcut.name}</div>
        <div className="text-xs break-words text-quiet-foreground">
          {shortcut.where && `${shortcut.where} · `}
          {shortcut.line}
        </div>
      </div>
      <div className="flex flex-col items-start gap-1.5 text-quiet-foreground">
        {keysOf(shortcut.id).map((keys) => (
          <Kbd key={keys} variant="chip">
            {keys}
          </Kbd>
        ))}
      </div>
    </div>
  );
}
