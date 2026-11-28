// Sample lists and a thread for `-screen sessions`, `-screen thread`, the powers', P4a's sheets and the composer's
// (simulator screenshots: no Mac, no network).
import Link from "../../modules/link";
import type { Row } from "../../../app/shared/rows";
import type { ModelGroup } from "../../../app/shared/session/model";
import approvals from "../../../app/shared/samples/approval-cards.json";
import questions from "../../../app/shared/samples/question-cards.json";
import type { PendingApproval, PendingQuestion } from "../../../app/shared/cards";
import file from "../../../app/shared/samples/file-change.json";
import group from "../../../app/shared/samples/group.json";
import message from "../../../app/shared/samples/message.json";
import shell from "../../../app/shared/samples/shell.json";
import tool from "../../../app/shared/samples/tool.json";
import type { Item } from "../../../app/shared/thread";
import { canned, forMac } from "../compose/state";
import { sessionMenu, sheet } from "../sheets/Sheets";
import { keepImage } from "../thread/Image";
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
  ["projects branches p1", { ok: true, repo: { current: "main", branches: ["fix/login-redirect", "main", "release/1.4"], worktrees: [] } }],
  ["source s1 status", { ok: true, git: { head: { branch: "brigadier/fix-the-failing-login-test" } } }],
  ["source s1 review last", { ok: true, review: { scope: "last", files: [FILE, { ...FILE, path: "src/auth/login.ts", insertions: 1, deletions: 1 }], insertions: 4, deletions: 3, turn: { before: "a1", after: "b2" } } }],
  ["source s1 review-file", { ok: true, contents: { before: BEFORE, after: AFTER, hunks: [{ id: "h1", header: "@@ -3,4 +3,5 @@" }] } }],
  ["jobs s1 history", { ok: true, history: [{ label: "pnpm dev", startedAt: Date.now() - 40 * 60_000, endedAt: null, status: "running" }, { label: "pnpm test --watch", startedAt: Date.now() - 90 * 60_000, endedAt: Date.now() - 80 * 60_000, status: "stopped" }] }],
  ["shell s1 output", { ok: true, running: true, output: " RUN  v2.1.4 /Users/ada/brigadier\n\n ✓ src/auth/session.test.ts (4)\n ✓ src/auth/token.test.ts (7)\n ❯ src/auth/login.test.ts (3)\n   × logs in\n\nTest Files  1 failed | 2 passed (3)" }],
  ["fork s1 --latest", { ok: true, at: "t1", worktree: "snapshot", default: "worktree", agent: "claude", fingerprint: "f1" }],
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
  if (screen === "fork") sheet.set({ ...at, kind: "fork" });
  if (screen === "rewind") sheet.set({ ...at, kind: "rewind", cid: "c1", text: "The login test fails on CI, can you fix it?" });
}

/** `-screen composer-…`: the composer as it looks, drawn as if connected; null otherwise. */
export const composerSample = Link.screen?.startsWith("composer-") ? Link.screen : null;

const GROUPS: ModelGroup[] = [
  {
    provider: "claude",
    label: "Claude Code",
    mark: null,
    models: [
      { id: "opus", name: "Opus 4.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high", fast: "Faster output at a higher cost" },
      { id: "sonnet", name: "Sonnet 4.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
      { id: "haiku", name: "Haiku 4.5", efforts: [], legacy: true },
    ],
  },
];
const IMAGE = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAFOElEQVR42g3MsQpuUAAA4Ps4d7FYLBaLxWKxnIGSFIOBkhSDW0ckokiUIlGnSNQppZRSHuv+3wN8f/6CjwAvCR4K3DS4GHCyAHPg4MEmgAUAJIFZAaMGegN0FmgdUHugDEARgiwBSQ6iCsAW/PvzV/wI8SXFhxJvWrwY8WRFzIkHL26CuAARSeKsiKMm9obYWWLriLUnloFYhGKWiEkuRpUIW/EXyR8hv6T8UPJNyxcjn6yMOfng5U2QFyAjSZ4VedTk3pA7S24dufbkMpCLUM4SOcnlqJJhK/8i9SPUl1QfSr1p9WLUk1Uxpx68ugnqAlQkqbOijpraG2pnqa2j1p5aBmoRqlmiJrkaVSps1V+kf4T+kvpD6TetX4x+sjrm9IPXN0FfgI4kfVb0UdN7Q+8svXX02tPLQC9CPUv0JNejSoet/ouMjzBe0ngo46aNizFO1sCccfDGJhgLMJBkzIoxakZvGJ1ltI5Re0YZGEVoZImR5EZUGbA1fpH5EeZLmg9l3rR5MebJmpgzD97cBHMBJpLMWTFHzewNs7PM1jFrzywDswjNLDGT3IwqE7bmL7I/wn5J+6Hsm7Yvxj5ZG3P2wdubYC/ARpI9K/ao2b1hd5bdOnbt2WVgF6GdJXaS21Flw9b+Re5HuC/pPpR70+7FuCfrYs49eHcT3AW4SHJnxR01tzfcznJbx609twzcInSzxE1yN6pc2Lq/yP8I/yX9h/Jv2r8Y/2R9zPkH72+CvwAfSf6s+KPm94bfWX7r+LXnl4FfhH6W+EnuR5UPW/8XBR8RvGTwUMFNBxcTnGyAueDgg00IFhAgKZiVYNSC3gg6K2idoPaCMgiKMMiSIMmDqApgG/wi+BHwJeFDwZuGFwNPFmIOHjzcBLgAiCQ4K3DUYG/AzoKtA2sPlgEsQpglMMlhVEHYwl8Uf0T8kvFDxTcdX0x8sjHm4oOPNyFeQIykeFbiUYt7I+6suHXi2ovLIC7COEviJI+jKoZt/IvSj0hfMn2o9KbTi0lPNsVcevDpJqQLSJGUzko6amlvpJ2Vtk5ae2kZpEWYZkma5GlUpbBNf1HxEcVLFg9V3HRxMcXJFpgrDr7YhGIBBZKKWSlGreiNorOK1ilqryiDogiLLCmSvIiqArbFL6o+onrJ6qGqm64upjrZCnPVwVebUC2gQlI1K9WoVb1RdVbVOlXtVWVQFWGVJVWSV1FVwbb6Rc1HNC/ZPFRz083FNCfbYK45+GYTmgU0SGpmpRm1pjeazmpap6m9pgyaImyypEnyJqoa2Da/qPuI7iW7h+puuruY7mQ7zHUH321Ct4AOSd2sdKPW9UbXWV3rdLXXlUFXhF2WdEneRVUH2+4XDR8xvOTwUMNNDxcznOyAueHgh00YFjAgaZiVYdSG3hg6a2idofaGMhiKcMiSIcmHqBpgO/yi6SOml5wearrp6WKmk50wNx38tAnTAiYkTbMyjdrUG1NnTa0z1d5UBlMRTlkyJfkUVRNsp1+EPgK9JHoodNPoYtDJIsyhg0ebgBaAkIRmBY0a6g3UWah1UO2hMkBFiLIEJTmKKgRb9IvWj1hfcn2o9abXi1lPdsXcevDrJqwLWJG0zso6amtvrJ21ts5ae2sZrEW4Zsma5GtUrbBdf9H+EftL7g+13/R+MfvJ7pjbD37fhH0BO5L2WdlHbe+NvbP21tlrby+DvQj3LNmTfI+qHbb7L8IfgV8SPxS+aXwx+GQx5vDB403AC8BIwrOCRw33Bu4s3Dq49nAZ4CLEWYKTHEcVhi3+9x+XVoHuRE2ECAAAAABJRU5ErkJggg==";

/**
 * The composer's screens over the sample thread: `composer-empty`; `composer-typing`, words with a tool's chip;
 * `composer-queue`, a turn running and two messages waiting; `composer-files`, an image's tile and a file's;
 * `composer-model`, the model menu open; `composer-night`, Overnight's night; `composer-shell`, a `!` command typed;
 * `composer-chips`, a diff comment and a Fix with agent waiting over the field.
 */
export function loadComposerSample(name: string) {
  loadSample(false);
  const mac = forMac();
  mac.models.keep(GROUPS);
  const queue = name === "composer-queue" ? { paused: false, items: [{ id: "q1", text: "Then update the changelog" }, { id: "q2", text: "And add a test for the expired session" }] } : null;
  const s1 = { ...row("s1", "Fix the failing login test", "p1", name === "composer-queue" ? "working" : null, 2), model: "opus", effort: "high", fast: true, levels: ["ask", "auto", "full"], level: "auto", running: queue !== null, steer: true, queue } as Row;
  if (name === "composer-night") Object.assign(s1, { overnight: { state: "night", since: Date.now() - 134 * 60_000, done: 2, total: 5, decided: 1 } });
  lists.set({ ...lists.get(), rows: [s1, ...lists.get().rows.slice(1)] });
  if (name === "composer-shell") mac.drafts.keepDraft(mac.run, "s1", { parts: ["!pnpm test"], attachmentIds: [] });
  if (name === "composer-chips") {
    const comment = { id: "c1", path: "src/auth/login.ts", side: "additions", start: 12, end: 14, excerpt: "if (password === user.password) {", text: "Compare the hashes, not the passwords" };
    const fix = { id: "f1", kind: "run", run: "CI / test", failed: "login.test.ts › logs in" };
    canned.reply = (args) => (args.join(" ") === "chips s1" ? { ok: true, chips: [{ kind: "comment", id: "k1", on: "review", comment }, { kind: "agent", id: "k2", key: "run:ci", pr: null, chip: fix, text: "" }] } : undefined);
  }
  if (name === "composer-typing") mac.drafts.keepDraft(mac.run, "s1", { parts: ["Find out why the login test fails on CI, then fix it ", { kind: "command", id: "research", type: "tool", label: "/research" }, " "], attachmentIds: [] });
  if (name === "composer-files") {
    keepImage("s1", "a1", IMAGE);
    mac.files.owners.set(
      new Map([
        [
          "s1",
          {
            all: new Map([
              ["a1", { id: "a1", name: "login-error.png", mime: "image/png", state: "ready" as const }],
              ["a2", { id: "a2", name: "Release notes.pdf", mime: "application/pdf", state: "ready" as const }],
            ]),
            tiles: ["a1", "a2"],
          },
        ],
      ]),
    );
    mac.drafts.keepDraft(mac.run, "s1", { parts: ["What's wrong in this screenshot?"], attachmentIds: ["a1", "a2"] });
  }
}
