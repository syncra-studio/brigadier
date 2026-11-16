import { useEffect, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Segmented } from "../components/segmented";
import { RowText, SettingsCard } from "../components/settings-card";
import { Switch } from "../components/switch";
import { useDaemon } from "../daemon";
import { errorText, run, useAgents } from "../onboarding/api";
import { Folder, Folders, Mcp, Plus, Spinner, ToolsSkills } from "../icons";
import { SearchField } from "./archived-toolbar";
import { SettingsPage, SettingsSection } from "./parts";
import { type AddFirst, AddDialog, type Draft, RefreshDialog, RemoveDialog } from "./plugins-dialogs";
import { BrowsePage, type Found } from "./plugins-browse";
import { DetailsPage, type Device, type SignInStart } from "./plugins-details";
import { AgentTile, PluginMark } from "./plugins-marks";

/** Where an item is on: every project, or only these (by id). */
export type Scope = { all: true } | { projects: string[] };
export type Kind = "server" | "skill";
/** A remote server's standing; null for a skill or a local server. */
export type Status = "signed_in" | "needs_sign_in" | "cant_reach" | "off";
/** One item of the library, as Rust's `plugins` says it [D2043]. `note` is a quiet line: a skill an agent keeps its own copy of (D415), a server each agent signs in to itself (wave4 D2045). */
export type Item = {
  key: string;
  kind: Kind;
  name: string;
  description: string;
  /** A server's address or command, a skill's folder. */
  detail: string;
  on: boolean;
  scope: Scope;
  status: Status | null;
  sign_in: "brigadier" | "cli" | null;
  /** Whether Brigadier holds its sign-in; null where it signs none in. */
  signed_in: boolean | null;
  /** The agents that get it, by label. */
  agents: string[];
  note: string | null;
};
/** A skill or server in agents' own settings, once however many have it: at home, or in one of `project`'s folder (by name). Read-only: Add to library copies its definition, never its tokens [D424]. */
export type Own = { key: string; kind: Kind; name: string; detail: string; agents: string[]; project: string | null; in_library: boolean };
export type Plugins = { items: Item[]; own: Own[]; projects: { id: string; name: string }[] };

/** What the page asks of Rust; each answers with the whole page as it is after. */
export type PluginActions = {
  add: (draft: Draft | { own: string }) => Promise<Plugins>;
  set: (key: string, change: { on?: boolean; scope?: Scope }) => Promise<Plugins>;
  remove: (key: string) => Promise<Plugins>;
  /** Reads the page again, its agents' own included. */
  refresh: () => Promise<Plugins>;
  /** Signs in through the browser: settles once it's done, or with its error. */
  signIn: (key: string, onDevice: (device: Device) => void) => Promise<unknown>;
  cancel: (key: string) => Promise<unknown>;
  signOut: (key: string) => Promise<unknown>;
  /** A skill's folder, from the system's picker; null when none was chosen. */
  pickFolder: () => Promise<string | null>;
  /** Searches the internet's servers or skills through Rust [D434]. */
  browse: (kind: Kind, query: string) => Promise<Found[]>;
};

export const TAB_LABEL: Record<Kind, string> = { server: "MCP servers", skill: "Skills" };
// How library items reach sessions [D429, D432]: only where on; each agent loads skills and MCP tools by name first.
const DESCRIPTION = "Skills and MCP servers your agents can use. Only what's on for a project reaches its sessions, and loads when used.";

/** The page's rows, for Settings search; the page draws these words. */
export const PLUGINS_ROWS = {
  server: { label: "MCP servers", description: "Servers every agent can use, in every project or only some" },
  skill: { label: "Skills", description: "Skills every agent can use, in every project or only some" },
  own: { label: "Each agent's own", description: "What your agents have in their own settings, and in your projects'. Add to library copies it, never its sign-in." },
} as const;

const STATUS: Record<Status, { label: string; variant: "success" | "warning" | "destructive" | "secondary" }> = {
  signed_in: { label: "Signed in", variant: "success" },
  needs_sign_in: { label: "Needs sign-in", variant: "warning" },
  cant_reach: { label: "Can't reach", variant: "destructive" },
  off: { label: "Off", variant: "secondary" },
};

/** Where an item is on, as its tag: "Global", a project's name, "3 projects"; null when it's in none. */
export function chipOf(value: Plugins, item: Item): string | null {
  if ("all" in item.scope) return "Global";
  const names = item.scope.projects.map((id) => value.projects.find((project) => project.id === id)?.name ?? id);
  if (names.length === 0) return null;
  return names.length === 1 ? names[0]! : `${names.length} projects`;
}

const matches = (query: string, ...texts: string[]) => texts.join(" ").toLowerCase().includes(query.trim().toLowerCase());

/** A dialog open over the page; the gallery opens one at first. */
export type Open = { type: "add"; remote: boolean; first?: AddFirst; added?: () => void } | { type: "refresh"; found: Own[] } | { type: "remove"; key: string };

/**
 * Settings › Plugins, the old app's [D2043, D2046]: the MCP servers and Skills tabs, search, Refresh and Add; each card
 * with its mark, line, scope chip, status chip, agents and switch; each agent's own with Add to library; an item's page.
 * Pure props: a change shows at once and settles on the page Rust answers with, or goes back with Rust's words [D30].
 * `value` null is loading; `detail` an item's page. `remote` offers remote servers in Add (4.13).
 */
export function PluginsPage({
  value,
  error,
  offline = false,
  marks,
  actions,
  detail,
  onDetail,
  remote,
  open: openFirst = null,
  signing,
  tab: firstTab = "server",
}: {
  value: Plugins | null;
  error?: string | null;
  offline?: boolean;
  /** Each agent's mark, by its label. */
  marks: Record<string, string | null>;
  actions: PluginActions;
  detail: string | null;
  onDetail: (key: string | null) => void;
  remote: boolean;
  open?: Open | null;
  /** The tab the list opens on, when no item's page is open. */
  tab?: Kind;
  signing?: SignInStart;
}) {
  const [tab, setTab] = useState<Kind>(() => value?.items.find((item) => item.key === detail)?.kind ?? firstTab);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Open | null>(openFirst);
  const [checking, setChecking] = useState(false);
  const [said, setSaid] = useState<string | null>(null);
  // A change in flight, or settled, on the page it was made from; a newer page from Rust replaces it.
  const [mine, setMine] = useState<{ base: Plugins; shown: Plugins } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const ops = useRef(0);
  // Rust's last answer on this page: a refused change goes back to it, not to the page as first read.
  const confirmed = useRef<{ base: Plugins; shown: Plugins } | null>(null);
  const shown = mine && mine.base === value ? mine.shown : value;

  /** Shows `next` at once, then Rust's answer to `send`; its refusal puts the page back and says why. */
  const change = (next: Plugins, send: () => Promise<Plugins>): Promise<boolean> => {
    if (!value || !shown) return Promise.resolve(false);
    const op = ++ops.current;
    const base = value;
    setMine({ base, shown: next });
    setFailed(null);
    return send().then(
      (back) => {
        confirmed.current = { base, shown: back };
        if (op === ops.current) setMine(confirmed.current);
        return true;
      },
      (cause: unknown) => {
        if (op === ops.current) {
          setMine(confirmed.current?.base === value ? confirmed.current : null);
          setFailed(errorText(cause));
        }
        return false;
      },
    );
  };
  const withItem = (key: string, patch: Partial<Item>) => shown && { ...shown, items: shown.items.map((item) => (item.key === key ? { ...item, ...patch } : item)) };
  const set = (key: string, patch: { on?: boolean; scope?: Scope }) => void change(withItem(key, patch)!, () => actions.set(key, patch));
  /** Copies agents' own items into the library, one after another; the page settles on the last answer. */
  const addOwn = (keys: string[]) =>
    shown &&
    change({ ...shown, own: shown.own.map((each) => (keys.includes(each.key) ? { ...each, in_library: true } : each)) }, () =>
      keys.reduce<Promise<Plugins>>((before, key) => before.then(() => actions.add({ own: key })), Promise.resolve(shown)),
    );
  const remove = (key: string) => {
    if (!shown) return Promise.resolve(false);
    // The list shows at once (the item is gone from it); the route follows once Rust agrees, so a refusal is said here.
    return change({ ...shown, items: shown.items.filter((item) => item.key !== key) }, () => actions.remove(key)).then((done) => {
      if (done) onDetail(null);
      return done;
    });
  };
  /** The only place an agent's new own items are looked for: what wasn't there before opens the dialog. */
  const refresh = () => {
    if (!shown || checking) return;
    const before = new Set(shown.own.map((own) => own.key));
    // The page stays as it is while Rust reads again: its line is replaced only by the answer [D427].
    setChecking(true);
    void change(shown, async () => {
      const back = await actions.refresh();
      const found = back.own.filter((own) => !before.has(own.key) && !own.in_library && importable(own, remote));
      if (found.length) setOpen({ type: "refresh", found });
      setSaid(found.length ? null : "Nothing changed. There are no new skills or MCP servers in your agents' own settings.");
      return back;
    }).finally(() => setChecking(false));
  };

  const item = detail ? shown?.items.find((each) => each.key === detail) : undefined;
  const close = () => setOpen(null);
  let page;
  if (detail === "browse") {
    page = <BrowsePage tab={tab} browse={actions.browse} onAdd={(first, added) => setOpen({ type: "add", remote, first, added })} />;
  } else if (shown && item) {
    page = <DetailsPage value={shown} item={item} marks={marks} actions={actions} signing={signing} onScope={(scope) => set(item.key, { scope })} onRemove={() => setOpen({ type: "remove", key: item.key })} />;
  } else {
    const count = (kind: Kind) => shown?.items.filter((each) => each.kind === kind).length ?? 0;
    const items = shown?.items.filter((each) => each.kind === tab && matches(query, each.name, each.description, each.detail)) ?? [];
    const own = shown?.own.filter((each) => each.kind === tab && matches(query, each.name, each.detail, ...each.agents, each.project ?? "")) ?? [];
    page = (
      <SettingsPage title="Plugins" description={DESCRIPTION}>
        <div className="flex flex-col gap-5">
          <div data-slot="plugins-toolbar" className="flex flex-wrap items-center gap-3">
            <Segmented
              label="Plugins"
              value={tab}
              options={(["server", "skill"] as const).map((kind) => ({
                value: kind,
                label: (
                  <>
                    {TAB_LABEL[kind]} <span className="text-faint-foreground">{count(kind)}</span>
                  </>
                ),
              }))}
              onChange={(next) => {
                setTab(next);
                lastTab = next;
                setQuery("");
              }}
            />
            <span className="flex-1" />
            {/* "Search" alone fits a narrow window; the field's name still says what it searches. */}
            <div className="flex max-w-60 min-w-28 flex-1">
              <SearchField label={tab === "server" ? "Search MCP servers" : "Search skills"} value={query} onChange={setQuery} />
            </div>
            {/* One width while it checks, so the toolbar doesn't move. */}
            <Button variant="soft" size="sm" className="min-w-24" disabled={!shown || checking} aria-busy={checking} onClick={refresh}>
              {checking && <Spinner aria-hidden className="animate-spin motion-reduce:animate-none" />}
              Refresh
            </Button>
            <Button variant="soft" size="sm" onClick={() => onDetail("browse")}>
              Browse
            </Button>
            <Button size="sm" disabled={!shown} onClick={() => setOpen({ type: "add", remote })}>
              <Plus aria-hidden />
              Add
            </Button>
          </div>
          {said && (
            <p role="status" className="text-label text-quiet-foreground">
              {said}
            </p>
          )}
          {!shown ? (
            error ? (
              <ErrorLine error={error} className="py-6 text-center" />
            ) : (
              <p role="status" className="py-6 text-center text-label text-quiet-foreground">
                Loading plugins…
              </p>
            )
          ) : count(tab) === 0 ? (
            <EmptyTab tab={tab} remote={remote} onAdd={() => setOpen({ type: "add", remote })} />
          ) : items.length === 0 && own.length === 0 ? (
            <p data-slot="no-match" className="py-6 text-center text-label text-quiet-foreground">
              Nothing matches “{query.trim()}”.
            </p>
          ) : (
            <div data-slot="plugins-grid" className="grid grid-cols-1 gap-2.5 @reading:grid-cols-2">
              {items.map((each) => (
                <PluginCard key={each.key} item={each} chip={chipOf(shown, each)} marks={marks} onOpen={() => onDetail(each.key)} onSwitch={(on) => set(each.key, { on })} />
              ))}
            </div>
          )}
          {own.length > 0 && <OwnList own={own} marks={marks} remote={remote} onAdd={(each) => void addOwn([each.key])} />}
        </div>
      </SettingsPage>
    );
  }
  const target = open?.type === "remove" ? shown?.items.find((each) => each.key === open.key) : undefined;
  return (
    <div className="@container relative flex h-full min-w-0 flex-1">
      {/* Brigadier isn't running: the last page, dimmed, nothing on it reachable. */}
      <div inert={offline} className={cx("flex min-w-0 flex-1", offline && "opacity-disabled")}>
        {page}
      </div>
      {/* What a change failed with, on the list or an item's page alike, the old app's. */}
      <ErrorLine error={failed} className="absolute inset-x-5 bottom-4 bg-background" />
      {open?.type === "add" && shown && (
        <AddDialog remote={open.remote} first={open.first} pickFolder={actions.pickFolder} onAdd={(draft) =>
            actions.add(draft).then(
              (back) => {
                setMine((confirmed.current = { base: value!, shown: back }));
                open.added?.();
              },
              (cause: unknown) => {
                // Said on the page too: the dialog may be hidden by then.
                setFailed(errorText(cause));
                throw cause;
              },
            )
          } onClose={close} />
      )}
      {open?.type === "refresh" && (
        <RefreshDialog
          found={open.found}
          onApply={(keys) => {
            void addOwn(keys);
            close();
          }}
          onClose={close}
        />
      )}
      {target && (
        <RemoveDialog
          item={target}
          onRemove={() => {
            void remove(target.key);
            close();
          }}
          onClose={close}
        />
      )}
    </div>
  );
}

/** One item in the list's grid: its mark, name, line, where it's on, its standing and agents; its switch at the corner. */
function PluginCard({ item, chip, marks, onOpen, onSwitch }: { item: Item; chip: string | null; marks: Record<string, string | null>; onOpen: () => void; onSwitch: (on: boolean) => void }) {
  const status = item.on ? item.status : "off";
  // How it runs (a command, an address or a folder) is in code's letters; its chip says if it needs sign-in.
  const line = item.description || item.detail;
  return (
    <SettingsCard data-slot="plugin-row" data-key={item.key} data-off={!item.on || undefined} split={false} className="flex-row items-start gap-3 px-4 py-3.5">
      <button type="button" onClick={onOpen} aria-label={`Open ${item.name}`} className={cx("flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-start focus-visible:focus-ring", !item.on && "opacity-disabled")}>
        <PluginMark item={item} />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-label font-medium">{item.name}</span>
          <span className={cx("truncate text-xs text-quiet-foreground", !item.description && "font-mono")}>{line}</span>
          {item.note && <span className="text-xs text-quiet-foreground">{item.note}</span>}
          <span className="flex flex-wrap items-center gap-1.5 pt-1.5">
            {chip && <ScopeChip text={chip} />}
            {status && <Badge variant={STATUS[status].variant}>{STATUS[status].label}</Badge>}
            {item.agents.map((agent) => (
              <AgentTile key={agent} agent={agent} mark={marks[agent]} />
            ))}
          </span>
        </span>
      </button>
      <Switch aria-label={item.name} checked={item.on} onCheckedChange={onSwitch} />
    </SettingsCard>
  );
}

/** Where an item is on, as a tag: "Global", a project's name, "3 projects". */
export function ScopeChip({ text }: { text: string }) {
  const Icon = text === "Global" ? Folders : Folder;
  return (
    <span data-slot="scope-chip" className="flex h-5 w-fit shrink-0 items-center gap-1 rounded-capsule bg-fill-subtle px-2 text-xs text-quiet-foreground">
      <Icon aria-hidden className="size-3" />
      {text}
    </span>
  );
}

/** Agents' own skills or servers, read-only, each once: those at home, then each project's; Add to library copies one in. */
function OwnList({ own, marks, remote, onAdd }: { own: Own[]; marks: Record<string, string | null>; remote: boolean; onAdd: (own: Own) => void }) {
  const groups = [...new Set(own.map((each) => each.project))].sort((a, b) => (a === null ? -1 : b === null ? 1 : 0));
  return (
    <SettingsSection title={PLUGINS_ROWS.own.label} description={PLUGINS_ROWS.own.description} setting={PLUGINS_ROWS.own.label}>
      <div className="flex flex-col gap-3">
        {groups.map((project) => (
          <div key={project ?? ""} className="flex flex-col gap-1.5">
            {project !== null && (
              <span data-slot="own-project" className="flex items-center gap-1.5 text-xs text-quiet-foreground">
                <Folder aria-hidden className="size-3" />
                {project}
              </span>
            )}
            <SettingsCard>
              {own
                .filter((each) => each.project === project)
                .map((each) => (
                  <div key={each.key} data-slot="own-row" className="flex items-center gap-3 px-4 py-3">
                    <PluginMark item={each} />
                    <RowText title={each.name} line={<span className="font-mono">{each.detail}</span>} truncate />
                    <span className="flex shrink-0 items-center gap-1">
                      {each.agents.map((agent) => (
                        <AgentTile key={agent} agent={agent} mark={marks[agent]} />
                      ))}
                    </span>
                    <span className="shrink-0 text-xs text-quiet-foreground">{each.agents.join(" · ")}</span>
                    {each.in_library ? (
                      <span className="w-28 shrink-0 text-end text-xs text-quiet-foreground">In your library</span>
                    ) : !importable(each, remote) ? (
                      <span className="w-28 shrink-0" />
                    ) : (
                      <Button variant="soft" size="sm" className="w-28" aria-label={`Add ${each.name} to library`} onClick={() => onAdd(each)}>
                        Add to library
                      </Button>
                    )}
                  </div>
                ))}
            </SettingsCard>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

// A server at an address comes to the library with 4.13's sign-in.
const importable = (own: Own, remote: boolean) => remote || !/^[a-z][a-z0-9+.-]*:\/\//i.test(own.detail);

/** A tab with nothing in it yet. */
function EmptyTab({ tab, remote, onAdd }: { tab: Kind; remote: boolean; onAdd: () => void }) {
  const [help, setHelp] = useState(false);
  const Icon = tab === "server" ? Mcp : ToolsSkills;
  return (
    <SettingsCard data-slot="plugins-empty" split={false} className="items-center gap-2 px-6 py-12 text-center">
      <span className="flex size-11 items-center justify-center rounded-nav bg-fill-subtle">
        <Icon aria-hidden className="size-5 text-quiet-foreground" />
      </span>
      <span className="pt-2 text-sm font-medium">No {tab === "skill" ? "skills" : "MCP servers"} yet</span>
      <span className="text-label text-quiet-foreground">Add one once and every agent can use it, in all your projects or just some.</span>
      <span className="flex items-center gap-3 pt-3">
        <Button size="sm" onClick={onAdd}>
          Add
        </Button>
        <Button variant="ghost" size="sm" aria-expanded={help} onClick={() => setHelp(!help)}>
          What can I add?
        </Button>
      </span>
      {help && <span className="max-w-md pt-2 text-xs text-quiet-foreground">{remote ? `${ADD_HINT}, or one at an address.` : `${ADD_HINT}.`}</span>}
    </SettingsCard>
  );
}

const ADD_HINT = "A skill folder with a SKILL.md, an MCP server your agents start on this computer";

// The last page Rust sent: an item's page opens on it at once (Settings draws each route afresh), then reads again.
let last: Plugins | null = null;
// The kind of the item last opened, so going back from it, or removing it, lands on its tab.
let lastTab: Kind = "server";
// One change at a time, in the order made: the daemon answers each on its own thread.
let chain: Promise<unknown> = Promise.resolve();
const send = (...args: string[]) => {
  const sent = chain.then(() => run(["plugins", ...args]) as Promise<Plugins>).then((page) => (last = page));
  chain = sent.catch(() => {});
  return sent;
};

/** The page in Settings: Rust's library, each change through `plugins`, its reply the page [D30, D2043]. */
export function PluginsSettings({ detail }: { detail?: string }) {
  const online = Boolean(useDaemon().daemon);
  const agents = useAgents().list;
  const [value, setValue] = useState<Plugins | null>(last);
  const [error, setError] = useState<string | null>(null);
  lastTab = (detail && value?.items.find((item) => item.key === detail)?.kind) || lastTab;
  useEffect(() => {
    if (!online) return;
    setError(null);
    send().then(setValue, (cause) => setError(errorText(cause)));
  }, [online]);
  const marks = Object.fromEntries((agents ?? []).map((agent) => [agent.label, agent.mark]));
  const actions: PluginActions = {
    add: (draft) => send("add", JSON.stringify(draft)),
    set: (key, change) => send("set", key, JSON.stringify(change)),
    remove: (key) => send("remove", key),
    refresh: () => send(),
    // Rust starts it and answers its page, which opens in the browser; its end answers the page, waited
    // for outside the chain so Cancel isn't held behind it.
    signIn: async (key, onDevice) => {
      const started = await run(["plugins", "signin", key]);
      if (typeof started.code === "string") onDevice({ code: started.code, page: String(started.url) });
      window.brigadier?.openLink(String(started.url));
      setValue((last = (await run(["plugins", "wait", key])) as Plugins));
    },
    cancel: (key) => send("cancel", key).then(setValue),
    signOut: (key) => send("signout", key).then(setValue),
    pickFolder: async () => (await window.brigadier?.pickFolder()) ?? null,
    // Outside the chain: a search never waits behind a change, nor holds one up.
    browse: async (kind, query) => (await run(["plugins", "browse", kind, query])).found as Found[],
  };
  return (
    <PluginsPage
      value={value}
      error={error}
      offline={!online}
      marks={marks}
      actions={actions}
      detail={detail ?? null}
      onDetail={(key) => (location.hash = key ? `#settings/plugins/${encodeURIComponent(key)}` : "#settings/plugins")}
      remote
      tab={lastTab}
    />
  );
}
