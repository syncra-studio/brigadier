import { type Chip, type Draft, EMPTY_DRAFT } from "../components/composer/draft";
import type { Project, Row } from "../daemon";
import { run } from "../onboarding/api";
import { newProjectId } from "../projects/projects";
import { daemonSource } from "../projects/store";
import { draftOf, HOME_DRAFT, keepDraft, loadDraft } from "../session/draft";
import { putBack } from "../session/side";
import { base64, stored } from "../session/files";
import { prPasteLabel } from "../shell/attachment-tab";
import { CHAT, openTab, selectTab } from "../shell/tab-store";
import { newSession, setHomeDraft } from "../home/start";
import type { PullRequest } from "./pull-requests";

/** The PR as the agent reads it [D675]: the PR, its failing checks and its review comments. */
export function prText(pr: PullRequest): string {
  const failing = pr.checks.filter((check) => check.state === "failed").map((check) => check.name);
  // Line comments (`r`) and reviews' own words (`v`), as Rust numbers them; not the ones the host hides.
  const reviews = pr.comments.filter((comment) => (comment.path || comment.id.startsWith("v")) && !comment.minimized);
  const text = [
    `PR #${pr.number} "${pr.title}" (${pr.url}), ${pr.branch} into ${pr.base}.`,
    failing.length > 0 && `Failing checks: ${failing.join(", ")}.`,
    reviews.length > 0 &&
      `Review comments:\n${reviews.map((c) => `${c.author}${c.path ? ` on ${c.path}${c.line === null ? "" : `:${c.line}`}` : ""}:\n${c.body.split("\n").map((line) => `> ${line}`).join("\n")}`).join("\n\n")}`,
  ];
  return text.filter(Boolean).join("\n\n");
}

/** The PR in `owner`'s composer, once, as an inline chip named "Pull request #n" whose text is `prText` [D692]: the composer's own pasted-text chip, so a click opens that text in its tab. */
async function withChip(owner: string, pr: PullRequest): Promise<Draft> {
  const name = prPasteLabel(pr.number);
  await loadDraft(run, owner);
  const draft = draftOf(owner) ?? EMPTY_DRAFT;
  if (draft.parts.some((part) => typeof part !== "string" && part.kind === "paste" && part.preview === name)) return draft;
  const id = crypto.randomUUID();
  await run(["attach", owner, "add", id, `${name}.txt`, "--data", base64(new TextEncoder().encode(prText(pr)).buffer)]);
  stored(owner, id, `${name}.txt`);
  const chip: Chip = { kind: "paste", attachmentId: id, preview: name };
  const next = { parts: [...draft.parts, chip, " "], attachmentIds: draft.attachmentIds };
  keepDraft(run, owner, next);
  return next;
}

/** A session already on the PR: open on its chat with the PR in its composer, its page in a browser tab beside it [D699]. Nothing is sent [D675]. */
async function open(session: string, pr: PullRequest): Promise<void> {
  // Its composer may be open already, having read its draft as it opened: it's handed the draft with the chip.
  putBack(session, "", false, await withChip(session, pr));
  openTab(session, "browser", pr.url);
  selectTab(session, CHAT);
  window.location.hash = `#thread/${encodeURIComponent(session)}`;
}

/** Clones `repo` (`owner/name`) with `account`, into the folder most projects are in; a clone already there is added. */
async function cloned(repo: string, account: string | undefined): Promise<string> {
  const { parent } = await daemonSource.history();
  const dest = `${parent}/${repo.split("/")[1]}`;
  const check = await daemonSource.check(dest);
  if (check.kind === "repo" && check.project_id) return check.project_id;
  const id = newProjectId();
  await (check.kind === "repo" ? daemonSource.add(id, check.repo) : daemonSource.clone(id, repo, dest, true, account));
  return id;
}

/**
 * Send to agent [D674, D699]: a session already on the PR's branch opens; else the New chat page, in the PR's project,
 * a new worktree on its branch and the PR in its composer, nothing made until Send. The repository is cloned first when
 * it's no project yet (with the GitHub account that read the PR [D631]). Never outside a project. `owner` is the PR
 * tab's (a session, or Home's project) and `target` its PR (`n`, or `owner/name#n`); `say` names each step on the button.
 */
export async function sendToAgent(pr: PullRequest, owner: string, target: string, rows: readonly Row[], projects: readonly Project[], say: (words: string) => void): Promise<void> {
  const on = rows.find((row) => !row.archived && row.prs?.prs.some((each) => each.url === pr.url));
  if (on) return open(on.id, pr);
  // The tab's own project when it's that repository's PR; another repository's is looked up by its remote.
  const mine = rows.find((row) => row.id === owner)?.project ?? (projects.some((each) => each.id === owner) ? owner : null);
  const other = target.includes("#");
  let project = !other && mine ? mine : pr.repo ? ((await run(["host", owner, "project", pr.repo])).project as string | null) : mine;
  if (!project) {
    if (!pr.repo) throw new Error("This PR's repository isn't known yet. Check again, then try.");
    say(`Cloning ${pr.repo}…`);
    project = await cloned(pr.repo, projects.find((each) => each.id === mine)?.github_account ?? undefined);
  }
  // A session already on the branch that the watch hasn't linked to the PR yet.
  const held = (await run(["host", project, "session", pr.fork ? `pr-${pr.number}` : pr.branch])).session as string | null;
  if (held) return open(held, pr);
  const text = await withChip(HOME_DRAFT, pr);
  setHomeDraft({ chat: false, workIn: "worktree", text, pr: { project, number: pr.number, title: pr.title, url: pr.url, branch: pr.branch, base: pr.base, fork: Boolean(pr.fork), tab: target } });
  newSession(project);
}
