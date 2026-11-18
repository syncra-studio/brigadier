import { type Chip, EMPTY_DRAFT } from "../components/composer/draft";
import type { Project, Row } from "../daemon";
import { asGroups } from "../session/model";
import { run } from "../onboarding/api";
import { newProjectId } from "../projects/projects";
import { daemonSource } from "../projects/store";
import { draftOf, keepDraft, loadDraft } from "../session/draft";
import { base64 } from "../session/files";
import { prPasteLabel } from "../shell/attachment-tab";
import { CHAT, openTab, selectTab } from "../shell/tab-store";
import { sessionId } from "../home/start";
import type { PullRequest } from "./pull-requests";

/** A row's last model, as Home reads it (1q's fold). */
type Ran = Row & { backend: string; model?: string | null; effort?: string | null };

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

/**
 * The PR in `session`'s composer, once, as an inline chip named "Pull request #n" whose text is `prText` [D692]: the
 * composer's own pasted-text chip, so a click opens that text in its tab. Then the session open on its chat, its PR tab
 * beside it for the way back [D690]. Nothing is sent [D675].
 */
async function open(session: string, pr: PullRequest): Promise<void> {
  const name = prPasteLabel(pr.number);
  await loadDraft(run, session);
  const draft = draftOf(session) ?? EMPTY_DRAFT;
  if (!draft.parts.some((part) => typeof part !== "string" && part.kind === "paste" && part.preview === name)) {
    const id = crypto.randomUUID();
    await run(["attach", session, "add", id, `${name}.txt`, "--data", base64(new TextEncoder().encode(prText(pr)).buffer)]);
    const chip: Chip = { kind: "paste", attachmentId: id, preview: name };
    keepDraft(run, session, { parts: [...draft.parts, chip, " "], attachmentIds: draft.attachmentIds });
  }
  openTab(session, "pr", String(pr.number));
  selectTab(session, CHAT);
  window.location.hash = `#thread/${encodeURIComponent(session)}`;
}

/** The model a new session there starts on: the project's last session's while it's offered, else the first, one on this computer first. */
async function modelFor(project: string, rows: readonly Row[]) {
  const read = async (fresh: string[]) => asGroups((await run(["models", "--project", project, ...fresh])).groups).filter((group) => !group.unavailable && group.models.length > 0);
  // A project just cloned has no check kept yet: one now.
  const kept = await read([]);
  const groups = kept.length > 0 ? kept : await read(["--fresh"]);
  const offered = groups.flatMap((group) => group.models.map((each) => ({ provider: group.provider, model: each.id, effort: each.defaultEffort ?? null, local: (each as { local?: boolean }).local })));
  const last = (rows as Ran[]).filter((row) => row.project === project && row.model).toSorted((a, b) => b.sent - a.sent)[0];
  const again = last && offered.find((each) => each.provider === last.backend && each.model === last.model);
  const picked = again ? { ...again, effort: last.effort ?? again.effort } : (offered.find((each) => each.local) ?? offered[0]);
  if (!picked) throw new Error("No agent is set up for this project yet.");
  return picked;
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
 * Bring to agent [D674]: a session already on the PR's branch opens; else a new one starts in the PR's project, on its
 * own worktree at the PR's branch, the repository cloned first when it's no project yet (with the GitHub account that
 * read the PR [D631]). Never outside a project. Its composer holds the PR and nothing is sent [D675]. `owner` is the
 * PR tab's (a session, or Home's project) and `target` its PR (`n`, or `owner/name#n`); `say` names each step on the button.
 */
export async function bring(pr: PullRequest, owner: string, target: string, rows: readonly Row[], projects: readonly Project[], say: (words: string) => void): Promise<void> {
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
  say("Starting…");
  const model = await modelFor(project, rows);
  const id = sessionId();
  const where = ["--base", pr.base, "--pr", String(pr.number), "--head", pr.branch, ...(pr.fork ? ["--fork"] : [])];
  await run(["start", id, "--backend", model.provider, "--project", project, ...where, "--title", `#${pr.number} ${pr.title}`, "--model", model.model, ...(model.effort ? ["--effort", model.effort] : [])]);
  await open(id, pr);
}
