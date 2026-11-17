import { type ReactNode, useEffect, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { RowText, SettingsCard } from "../components/settings-card";
import { ChevronRight, DotsHorizontal, Plus } from "../icons";
import { errorText } from "../onboarding/api";
import { SettingsSection } from "./parts";
import { type Entry, inCategory, type Kind, markOf, matches, type Own, type Plugins } from "./plugins";
import { importable } from "./plugins-mine";
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
  in_library: boolean;
  form: { remote: boolean; name: string; url?: string; command?: string; values: string[] } | { source: string; skill: string } | null;
  why: string | null;
};

const SOURCE: Record<Kind, string> = { server: "From the MCP Registry", skill: "From skills.sh" };

/** Add filled in from a result: a server's form, its declared secrets' names with their values left to the user; a skill added at once [D418, D436]. */
function firstOf(form: NonNullable<Found["form"]>): AddFirst {
  if ("source" in form) return { form: { kind: "skill", from: form }, step: "adding", start: true };
  const values = form.values.map((name, id) => ({ id, name, value: "" }));
  return { form: { kind: "server", remote: form.remote, name: form.name, url: form.url ?? "", command: form.command ?? "", values } };
}

/** A row of Browse's 2 columns: its mark, name and line, opening its page where it has one, then + (or …). */
export function Pick({ mark, name, line, end, onOpen }: { mark: ReactNode; name: string; line: string; end: ReactNode; onOpen?: () => void }) {
  const text = (
    <>
      {mark}
      <RowText title={name} line={line} truncate />
    </>
  );
  return (
    <div data-slot="pick" className="flex items-center gap-3 rounded-control px-2 py-2.5 hover:bg-fill-subtle">
      {onOpen ? (
        <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-start focus-visible:focus-ring">
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

const ownRow = (own: Own, onInstall: (own: Own) => void) => (
  <Pick
    key={own.key}
    mark={<PluginMark item={own} />}
    name={own.name}
    line={own.from}
    end={
      <Button variant="ghost" size="icon-md" aria-label={`Install ${own.name}`} onClick={() => onInstall(own)}>
        <Plus aria-hidden />
      </Button>
    }
  />
);

/**
 * Plugins › Browse [D566, D569]: what installs, by category, "Found on this machine" first (your agents' own, not yet in
 * Brigadier), then the catalog's, 6 of each, empty ones hidden; a search looks through them, then the Official MCP
 * Registry and skills.sh (Rust asks them [D434]).
 */
export function BrowseTab({
  value,
  query,
  remote,
  browse,
  onEntry,
  onCategory,
  onInstall,
  onAdd,
}: {
  value: Plugins;
  query: string;
  remote: boolean;
  browse: (kind: Kind, query: string) => Promise<Found[]>;
  onEntry: EntryActions;
  onCategory: (name: string) => void;
  onInstall: (own: Own) => void;
  onAdd: (first: AddFirst, added: () => void) => void;
}) {
  const asked = query.trim();
  const own = value.own.filter((each) => importable(each, remote));
  const catalog = value.catalog ?? { categories: [], entries: [] };
  if (asked) {
    const entries = catalog.entries.filter((each) => matches(asked, each.name, each.line, each.maker, each.category));
    return <Search asked={asked} own={own.filter((each) => matches(asked, each.name, each.detail, each.from))} entries={entries} onEntry={onEntry} browse={browse} onInstall={onInstall} onAdd={onAdd} />;
  }
  return (
    <>
      {own.length > 0 && (
        <Category title="Found on this machine">
          <PickGrid>{own.map((each) => ownRow(each, onInstall))}</PickGrid>
        </Category>
      )}
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

function Search({ asked, own, entries, onEntry, browse, onInstall, onAdd }: { asked: string; own: Own[]; entries: Entry[]; onEntry: EntryActions; browse: (kind: Kind, query: string) => Promise<Found[]>; onInstall: (own: Own) => void; onAdd: (first: AddFirst, added: () => void) => void }) {
  return (
    <>
      {(own.length > 0 || entries.length > 0) && (
        <PickGrid>
          {entries.map((each) => entryRow(each, onEntry))}
          {own.map((each) => ownRow(each, onInstall))}
        </PickGrid>
      )}
      {(["server", "skill"] as const).map((kind) => (
        <Results key={kind} kind={kind} asked={asked} browse={browse} onAdd={onAdd} />
      ))}
    </>
  );
}

/** One source's results, asked once typing pauses; an older answer never replaces a newer one. */
function Results({ kind, asked, browse, onAdd }: { kind: Kind; asked: string; browse: (kind: Kind, query: string) => Promise<Found[]>; onAdd: (first: AddFirst, added: () => void) => void }) {
  const [found, setFound] = useState<Found[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setFound(null);
    setError(null);
    let live = true;
    const timer = setTimeout(
      () =>
        browse(kind, asked).then(
          (next) => live && setFound(next),
          (cause: unknown) => live && setError(errorText(cause)),
        ),
      300,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [kind, asked]);
  const held = (key: string) => setFound((now) => now && now.map((each) => (each.key === key ? { ...each, in_library: true } : each)));
  return (
    <SettingsSection title={SOURCE[kind]} description="Brigadier doesn't review these: install only what you trust." setting={SOURCE[kind]}>
      {error ? (
        <ErrorLine error={error} className="py-4 text-center" />
      ) : !found ? (
        <p role="status" className="py-4 text-center text-label text-quiet-foreground">
          Searching…
        </p>
      ) : found.length === 0 ? (
        <p className="py-4 text-center text-label text-quiet-foreground">Nothing matches “{asked}”.</p>
      ) : (
        <SettingsCard>
          {found.map((each) => (
            <div key={each.key} data-slot="found-row" className="flex items-center gap-3 px-4 py-3">
              {/* Its maker's mark only from its own address or package: anyone can name a server "Linear" [D437]. */}
              <PluginMark item={{ kind: each.kind, name: "", detail: each.mark }} exact />
              <RowText
                title={each.name}
                line={
                  <span className="flex flex-col gap-0.5">
                    {each.description && <span>{each.description}</span>}
                    <span className="text-faint-foreground">{[each.publisher, each.how].join(" · ")}</span>
                    {each.why && <span className="text-faint-foreground">{each.why}</span>}
                  </span>
                }
              />
              {each.in_library ? (
                <Badge variant="secondary">Installed</Badge>
              ) : (
                each.form && (
                  <Button variant="ghost" size="icon-md" aria-label={`Install ${each.name}`} onClick={() => onAdd(firstOf(each.form!), () => held(each.key))}>
                    <Plus aria-hidden />
                  </Button>
                )
              )}
            </div>
          ))}
        </SettingsCard>
      )}
    </SettingsSection>
  );
}
