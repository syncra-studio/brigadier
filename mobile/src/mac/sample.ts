// Sample lists and a thread for `-screen sessions`, `-screen thread`, the powers' and P4a's sheets (simulator
// screenshots: no Mac, no network).
import type { Row } from "../../vendor/brigadier-shared/rows";
import approvals from "../../vendor/brigadier-shared/samples/approval-cards.json";
import questions from "../../vendor/brigadier-shared/samples/question-cards.json";
import type { PendingApproval, PendingQuestion } from "../../vendor/brigadier-shared/cards";
import file from "../../vendor/brigadier-shared/samples/file-change.json";
import group from "../../vendor/brigadier-shared/samples/group.json";
import message from "../../vendor/brigadier-shared/samples/message.json";
import shell from "../../vendor/brigadier-shared/samples/shell.json";
import tool from "../../vendor/brigadier-shared/samples/tool.json";
import type { Item } from "../../vendor/brigadier-shared/thread";
import { canned } from "../compose/state";
import { sessionMenu, sheet } from "../sheets/Sheets";
import { lists, thread } from "./mac";

const row = (id: string, title: string, project: string | null, mark: Row["mark"], ago: number): Row =>
  ({ id, title, project, mark, state: "idle", reason: null, resets: null, sent: 0, finished: 0, backend: "claude", updated: Date.now() - ago * 60_000, items: 1, error: null }) as Row;

/** `powers`: s1 has the level and Overnight pills, a night under way, and a `!` command running that a message waits for. */
export function loadSample(powers = false) {
  lists.set({
    ready: true,
    projects: [
      { id: "p1", name: "brigadier", folder: "", trusted: true, setup: "", include: [], added: 0 },
      { id: "p2", name: "website", folder: "", trusted: true, setup: "", include: [], added: 0 },
    ],
    rows: [
      powers
        ? ({
            ...row("s1", "Fix the failing login test", "p1", "working", 2),
            levels: ["ask", "auto", "full"],
            level: "auto",
            overnight: { state: "night", since: Date.now() - 83 * 60_000, done: 2, total: 5, decided: 1 },
            queue: { paused: false, items: [{ id: "q1", text: "Then update the changelog" }], running: ["c-sh2"] },
          } as Row)
        : row("s1", "Fix the failing login test", "p1", "needs", 2),
      row("s2", "Speed up the session list", "p1", "working", 5),
      row("s3", "Write the release notes", "p1", "unread", 50),
      row("s4", "New pricing page", "p2", null, 60 * 26),
      row("s5", "What is IKpsk2?", null, null, 60 * 24 * 3),
    ],
  });
  const items = [...message.items, ...group.items, ...tool.items, ...file.items, ...(powers ? shell.items : [])] as Item[];
  thread.set({ id: "s1", status: "ready", session: { id: "s1", title: "Fix the failing login test", before: null, turns: [], items, work: [], approvals: [approvals[0]] as PendingApproval[], questions: [questions[2]] as PendingQuestion[] } });
}

/** `-screen <one>` of P4a's: New chat, its Face ID sheet, the thread's ⋯ menu, or one of its sheets, on canned replies. */
export const SHEETS = ["start", "start-confirm", "menu", "changes", "background", "shell-output", "plan", "fork", "rewind"];
const BEFORE = "import { login } from './auth';\n\ntest('logs in', async () => {\n  const user = await login('a@b.c', 'pw');\n  expect(user).toBeTruthy();\n});\n";
const AFTER = "import { login } from './auth';\n\ntest('logs in', async () => {\n  const user = await login('a@b.c', 'secret');\n  expect(user.id).toBe('u1');\n  expect(user.name).toBe('Ada');\n});\n";
const FILE = { path: "src/auth/login.test.ts", from: null, status: "modified", insertions: 3, deletions: 2 };
const REPLIES: [string, Record<string, any>][] = [
  ["draft @home:p1", { ok: true, rev: 1, draft: JSON.stringify({ parts: ["Add a dark mode switch to Settings, and remember the choice"], attachmentIds: [] }) }],
  ["models --project p1", { ok: true, groups: [{ provider: "claude", label: "Claude Code", short: "Claude", mark: null, unavailable: null, models: [{ id: "opus", name: "Opus 4.5", efforts: ["low", "medium", "high"], default_effort: "high", fast: null, legacy: false }, { id: "sonnet", name: "Sonnet 4.5", efforts: [], default_effort: null, fast: null, legacy: false }] }] }],
  ["source s1 status", { ok: true, git: { head: { branch: "brigadier/fix-the-failing-login-test" } } }],
  ["source s1 review last", { ok: true, review: { scope: "last", files: [FILE, { ...FILE, path: "src/auth/login.ts", insertions: 1, deletions: 1 }], insertions: 4, deletions: 3, turn: { before: "a1", after: "b2" } } }],
  ["source s1 review-file", { ok: true, contents: { before: BEFORE, after: AFTER, hunks: [{ id: "h1", header: "@@ -3,4 +3,5 @@" }] } }],
  ["jobs s1 history", { ok: true, history: [{ label: "pnpm dev", startedAt: Date.now() - 40 * 60_000, endedAt: null, status: "running" }, { label: "pnpm test --watch", startedAt: Date.now() - 90 * 60_000, endedAt: Date.now() - 80 * 60_000, status: "stopped" }] }],
  ["shell s1 output", { ok: true, running: true, output: " RUN  v2.1.4 /Users/ada/brigadier\n\n ✓ src/auth/session.test.ts (4)\n ✓ src/auth/token.test.ts (7)\n ❯ src/auth/login.test.ts (3)\n   × logs in\n\nTest Files  1 failed | 2 passed (3)" }],
  ["fork s1 --check", { ok: true, worktree: "snapshot", default: "worktree", agent: "claude", fingerprint: "f1" }],
  ["rewind s1", { ok: true, restore: true, paths: ["src/auth/login.ts", "src/auth/login.test.ts"], hand: [], leftOut: [], nested: [], stale: [], commits: false }],
];

export function loadSheets(screen: string) {
  canned.reply = (args) => REPLIES.find(([at]) => args.join(" ").startsWith(at))?.[1];
  const s1 = lists.get().rows[0]!;
  const extra = {
    background: [{ pid: 4242, start_us: 1, label: "pnpm dev", ports: [5173], apps: [] }],
    plan: [{ text: "Reproduce the failing login test", status: "completed" }, { text: "Fix the password check in login.ts", status: "in_progress" }, { text: "Run the whole suite", status: "pending" }],
  };
  lists.set({ ...lists.get(), rows: [{ ...s1, ...extra } as Row, ...lists.get().rows.slice(1)] });
  const open = thread.get()!;
  if (open.session) thread.set({ ...open, session: { ...open.session, items: [...open.session.items, ...(shell.items as Item[])] } });
  const at = { id: "s1" };
  if (screen === "menu") setTimeout(() => sessionMenu("s1"), 1500);
  if (screen === "changes") sheet.set({ ...at, kind: "changes", file: FILE });
  if (screen === "background") sheet.set({ ...at, kind: "background" });
  if (screen === "shell-output") sheet.set({ ...at, kind: "shell", cmd: "c-sh2", command: "pnpm test" });
  if (screen === "plan") sheet.set({ ...at, kind: "plan" });
  if (screen === "fork") sheet.set({ ...at, kind: "fork", at: "t1" });
  if (screen === "rewind") sheet.set({ ...at, kind: "rewind", cid: "c1", text: "The login test fails on CI, can you fix it?" });
}
