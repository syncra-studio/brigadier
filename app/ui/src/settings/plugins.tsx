import { useEffect, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { ErrorLine } from "../components/error-line";
import { Segmented } from "../components/segmented";
import { SettingsCard } from "../components/settings-card";
import { Switch } from "../components/switch";
import { useDaemon } from "../daemon";
import { errorText, run, useAgents } from "../onboarding/api";
import { ChevronDown, Folder, Folders, Mcp, Reload, ToolsSkills } from "../icons";
import { SearchField } from "./archived-toolbar";
import { SettingsPage, SettingsSection } from "./parts";
import { type AddFirst, AddDialog, type Draft, InstallDialog, RefreshDialog, RemoveDialog } from "./plugins-dialogs";
import { BrowseTab, entryRow, type Found, PickGrid } from "./plugins-browse";
import { importable, MyTab } from "./plugins-mine";
import { DetailsPage, type Device, type SignInStart, Trail } from "./plugins-details";
import { AgentTile, PluginMark } from "./plugins-marks";
import { type Shown, ViewDialog } from "./plugins-view";
import type { App } from "./plugins-app";

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
  /** The catalog entry it is or came with [D572]; `with` only on a skill that came with a service. */
  catalog?: string | null;
  with?: string | null;
};
/** One of Browse's catalog, shipped with Brigadier [D566, D569]: a service (its server, and the skills that come with it) or a skill from a GitHub repo; `installed` the library's key for it. */
export type Entry = {
  kind: Kind;
  id: string;
  name: string;
  line: string;
  about: string;
  maker: string;
  category: string;
  popular?: boolean;
  url?: string;
  website?: string;
  privacy?: string;
  skills?: { skill: string; name: string; line: string }[];
  app?: App; // One that signs in only through the user's own app [D591, D608].
  installed: string | null;
};
/** A skill or server in agents' own settings, once however many have it: at home, or in one of `project`'s folder (by name); none the library holds [D445]. Read-only: Add to library copies its definition, never its tokens [D424]. */
export type Own = { key: string; kind: Kind; name: string; detail: string; agents: string[]; project: string | null; from: string; catalog?: string | null };
export type Plugins = { items: Item[]; own: Own[]; projects: { id: string; name: string }[]; catalog?: { categories: string[]; entries: Entry[] } };

/** What the page asks of Rust; each answers with the whole page as it is after. */
export type PluginActions = {
  /** Adds one; with the user's pick, `on` and `scope`, it's on there at once [D571]. `added` is its key. */
  add: (draft: (Draft | { own: string }) & { on?: boolean; scope?: Scope }) => Promise<Plugins & { added?: string }>;
  /** Installs a catalog entry, with its skills, on where picked [D571, D572], signing in with the user's own app's `clientId` where it needs one [D591]; null turns its agent's own plugin on there instead [D608]. `added` is its key. */
  install: (id: string, scope: Scope, clientId?: string | null) => Promise<Plugins & { added?: string }>;
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
  /** What View draws of an item, or of `skillset:<id>` [D582]. */
  show: (key: string) => Promise<Shown[]>;
  /** A skill you added, in Finder [D600]. */
  reveal: (key: string) => Promise<unknown>;
  /** Searches the internet's servers or skills through Rust [D434]. */
  browse: (kind: Kind, query: string) => Promise<Found[]>;
};

/** The page's tabs, in this order [D566, D573]. */
export type Tab = "browse" | Kind;
export const TAB_LABEL: Record<Tab, string> = { browse: "Browse", skill: "My Skills", server: "My MCPs" };
const TABS: Tab[] = ["browse", "skill", "server"];
// How library items reach sessions [D429, D432]: only where on; each agent loads skills and MCP tools by name first.
const DESCRIPTION = "Connect your tools to every agent, in all your projects or just some.";

/** The page's rows, for Settings search; the page draws these words. */
export const PLUGINS_ROWS = {
  browse: { label: "Browse", description: "MCP servers and skills to install, by category" },
  server: { label: "My MCPs", description: "Servers every agent can use, in every project or only some" },
  skill: { label: "My Skills", description: "Skills every agent can use, in every project or only some" },
  own: { label: "Found on this machine", description: "What your agents have in their own settings and plugins. Install copies it into Brigadier, never its sign-in." },
} as const;

export const STATUS: Record<Status, { label: string; variant: "success" | "warning" | "destructive" | "secondary" }> = {
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

export const matches = (query: string, ...texts: string[]) => texts.join(" ").toLowerCase().includes(query.trim().toLowerCase());

/** A dialog open over the page; the gallery opens one at first. */
export type Open = { type: "add"; remote: boolean; first?: AddFirst; added?: () => void } | { type: "refresh"; found: Own[] } | { type: "remove"; key: string } | { type: "install"; own: Own } | { type: "catalog"; entry: Entry } | { type: "view"; key: string; title: string; kind: Kind; at?: string };

/** A catalog entry's mark: its logo. */
export const markOf = (entry: Entry) => ({ kind: entry.kind, name: entry.name, detail: entry.url ?? "", logo: entry.id });
/** The categories Browse shows, Popular first; each entry once in its own and in Popular. */
export const inCategory = (entry: Entry, category: string) => (category === "Popular" ? Boolean(entry.popular) : entry.category === category);

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
  tab: firstTab = "browse",
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
  tab?: Tab;
  signing?: SignInStart;
}) {
  const [tab, setTab] = useState<Tab>(() => value?.items.find((item) => item.key === detail)?.kind ?? firstTab);
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
  // `skillset:<id>` is every skill that came with that service [D580].
  const withItem = (key: string, patch: Partial<Item>) =>
    shown && { ...shown, items: shown.items.map((item) => (item.key === key || (item.kind === "skill" && key === `skillset:${item.with}`) ? { ...item, ...patch } : item)) };
  const set = (key: string, patch: { on?: boolean; scope?: Scope }) => void change(withItem(key, patch)!, () => actions.set(key, patch));
  /** Copies agents' own items into the library, one after another; the page settles on the last answer. */
  const addOwn = (keys: string[]) =>
    shown &&
    change({ ...shown, own: shown.own.filter((each) => !keys.includes(each.key)) }, () =>
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
      const found = back.own.filter((own) => !before.has(own.key) && importable(own, remote));
      if (found.length) setOpen({ type: "refresh", found });
      setSaid(found.length ? null : "Nothing changed. There are no new skills or MCP servers on this machine.");
      return back;
    }).finally(() => setChecking(false));
  };

  const entries = shown?.catalog?.entries ?? [];
  // An item's page, or a catalog entry's (`catalog:<id>`), the library's item where it's installed [D574].
  const asked = detail?.startsWith("catalog:") ? entries.find((each) => `catalog:${each.id}` === detail) : undefined;
  const item = shown?.items.find((each) => each.key === (asked ? asked.installed : detail));
  const entry = asked ?? entries.find((each) => each.id === item?.catalog && each.kind === item.kind);
  const category = detail?.startsWith("category:") ? detail.slice(9) : null;
  /** Rust's page after an install: the new item, and its key where it goes on to Brigadier's sign-in. */
  const installed = (back: Plugins & { added?: string }) => {
    setMine((confirmed.current = { base: value!, shown: back }));
    const added = back.items.find((each) => each.key === back.added);
    return added?.sign_in === "brigadier" && !added.signed_in ? added.key : null;
  };
  const close = () => setOpen(null);
  /** Back to the list, on this tab: the breadcrumb's parts. */
  const back = (to: Tab) => () => {
    setTab((lastTab = to));
    onDetail(null);
  };
  const toAdd = (kind: Kind) => setOpen({ type: "add", remote, first: { form: { kind, remote } } });
  let page;
  const controls = (
    <>
      {/* "Search" alone fits a narrow window; the field's name still says what it searches. */}
      <div className="flex w-64 min-w-28">
        <SearchField label="Search plugins" value={query} onChange={setQuery} />
      </div>
      <Button variant="ghost" size="icon" aria-label="Refresh" disabled={!shown || checking} aria-busy={checking} onClick={refresh}>
        <Reload aria-hidden className={cx(checking && "animate-spin motion-reduce:animate-none")} />
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button size="sm" disabled={!shown} />}>
          Add
          <ChevronDown aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => toAdd("server")}>
            <Mcp aria-hidden />
            MCP server
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => toAdd("skill")}>
            <ToolsSkills aria-hidden />
            Skill from a folder
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
  const toCategory = (name: string) => () => onDetail(`category:${name}`);
  // An agent's own that needs the user's own app installs as its catalog entry: a copy couldn't sign in [D591].
  const installOwn = (own: Own, app = entries.find((each) => each.id === own.catalog && each.app)) => setOpen(app ? { type: "catalog", entry: app } : { type: "install", own });
  const onEntry = { onOpen: (entry: Entry) => onDetail(`catalog:${entry.id}`), onInstall: (entry: Entry) => setOpen({ type: "catalog", entry }) };
  if (shown && (item || asked)) {
    // A catalog entry's page sits under its category; the library's under its tab.
    const trail = asked
      ? [{ label: "Plugins", go: back("browse") }, { label: asked.category, go: toCategory(asked.category) }, { label: asked.name }]
      : [{ label: "Plugins", go: back("browse") }, { label: TAB_LABEL[item!.kind], go: back(item!.kind) }, { label: entry?.name ?? item!.name }];
    page = (
      <DetailsPage
        value={shown}
        item={item}
        entry={entry}
        marks={marks}
        actions={actions}
        signing={signing}
        trail={trail}
        onInstall={() => entry && onEntry.onInstall(entry)}
        onScope={(scope) => item && set(item.key, { scope })}
        onSwitch={(on) => item && set(item.key, { on })}
        onRemove={() => item && setOpen({ type: "remove", key: item.key })}
        onView={(key, kind, at) => setOpen({ type: "view", key, kind, at, title: entry?.name ?? item?.name ?? key })}
      />
    );
  } else if (shown && category) {
    const listed = entries.filter((each) => inCategory(each, category) && matches(query, each.name, each.line, each.maker));
    page = (
      <>
        <Trail parts={[{ label: "Plugins", go: back("browse") }, { label: category }]} />
        <SettingsPage title={category} description={category === "Popular" ? "Services most people connect first." : undefined} actions={controls}>
          {listed.length ? (
            <PickGrid>{listed.map((each) => entryRow(each, onEntry))}</PickGrid>
          ) : (
            <p className="py-6 text-center text-label text-quiet-foreground">Nothing matches “{query.trim()}”.</p>
          )}
        </SettingsPage>
      </>
    );
  } else {
    // A skillset is one card, so one in the count [D580].
    const count = (kind: Kind) => new Set(shown?.items.filter((each) => each.kind === kind).map((each) => each.with ?? each.key)).size;
    page = (
      <SettingsPage title="Plugins" description={DESCRIPTION} actions={controls}>
        <div className="-mt-4 flex flex-col gap-7">
          <div>
            <Segmented
              label="Plugins"
              value={tab}
              options={TABS.map((each) => ({
                value: each,
                label:
                  each === "browse" ? (
                    TAB_LABEL[each]
                  ) : (
                    <>
                      {TAB_LABEL[each]} <span className="text-faint-foreground">{count(each)}</span>
                    </>
                  ),
              }))}
              onChange={(next) => setTab((lastTab = next))}
            />
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
          ) : tab === "browse" ? (
            <BrowseTab value={shown} query={query} remote={remote} browse={actions.browse} onEntry={onEntry} onCategory={(name) => toCategory(name)()} onInstall={installOwn} onAdd={(first, added) => setOpen({ type: "add", remote, first, added })} />
          ) : (
            <MyTab value={shown} kind={tab} query={query} marks={marks} remote={remote} onOpen={onDetail} onSwitch={(key, on) => set(key, { on })} onInstall={installOwn} onBrowse={() => setTab((lastTab = "browse"))} onAdd={() => toAdd(tab)} />
          )}
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
      {open?.type === "install" && shown && (
        <InstallDialog
          name={open.own.name}
          mark={<PluginMark item={open.own} large />}
          line="Every agent gets it, in the projects you pick."
          projects={shown.projects}
          install={(scope) => actions.add({ own: open.own.key, on: true, scope }).then(installed)}
          actions={actions}
          onClose={close}
        />
      )}
      {open?.type === "catalog" && shown && (
        <InstallDialog
          name={open.entry.name}
          mark={<PluginMark item={markOf(open.entry)} large />}
          line={open.entry.app?.agent ? `Choose how your agents reach ${open.entry.name}.` : open.entry.app ? `${open.entry.name} lets Brigadier in only through an app of your own. It takes a few clicks.` : open.entry.skills?.length ? `Comes with its server and ${open.entry.skills.length} skills, for every agent.` : "Every agent gets it, in the projects you pick."}
          projects={shown.projects}
          app={open.entry.app}
          install={(scope, clientId) => actions.install(open.entry.id, scope, clientId).then(installed)}
          actions={actions}
          onClose={close}
        />
      )}
      {open?.type === "view" && <ViewDialog title={open.title} kind={open.kind} at={open.at} read={() => actions.show(open.key)} reveal={(name) => actions.reveal(`skill:${name}`)} onClose={close} />}
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

// The last page Rust sent: an item's page opens on it at once (Settings draws each route afresh), then reads again.
let last: Plugins | null = null;
// The tab last shown, or the kind of the item last opened, so going back to the list lands on it.
let lastTab: Tab = "browse";
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
    install: (id, scope, clientId = "") => (clientId === null ? send("use", id, JSON.stringify(scope)) : send("install", id, JSON.stringify(scope), clientId)),
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
    show: async (key) => (await run(["plugins", "show", key])).files as Shown[],
    reveal: (key) => run(["plugins", "reveal", key]),
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
