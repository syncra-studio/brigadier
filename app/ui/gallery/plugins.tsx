// Settings › Plugins on fake data (4.11), shaped as Rust's `plugins` reply: both tabs, search, every status chip, Off,
// All projects / Only some, Sign in, each agent's own, the Add, Refresh and Remove dialogs; loading, empty, error, offline.
import { type ReactNode, useRef, useState } from "react";

import { Button } from "../src/components/button";
import { CheckboxRow } from "../src/components/checkbox-row";
import { type Open, type PluginActions, type Plugins, PluginsPage } from "../src/settings/plugins";
import type { SignInStart } from "../src/settings/plugins-details";
import { Row, Section, State } from "./parts";

// Stand-in marks: no agent's real logo in gallery code.
const MARKS = {
  "Cloud agent": '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="5.5"/></svg>',
  "Other agent": '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5 14.5 8 8 14.5 1.5 8Z"/></svg>',
};
const BOTH = ["Cloud agent", "Other agent", "Local agent"];

const VALUE: Plugins = {
  projects: [
    { id: "p1", name: "brigadier" },
    { id: "p2", name: "freelogo" },
    { id: "p3", name: "website" },
  ],
  items: [
    { key: "linear", kind: "server", name: "Linear", description: "Issues, projects and cycles", detail: "https://mcp.linear.app/mcp", on: true, scope: { all: true }, status: "signed_in", sign_in: "brigadier", signed_in: true, agents: BOTH, note: null },
    { key: "notion", kind: "server", name: "Notion", description: "", detail: "https://mcp.notion.com/mcp", on: true, scope: { projects: ["p1"] }, status: "needs_sign_in", sign_in: "brigadier", signed_in: false, agents: BOTH, note: null },
    { key: "sentry", kind: "server", name: "Sentry", description: "Errors and releases", detail: "https://mcp.sentry.dev/mcp", on: true, scope: { projects: ["p1", "p2"] }, status: "cant_reach", sign_in: "brigadier", signed_in: true, agents: BOTH, note: null },
    { key: "figma", kind: "server", name: "Figma", description: "Design files and frames", detail: "https://mcp.figma.com/mcp", on: true, scope: { all: true }, status: null, sign_in: "cli", signed_in: null, agents: BOTH, note: "Signed in by each agent: Figma doesn't take Brigadier's sign-in." },
    { key: "postgres", kind: "server", name: "postgres", description: "", detail: "npx -y @modelcontextprotocol/server-postgres postgresql://localhost/app", on: false, scope: { all: true }, status: null, sign_in: null, signed_in: null, agents: [], note: null },
    { key: "files", kind: "server", name: "files", description: "", detail: "uvx mcp-files --root .", on: false, scope: { projects: [] }, status: null, sign_in: null, signed_in: null, agents: [], note: null },
    { key: "review", kind: "skill", name: "review", description: "Reviews a change the way you would: correctness first, then reuse.", detail: "~/Library/Application Support/Brigadier/library/skills/review", on: true, scope: { all: true }, status: null, sign_in: null, signed_in: null, agents: BOTH, note: null },
    { key: "release", kind: "skill", name: "release", description: "Cuts a release: changelog, tag and notes.", detail: "~/Library/Application Support/Brigadier/library/skills/release", on: true, scope: { projects: ["p1"] }, status: null, sign_in: null, signed_in: null, agents: ["Cloud agent", "Local agent"], note: "Other agent uses your own release skill: it can't turn just that one off for a session." },
  ],
  own: [
    { key: "own-cloud-github", kind: "server", name: "github", detail: "https://api.githubcopilot.com/mcp", agent: "Cloud agent", in_library: false },
    { key: "own-other-linear", kind: "server", name: "linear", detail: "https://mcp.linear.app/mcp", agent: "Other agent", in_library: true },
    { key: "own-cloud-tidy", kind: "skill", name: "tidy", detail: "~/.cloud/skills/tidy", agent: "Cloud agent", in_library: false },
  ],
};
const FOUND = [
  { key: "own-other-stripe", kind: "server" as const, name: "stripe", detail: "https://mcp.stripe.com", agent: "Other agent", in_library: false },
  { key: "own-local-docs", kind: "skill" as const, name: "docs", detail: "~/.local-agent/skills/docs", agent: "Local agent", in_library: false },
];

/** A page in a box of its own, scrolled inside it as Settings scrolls it. */
function Frame({ tall = false, children }: { tall?: boolean; children: ReactNode }) {
  return <div className={tall ? "flex h-240 w-full overflow-hidden rounded-surface border border-divider bg-background" : "flex h-120 w-200 overflow-hidden rounded-surface border border-divider bg-background"}>{children}</div>;
}

/** Rust's answers after a moment, or its refusal; a sign-in fails with the server's words. */
function useFake() {
  const page = useRef(VALUE);
  const [value, setValue] = useState(VALUE);
  const [refuses, setRefuses] = useState(false);
  const later = (next: (now: Plugins) => Plugins) =>
    new Promise<Plugins>((done, fail) =>
      setTimeout(() => {
        if (refuses) return fail(new Error("Couldn't save the library: the disk is full."));
        page.current = next(page.current);
        setValue(page.current);
        done(page.current);
      }, 600),
    );
  const actions: PluginActions = {
    add: (draft) =>
      later((now) =>
        "own" in draft
          ? { ...now, own: now.own.map((own) => (own.key === draft.own ? { ...own, in_library: true } : own)) }
          : { ...now, items: [...now.items, { key: `new-${now.items.length}`, kind: draft.kind, name: "name" in draft ? draft.name : draft.folder.split("/").pop()!, description: "", detail: "url" in draft ? draft.url : "command" in draft ? [draft.command, ...draft.args].join(" ") : draft.folder, on: false, scope: { all: true }, status: null, sign_in: null, signed_in: null, agents: [], note: null }] },
      ),
    set: (key, change) => later((now) => ({ ...now, items: now.items.map((item) => (item.key === key ? { ...item, ...change } : item)) })),
    remove: (key) => later((now) => ({ ...now, items: now.items.filter((item) => item.key !== key) })),
    refresh: () => later((now) => ({ ...now, own: [...now.own.filter((own) => !FOUND.some((found) => found.key === own.key)), ...FOUND] })),
    signIn: () => new Promise((_, fail) => setTimeout(() => fail(new Error("Linear said: access_denied. Try again, or check the account you picked.")), 2500)),
    cancel: () => Promise.resolve(),
    signOut: () => later((now) => now),
    pickFolder: () => Promise.resolve("~/skills/changelog"),
  };
  return { value, actions, refuses, setRefuses };
}

const still: PluginActions = {
  add: () => new Promise(() => {}),
  set: () => Promise.resolve(VALUE),
  remove: () => Promise.resolve(VALUE),
  refresh: () => Promise.resolve(VALUE),
  signIn: () => new Promise(() => {}),
  cancel: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
  pickFolder: () => Promise.resolve(null),
};

/** One still: the page as given, opened where it says. */
function Still({ label, value = VALUE, detail = null, open, signing, error, offline, remote = true, tall = false }: { label: string; value?: Plugins | null; detail?: string | null; open?: Open; signing?: SignInStart; error?: string; offline?: boolean; remote?: boolean; tall?: boolean }) {
  return (
    <State label={label}>
      <div data-held data-still={label} className="contents">
        <Frame tall={tall}>
          <PluginsPage value={value} error={error} offline={offline} marks={MARKS} actions={still} detail={detail} onDetail={() => {}} remote={remote} open={open} signing={signing} />
        </Frame>
      </div>
    </State>
  );
}

const FILES = { name: "files", command: "uvx mcp-files --root .", values: [{ id: 0, name: "FILES_TOKEN", value: "secret" }] };
const SKILL = { kind: "skill" as const, folder: "~/skills/changelog" };
const DIALOGS: [string, Open][] = [
  ["Add a server at an address", { type: "add", remote: true, first: { form: { remote: true, name: "linear", url: "https://mcp.linear.app/mcp" } } }],
  ["Add a local command", { type: "add", remote: true, first: { form: FILES } }],
  ["Its command, confirmed", { type: "add", remote: true, first: { form: FILES, step: "confirm" } }],
  ["Add a skill", { type: "add", remote: true, first: { form: SKILL } }],
  ["Adding", { type: "add", remote: true, first: { form: SKILL, step: "adding" } }],
  ["Added", { type: "add", remote: true, first: { form: SKILL, step: "added" } }],
  ["Before 4.13: no remote servers", { type: "add", remote: false }],
  ["Refresh found new ones", { type: "refresh", found: FOUND }],
  ["Remove", { type: "remove", key: "postgres" }],
];

/** Each dialog over the page, opened by its button: a modal covers the window, so one at a time. */
function Dialogs() {
  // Its press count keys the page, so a dialog closed inside it opens again.
  const [open, setOpen] = useState({ label: "", presses: 0 });
  const shown = DIALOGS.find(([label]) => label === open.label);
  return (
    <div className="flex flex-wrap gap-2">
      {DIALOGS.map(([label]) => (
        <Button key={label} size="sm" variant="outline" data-dialog-still={label} onClick={() => setOpen((now) => ({ label, presses: now.presses + 1 }))}>
          {label}
        </Button>
      ))}
      {shown && (
        <Frame>
          <PluginsPage key={open.presses} value={VALUE} marks={MARKS} actions={still} detail={null} onDetail={() => {}} remote={shown[1].type !== "add" || shown[1].remote} open={shown[1]} />
        </Frame>
      )}
    </div>
  );
}

export function PluginsGallery() {
  const fake = useFake();
  const [detail, setDetail] = useState<string | null>(null);
  return (
    <Section title="Settings › Plugins">
      <Row name="The page: flip, open, scope, sign in, add, refresh, remove">
        <div className="flex w-full flex-col gap-3">
          <CheckboxRow label="Rust refuses changes" checked={fake.refuses} onCheckedChange={fake.setRefuses} />
          {/* An item's back link goes to Settings' route; here it goes back to the list. */}
          <div
            className="contents"
            onClickCapture={(event) => {
              if (!(event.target instanceof Element) || !event.target.closest('a[href="#settings/plugins"]')) return;
              event.preventDefault();
              setDetail(null);
            }}
          >
            <Frame tall>
              <PluginsPage value={fake.value} marks={MARKS} actions={fake.actions} detail={detail} onDetail={setDetail} remote />
            </Frame>
          </div>
        </div>
      </Row>
      <Row name="Item pages">
        <Still label="Only some projects, signed in elsewhere" detail="sentry" />
        <Still label="All projects, signed in" detail="linear" />
        <Still label="Sign in" detail="notion" />
        <Still label="Waiting for browser" detail="notion" signing="waiting" />
        <Still label="Sign-in failed" detail="notion" signing={{ error: "Notion said: access_denied. Try again, or check the account you picked." }} />
        <Still label="Signed in by each agent" detail="figma" />
        <Still label="A skill an agent keeps its own of" detail="release" />
      </Row>
      <Row name="Dialogs, one at a time">
        <Dialogs />
      </Row>
      <Row name="States">
        <Still label="Loading" value={null} />
        <Still label="Can't be read" value={null} error="Couldn't read the library: Brigadier stopped answering." />
        <Still label="Brigadier isn't running" offline />
        <Still label="Empty" value={{ items: [], own: [], projects: VALUE.projects }} />
        <Still label="Empty, with an agent's own" value={{ ...VALUE, items: [] }} />
      </Row>
    </Section>
  );
}
