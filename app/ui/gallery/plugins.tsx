// Settings › Plugins on fake data (4.11), shaped as Rust's `plugins` reply: both tabs, search, every status chip, Off,
// All projects / Only some, Sign in, what the agents have on this machine, the Add and Remove dialogs; loading, empty, error, offline.
import { type ReactNode, useRef, useState } from "react";

import { Button } from "../src/components/button";
import { CheckboxRow } from "../src/components/checkbox-row";
import { type Entry, type Open, type PluginActions, type Plugins, PluginsPage } from "../src/settings/plugins";
import type { Found } from "../src/settings/plugins-browse";
import type { Shown } from "../src/settings/plugins-view";
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
    // Found on this machine, installed as the agents have them [D721]; two skills of one maker are one skillset [D720].
    { key: "server:github", kind: "server", name: "github", description: "", detail: "https://api.githubcopilot.com/mcp", on: true, scope: { all: true }, status: null, sign_in: "cli", signed_in: null, agents: BOTH, note: "Signed in by each agent.", from: "From Cloud agent's github plugin" },
    { key: "server:postgres-freelogo", kind: "server", name: "postgres-freelogo", description: "", detail: "npx -y @modelcontextprotocol/server-postgres postgresql://localhost/freelogo", on: true, scope: { projects: ["p2"] }, status: null, sign_in: null, signed_in: null, agents: BOTH, note: null, from: "In Cloud agent and Other agent's settings" },
    { key: "skill:speckit-plan", kind: "skill", name: "speckit-plan", description: "Plans the implementation from the spec.", detail: "~/Development/freelogo/.cloud/skills/speckit-plan", on: true, scope: { projects: ["p2"] }, status: null, sign_in: null, signed_in: null, agents: BOTH, note: null, from: "In Cloud agent's settings", set: "speckit" },
    { key: "skill:speckit-tasks", kind: "skill", name: "speckit-tasks", description: "Breaks the plan into tasks.", detail: "~/Development/freelogo/.cloud/skills/speckit-tasks", on: true, scope: { projects: ["p2"] }, status: null, sign_in: null, signed_in: null, agents: BOTH, note: null, from: "In Cloud agent's settings", set: "speckit" },
  ],
};
const FOUND: Plugins["items"] = [
  { key: "server:stripe", kind: "server", name: "stripe", description: "", detail: "https://mcp.stripe.com", on: true, scope: { all: true }, status: null, sign_in: null, signed_in: null, agents: BOTH, note: null, from: "In Other agent's settings" },
];

// A service that signs in only through the user's own app [D591]; its link as Rust builds it, cut short.
const SLACK: Entry = {
  kind: "server", id: "slack", name: "Slack", line: "Search, read and send messages", about: "", maker: "Slack", category: "Productivity", url: "https://mcp.slack.com/mcp", installed: null,
  app: {
    link: "https://api.slack.com/apps?new_app=1&manifest_json=%7B%7D",
    steps: ["Slack opens with Brigadier's settings filled in. Pick your workspace, then Create.", "Under Agents, make sure Slack MCP Server is On.", "Under Basic Information, copy the Client ID and paste it here."],
  },
};

// A search for "rea" [D660]: the catalog's React Best Practices, then what the MCP Registry and skills.sh answer.
const ICONS: Record<string, string> = {};
const found = (kind: Found["kind"], name: string, publisher: string, description: string, mark: string): Found => ({
  key: `${kind}:${name}`, kind, name, description, publisher, how: "", mark, icon: ICONS[name] ?? null, in_library: false, why: null,
  form: kind === "skill" ? { source: mark, skill: name } : { remote: true, name, url: mark, values: [] },
});
const FOUND_REA = [
  found("server", "Readwise", "Readwise Inc.", "Save, read, search and review your highlights", "https://mcp.readwise.io/mcp"),
  found("server", "Read AI", "Read AI, Inc.", "Meeting notes and transcripts", "https://api.read.ai/mcp"),
  found("server", "ReadMe", "ReadMe", "Manage your ReadMe docs", "https://docs.readme.com/mcp"),
  found("server", "Realtor", "Move, Inc.", "Search homes for sale and rent", "https://mcp.realtor.com"),
  found("server", "Reasonbook", "aquex.ai", "Decisions that survive the session", "@aquex/reasonbook"),
  found("skill", "react-native-best-practices", "callstackincubator", "Performance rules for React Native apps", "callstackincubator/agent-skills"),
  found("skill", "react-view-transitions", "vercel-labs", "Animate route changes with view transitions", "vercel-labs/agent-skills"),
];
const SEARCH_VALUE: Plugins = {
  ...VALUE,
  catalog: { categories: ["Development"], entries: [{ kind: "skill", id: "react-best-practices", name: "React Best Practices", line: "React and Next.js performance rules", about: "", maker: "Vercel", category: "Development", installed: null }] },
};

/** A page in a box of its own, scrolled inside it as Settings scrolls it. */
function Frame({ tall = false, children }: { tall?: boolean; children: ReactNode }) {
  return <div className={tall ? "flex h-240 w-full min-w-260 overflow-hidden rounded-surface border border-divider bg-background" : "flex h-120 w-200 overflow-hidden rounded-surface border border-divider bg-background"}>{children}</div>;
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
      later((now) => ({ ...now, items: [...now.items, { key: `new-${now.items.length}`, kind: draft.kind, name: "name" in draft ? draft.name : "skill" in draft ? draft.skill : draft.folder.split("/").pop()!, description: "", detail: "url" in draft ? draft.url : "command" in draft ? [draft.command, ...draft.args].join(" ") : "folder" in draft ? draft.folder : draft.source, on: false, scope: { all: true }, status: null, sign_in: null, signed_in: null, agents: [], note: null }] })),
    install: () => later((now) => now),
    show: () => Promise.resolve([]),
    reveal: () => Promise.resolve(),
    set: (key, change) => later((now) => ({ ...now, items: now.items.map((item) => (item.key === key ? { ...item, ...change } : item)) })),
    remove: (key) => later((now) => ({ ...now, items: now.items.filter((item) => item.key !== key) })),
    refresh: () => later((now) => ({ ...now, items: [...now.items.filter((item) => !FOUND.some((found) => found.key === item.key)), ...FOUND] })),
    signIn: () => new Promise((_, fail) => setTimeout(() => fail(new Error("Linear said: access_denied. Try again, or check the account you picked.")), 2500)),
    cancel: () => Promise.resolve(),
    signOut: () => later((now) => now),
    pickFolder: () => Promise.resolve("~/skills/changelog"),
    browse: () => Promise.resolve([]),
  };
  return { value, actions, refuses, setRefuses };
}

const still: PluginActions = {
  add: () => new Promise(() => {}),
  install: () => new Promise(() => {}),
  reveal: () => Promise.resolve(),
  set: () => Promise.resolve(VALUE),
  remove: () => Promise.resolve(VALUE),
  refresh: () => Promise.resolve(VALUE),
  signIn: () => new Promise(() => {}),
  cancel: () => Promise.resolve(),
  signOut: () => Promise.resolve(),
  pickFolder: () => Promise.resolve(null),
  browse: () => Promise.resolve([]),
  show: (key) => Promise.resolve(VIEW[key] ?? []),
};

/** One still: the page as given, opened where it says. */
function Still({ label, value = VALUE, detail = null, open, signing, error, offline, remote = true, tall = false, browse }: { label: string; value?: Plugins | null; detail?: string | null; open?: Open; signing?: SignInStart; error?: string; offline?: boolean; remote?: boolean; tall?: boolean; browse?: PluginActions["browse"] }) {
  return (
    <State label={label}>
      <div data-held data-still={label} className="contents">
        <Frame tall={tall}>
          <PluginsPage value={value} error={error} offline={offline} marks={MARKS} actions={browse ? { ...still, browse } : still} detail={detail} onDetail={() => {}} remote={remote} open={open} signing={signing} />
        </Frame>
      </div>
    </State>
  );
}

// What View shows [D582, D600]: a skillset's SKILL.md files (from Browse, so no Reveal), a server's settings with its values hidden.
const VIEW: Record<string, Shown[]> = {
 "skillset:notion": [
  {
   "name": "notion-spec-to-implementation",
   "path": "~/Library/Application Support/Brigadier/library/skills/notion-spec-to-implementation/SKILL.md",
   "text": "---\nname: notion-spec-to-implementation\ndescription: Turn Notion specs into implementation plans, tasks, and progress tracking; use when implementing PRDs/feature specs and creating Notion plans + tasks from them.\nmetadata:\n  short-description: Turn Notion specs into implementation plans, tasks, and progress tracking\n---\n\n# Spec to Implementation\n\nConvert a Notion spec into linked implementation plans, tasks, and ongoing status updates.\n\n## Quick start\n1) Locate the spec with `Notion:search`, then fetch it with `Notion:fetch`.\n2) Parse requirements and ambiguities using `reference/spec-parsing.md`.\n3) Create a plan page with `Notion:notion-create-pages` (pick a template: quick vs. full).\n4) Find the task database, confirm schema, then create tasks with `Notion:notion-create-pages`.\n5) Link spec ↔ plan ↔ tasks; keep status current with `Notion:notion-update-page`.\n\n"
  },
  {
   "name": "notion-research-documentation",
   "path": "~/Library/Application Support/Brigadier/library/skills/notion-research-documentation/SKILL.md",
   "text": "---\nname: notion-research-documentation\ndescription: Research across Notion and synthesize into structured documentation; use when gathering info from multiple Notion sources to produce briefs, comparisons, or reports with citations.\nmetadata:\n  short-description: Research Notion content and produce briefs/reports\n---\n\n# Research & Documentation\n\nPull relevant Notion pages, synthesize findings, and publish clear briefs or reports (with citations and links to sources).\n\n## Quick start\n1) Find sources with `Notion:search` using targeted queries; confirm scope with the user.\n2) Fetch pages via `Notion:fetch`; note key sections and capture citations (`reference/citations.md`).\n3) Choose output format (brief, summary, comparison, comprehensive report) using `reference/format-selection-guide.md`.\n4) Draft in Notion with `Notion:notion-create-pages` using the matching template (quick, summary, comparison, comprehensive).\n5) Link sources and add a references/citations section; update as new info arrives with `Notion:notion-update-page`.\n\n"
  },
  {
   "name": "notion-meeting-intelligence",
   "path": "~/Library/Application Support/Brigadier/library/skills/notion-meeting-intelligence/SKILL.md",
   "text": "---\nname: notion-meeting-intelligence\ndescription: Prepare meeting materials with Notion context and supplemental research; use when gathering context, drafting agendas/pre-reads, and tailoring materials to attendees.\nmetadata:\n  short-description: Prep meetings with Notion context and tailored agendas\n---\n\n# Meeting Intelligence\n\nPrep meetings by pulling Notion context, tailoring agendas/pre-reads, and enriching with supplemental research.\n\n## Quick start\n1) Confirm meeting goal, attendees, date/time, and decisions needed.\n2) Gather context: search with `Notion:search`, then fetch with `Notion:fetch` (prior notes, specs, OKRs, decisions).\n3) Pick the right template via `reference/template-selection-guide.md` (status, decision, planning, retro, 1:1, brainstorming).\n4) Draft agenda/pre-read in Notion with `Notion:notion-create-pages`, embedding source links and owner/timeboxes.\n5) Enrich with supplemental research (industry insights, benchmarks, risks) and update the page with `Notion:notion-update-page` as plans change.\n\n"
  },
  {
   "name": "notion-knowledge-capture",
   "path": "~/Library/Application Support/Brigadier/library/skills/notion-knowledge-capture/SKILL.md",
   "text": "---\nname: notion-knowledge-capture\ndescription: Capture conversations and decisions into structured Notion pages; use when turning chats/notes into wiki entries, how-tos, decisions, or FAQs with proper linking.\nmetadata:\n  short-description: Capture conversations into structured Notion pages\n---\n\n# Knowledge Capture\n\nConvert conversations and notes into structured, linkable Notion pages for easy reuse.\n\n## Quick start\n1) Clarify what to capture (decision, how-to, FAQ, learning, documentation) and target audience.\n2) Identify the right database/template in `reference/` (team wiki, how-to, FAQ, decision log, learning, documentation).\n3) Pull any prior context from Notion with `Notion:search` → `Notion:fetch` (existing pages to update/link).\n4) Draft the page with `Notion:notion-create-pages` using the database’s schema; include summary, context, source links, and tags/owners.\n5) Link from hub pages and related records; update status/owners with `Notion:notion-update-page` as the source evolves.\n\n"
  }
 ],
 "datadog": [
  {
   "name": "datadog",
   "path": "datadog.json",
   "text": "{\n  \"url\": \"https://mcp.datadoghq.com/v1/mcp\",\n  \"headers\": {\n    \"DD-API-KEY\": \"••••••••\",\n    \"DD-APPLICATION-KEY\": \"••••••••\"\n  }\n}\n"
  }
 ]
};

const FILES = { name: "files", command: "uvx mcp-files --root .", values: [{ id: 0, name: "FILES_TOKEN", value: "secret" }] };
const SKILL = { kind: "skill" as const, folder: "~/skills/changelog" };
// An item's page opens its sign-in over itself: those open with `detail` and `signing`.
const DIALOGS: [string, Open | null, { detail: string; signing: SignInStart }?][] = [
  ["Sign in: waiting for browser", null, { detail: "notion", signing: "waiting" }],
  ["Sign in: a device code", null, { detail: "notion", signing: { code: "WDJB-MJHT", page: "https://github.com/login/device" } }],
  ["Sign in failed", null, { detail: "notion", signing: { error: "Notion said: access_denied. Try again, or check the account you picked." } }],
  ["Add a server at an address", { type: "add", remote: true, first: { form: { remote: true, name: "linear", url: "https://mcp.linear.app/mcp" } } }],
  ["A server at an address, with an API key", { type: "add", remote: true, first: { form: { remote: true, name: "context7", url: "https://mcp.context7.com/mcp", values: [{ id: 0, name: "CONTEXT7_API_KEY", value: "ctx7sk-demo" }] } } }],
  ["Add a local command", { type: "add", remote: true, first: { form: FILES } }],
  ["A local command's install", { type: "add", remote: true, first: { form: FILES, step: "install" } }],
  ["Add a skill", { type: "add", remote: true, first: { form: SKILL } }],
  ["A search result's install", { type: "add", remote: true, first: { form: { kind: "skill", from: { source: "vercel-labs/agent-skills", skill: "reverse-engineer-anything" } }, step: "install" } }],
  ["Before 4.13: no remote servers", { type: "add", remote: false }],
  ["Remove", { type: "remove", key: "postgres" }],
  ["Switch on a project's own server", { type: "start", key: "server:postgres-freelogo" }],
  ["View a skillset", { type: "view", key: "skillset:notion", title: "Notion", kind: "skill", at: "notion-research-documentation" }],
  ["View a server's settings", { type: "view", key: "datadog", title: "datadog", kind: "server" }],
  ["Install Slack: your own app first", { type: "catalog", entry: SLACK }],
  ["Install Slack: Claude Code's, or your own app", { type: "catalog", entry: { ...SLACK, app: { ...SLACK.app!, agent: "Claude Code" } } }],
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
          <PluginsPage key={open.presses} value={VALUE} marks={MARKS} actions={still} detail={shown[2]?.detail ?? null} signing={shown[2]?.signing} onDetail={() => {}} remote={shown[1]?.type !== "add" || shown[1].remote} open={shown[1]} />
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
        <Still label="Signed in by each agent" detail="figma" />
        <Still label="A skill an agent keeps its own of" detail="release" />
        <Still label="Found on this machine" detail="server:postgres-freelogo" />
      </Row>
      <Row name="Dialogs, one at a time">
        <Dialogs />
      </Row>
      <Row name="Search, “rea” typed in its field">
        <Still label="Searching" tall value={SEARCH_VALUE} browse={() => new Promise(() => {})} />
        <Still label="Results" tall value={SEARCH_VALUE} browse={(kind) => Promise.resolve(FOUND_REA.filter((each) => each.kind === kind))} />
      </Row>
      <Row name="States">
        <Still label="Loading" value={null} />
        <Still label="Can't be read" value={null} error="Couldn't read the library: Brigadier stopped answering." />
        <Still label="Brigadier isn't running" offline />
        <Still label="Empty" value={{ items: [], projects: VALUE.projects }} />
      </Row>
    </Section>
  );
}
