import { type ReactNode, useEffect, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { RowText } from "../components/settings-card";
import { Skeleton } from "../components/skeleton";
import { ChevronRight, DotsHorizontal, Plus } from "../icons";
import { errorText } from "../onboarding/api";
import { type Entry, inCategory, type Kind, markOf, type Plugins } from "./plugins";
import type { AddFirst } from "./plugins-dialogs";
import { PluginMark } from "./plugins-marks";

/** One search result, as Rust's `plugins browse` says it [D434]: `mark` the address or package its maker's mark may come from, `form` what Add is filled in with, null with `why` where Brigadier can't add it. */
export type Found = {
  key: string;
  kind: Kind;
  name: string;
  description: string;
  publisher: string;
  how: string;
  mark: string;
  /** Its own icon where its source gives one, as Rust fetched it. */
  icon?: string | null;
  in_library: boolean;
  /** Its catalog entry, matched by Rust using the server's normalized address. */
  catalog?: string | null;
  form: { remote: boolean; name: string; url?: string; command?: string; values: string[] } | { source: string; skill: string } | null;
  why: string | null;
};

/** Add filled in from a result, with its mark: straight to the install dialog unless it declares secrets, their values left to the user [D418 D726]. */
function firstOf({ form, mark, icon }: Found & { form: object }): AddFirst {
  if ("source" in form) return { form: { kind: "skill", from: form }, step: "install", mark: { detail: mark, icon } };
  const values = form.values.map((name, id) => ({ id, name, value: "" }));
  return { form: { kind: "server", remote: form.remote, name: form.name, url: form.url ?? "", command: form.command ?? "", values }, step: values.length ? "form" : "install", mark: { detail: mark, icon } };
}

/** A row of Browse's 2 columns: its mark, name and line, opening its page where it has one, then + (or …); `dim` an off item's, its end not. */
export function Pick({ mark, name, line, end, onOpen, dim = false }: { mark: ReactNode; name: ReactNode; line: ReactNode; end: ReactNode; onOpen?: () => void; dim?: boolean }) {
  const text = (
    <>
      {mark}
      <RowText title={name} line={line} truncate />
    </>
  );
  return (
    <div data-slot="pick" className="flex items-center gap-3 rounded-control px-2 py-2.5 hover:bg-fill-subtle">
      {onOpen ? (
        <button type="button" onClick={onOpen} className={cx("flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-start focus-visible:focus-ring", dim && "opacity-disabled")}>
          {text}
        </button>
      ) : (
        text
      )}
      {end}
    </div>
  );
}

/** A catalog entry's row: + installs it; once installed, … opens its page. */
export const entryRow = (entry: Entry, { onOpen, onInstall }: EntryActions) => (
  <Pick
    key={entry.id}
    mark={<PluginMark item={markOf(entry)} />}
    name={entry.name}
    line={entry.line}
    onOpen={() => onOpen(entry)}
    end={
      entry.installed ? (
        <Button variant="ghost" size="icon-md" aria-label={`${entry.name}, installed`} onClick={() => onOpen(entry)}>
          <DotsHorizontal aria-hidden />
        </Button>
      ) : (
        <Button variant="ghost" size="icon-md" aria-label={`Install ${entry.name}`} onClick={() => onInstall(entry)}>
          <Plus aria-hidden />
        </Button>
      )
    }
  />
);
export type EntryActions = { onOpen: (entry: Entry) => void; onInstall: (entry: Entry) => void };

export const PickGrid = ({ children }: { children: ReactNode }) => <div className="grid grid-cols-1 gap-x-6 @reading:grid-cols-2">{children}</div>;

/** A category's title, a link to its own page where it has one, over its rows. */
export function Category({ title, onOpen, children }: { title: string; onOpen?: () => void; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      {onOpen ? (
        <button type="button" onClick={onOpen} className="flex w-fit cursor-pointer items-center gap-1 text-sm font-medium focus-visible:focus-ring">
          {title}
          <ChevronRight aria-hidden className="size-3.5 text-quiet-foreground" />
        </button>
      ) : (
        <h2 className="text-sm font-medium">{title}</h2>
      )}
      {children}
    </section>
  );
}

/**
 * Plugins › Browse [D566, D569]: what installs, by category, 6 of each, empty ones hidden. What the agents have on this
 * machine is installed already [D721].
 */
export function BrowseTab({ value, onEntry, onCategory }: { value: Plugins; onEntry: EntryActions; onCategory: (name: string) => void }) {
  const catalog = value.catalog ?? { categories: [], entries: [] };
  return (
    <>
      {catalog.categories.map((name) => {
        const entries = catalog.entries.filter((each) => inCategory(each, name));
        return (
          entries.length > 0 && (
            <Category key={name} title={name} onOpen={() => onCategory(name)}>
              <PickGrid>{entries.slice(0, 6).map((each) => entryRow(each, onEntry))}</PickGrid>
            </Category>
          )
        );
      })}
    </>
  );
}

/** A name or maker a word of which starts with what's asked: "rea" finds Readwise and realestate.com.au, not Create. */
const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const named = (asked: string, ...texts: string[]) => texts.some((text) => ` ${words(text)}`.includes(` ${words(asked)}`));
const installed = <Badge variant="secondary">Installed</Badge>;
const plus = (name: string, onClick: () => void) => (
  <Button variant="ghost" size="icon-md" aria-label={`Install ${name}`} onClick={onClick}>
    <Plus aria-hidden />
  </Button>
);

/**
 * Plugins' search [D660, D661]: typing hides the tabs (clearing it brings back the one you were on) for one
 * grid of everything matching, the catalog, the library,
 * then the MCP Registry and skills.sh (Rust asks them once typing pauses [D434]), a grid of grey rows until they answer.
 * Each row its mark, name and "maker • line"; what's already in Brigadier says Installed where others have +.
 */
export function SearchResults({
  value,
  asked,
  browse,
  onEntry,
  onOpen,
  onAdd,
}: {
  value: Plugins;
  asked: string;
  browse: (kind: Kind, query: string) => Promise<Found[]>;
  onEntry: EntryActions;
  onOpen: (key: string) => void;
  onAdd: (first: AddFirst, added: () => void) => void;
}) {
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFound(null);
    setError(null);
    let live = true;
    const timer = setTimeout(
      () =>
        void Promise.allSettled((["server", "skill"] as const).map((kind) => browse(kind, asked))).then((answers) => {
          if (!live) return;
          const failed = answers.find((answer) => answer.status === "rejected");
          setError(failed ? errorText(failed.reason) : null);
          setFound(answers.flatMap((answer) => (answer.status === "fulfilled" ? answer.value : [])));
        }),
      300,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [asked]);
  const held = (key: string) => setFound((now) => now && now.map((each) => (each.key === key ? { ...each, in_library: true } : each)));
  if (!found && !error) return <Loading />;
  const entries = (value.catalog?.entries ?? []).filter((each) => named(asked, each.name, each.maker));
  // The library's own, those not shown as their catalog entry.
  const items = value.items.filter((each) => !entries.some((entry) => entry.installed === each.key) && named(asked, each.name));
  // A result the catalog has already, by its address, shows once, as the catalog's.
  const unreviewed = (found ?? []).filter((each) => named(asked, each.name, each.publisher) && !(value.catalog?.entries ?? []).some((entry) => entry.id === each.catalog));
  const rows = [
    ...entries.map((each) => (
      <Pick key={each.id} mark={<PluginMark item={markOf(each)} />} name={each.name} line={`${each.maker} • ${each.line}`} onOpen={() => onEntry.onOpen(each)} end={each.installed ? installed : plus(each.name, () => onEntry.onInstall(each))} />
    )),
    ...items.map((each) => <Pick key={each.key} mark={<PluginMark item={{ ...each, logo: each.catalog }} />} name={each.name} line={each.description || each.detail} onOpen={() => onOpen(each.key)} end={installed} />),
    ...unreviewed.map((each) => (
      <Pick
        key={each.key}
        // Its maker's mark only from its own address or package: anyone can name a server "Linear" [D437].
        mark={<PluginMark item={{ kind: each.kind, name: "", detail: each.mark, icon: each.icon }} exact />}
        name={each.name}
        line={[each.publisher, each.form ? each.description || each.how : each.why].filter(Boolean).join(" • ")}
        end={each.in_library ? installed : each.form && plus(each.name, () => onAdd(firstOf({ ...each, form: each.form! }), () => held(each.key)))}
      />
    )),
  ];
  return (
    <div className="flex flex-col gap-4">
      {rows.length > 0 ? <PickGrid>{rows}</PickGrid> : !error && <p className="py-6 text-center text-label text-quiet-foreground">Nothing matches “{asked}”.</p>}
      <ErrorLine error={error} className="text-center" />
      {unreviewed.length > 0 && <p className="text-xs text-faint-foreground">Results from the MCP Registry and skills.sh aren't reviewed by Brigadier: install only what you trust.</p>}
    </div>
  );
}

/** Grey rows while a search is out: six, in the grid's two columns. */
function Loading() {
  return (
    <div role="status" aria-label="Searching" className="contents">
      <PickGrid>
        {[0, 1, 2, 3, 4, 5].map((at) => (
          <div key={at} className="flex items-center gap-3 px-2 py-2.5">
            <Skeleton className="size-9 shrink-0" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3 w-24" />
              <Skeleton className={at % 3 === 1 ? "h-3 w-56" : "h-3 w-44"} />
            </div>
            <Skeleton className="h-8 w-14 rounded-full" />
          </div>
        ))}
      </PickGrid>
    </div>
  );
}
