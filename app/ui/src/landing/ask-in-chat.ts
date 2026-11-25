import { type Chip, type Draft, EMPTY_DRAFT } from "../components/composer/draft";
import { run } from "../onboarding/api";
import { draftOf, HOME_DRAFT, keepDraft, loadDraft } from "../session/draft";
import { putBack } from "../session/side";
import { base64, stored } from "../session/files";
import { CHAT, selectTab } from "../shell/tab-store";
import { draftKey } from "../home/start";
import type { PullRequest } from "./pull-requests";

/** What the PR tab's Fix asks for [D174]. */
type Focus = "comments" | "checks" | "conflicts";
const ASKS: Record<Focus, string> = {
  comments: "Address the review comments.",
  checks: "Fix the failing checks.",
  conflicts: "Resolve the merge conflicts with the base branch.",
};

/** The PR as the agent reads it [D675]: `focus`'s ask, the PR, and its failing checks or its review comments. */
function prText(pr: PullRequest, focus: Focus): string {
  const failing = focus === "checks" ? pr.checks.filter((check) => check.state === "failed").map((check) => check.name) : [];
  // Line comments (`r`) and reviews' own words (`v`), as Rust numbers them; not the ones the host hides.
  const reviews = focus === "comments" ? pr.comments.filter((comment) => (comment.path || comment.id.startsWith("v")) && !comment.minimized) : [];
  const text = [
    ASKS[focus],
    `PR #${pr.number} "${pr.title}" (${pr.url}), ${pr.branch} into ${pr.base}.`,
    failing.length > 0 && `Failing checks: ${failing.join(", ")}.`,
    reviews.length > 0 &&
      `Review comments:\n${reviews.map((c) => `${c.author}${c.path ? ` on ${c.path}${c.line === null ? "" : `:${c.line}`}` : ""}:\n${c.body.split("\n").map((line) => `> ${line}`).join("\n")}`).join("\n\n")}`,
  ];
  return text.filter(Boolean).join("\n\n");
}

/** A PR's chip's name, by what it asks [D171]. */
function chipName(pr: PullRequest, focus: Focus): string {
  const failing = pr.checks.filter((check) => check.state === "failed");
  if (focus === "conflicts") return `Merge conflicts – PR #${pr.number}`;
  if (focus === "comments") return `Review comments – PR #${pr.number}`;
  if (focus === "checks" && failing.length) return `${failing.length} failing check${failing.length === 1 ? "" : "s"} · ${failing[0]!.name}${failing.length > 1 ? ` +${failing.length - 1} more` : ""}`;
  return `PR ${pr.repo ?? ""}#${pr.number}`;
}

const UUID = 36;

/** The PR in `owner`'s composer, once, as an inline chip named by `chipName` whose text is `prText` [D692]: the composer's own pasted-text chip, so a click opens that text in its tab. */
async function withChip(owner: string, pr: PullRequest, key: string, focus: Focus): Promise<Draft> {
  const name = chipName(pr, focus);
  // Two PRs' chips may share a name ("1 failing check · build"): the id says whose it is.
  const tag = `${(pr.node ?? pr.ref ?? "pr").replace(/\W/g, "_").slice(0, 80)}-`;
  await loadDraft(run, key);
  const draft = draftOf(key) ?? EMPTY_DRAFT;
  if (draft.parts.some((part) => typeof part !== "string" && part.kind === "paste" && part.preview === name && part.attachmentId.slice(0, -UUID) === tag)) return draft;
  const id = tag + crypto.randomUUID();
  await run(["attach", owner, "add", id, `${name}.txt`, "--data", base64(new TextEncoder().encode(prText(pr, focus)).buffer)]);
  stored(owner, id, `${name}.txt`);
  const chip: Chip = { kind: "paste", attachmentId: id, preview: name };
  const next = { parts: [...draft.parts, chip, " "], attachmentIds: draft.attachmentIds };
  keepDraft(run, key, next);
  return next;
}

/**
 * The PR tab's Review, Fix, Fix all and Add to chat [D162 D165 D174]: the ask in the chat beside the tab (its owner's
 * composer: the session's, or Home's review draft), nothing sent. `focus` puts the PR's part in as its chip; `text`
 * goes in as words.
 */
export async function askInChat(owner: string, pr: PullRequest | null, ask: { focus?: Focus; text?: string }): Promise<void> {
  const key = owner === HOME_DRAFT ? draftKey() : owner;
  const draft = pr && ask.focus ? await withChip(owner, pr, key, ask.focus) : undefined;
  putBack(owner, ask.text ?? "", false, draft);
  selectTab(owner, CHAT);
}
