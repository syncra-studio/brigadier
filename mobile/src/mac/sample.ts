// Sample lists and a thread for `-screen sessions`, `-screen thread` and the powers' (simulator screenshots: no Mac,
// no network).
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
