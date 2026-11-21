import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { CheckboxRow } from "../components/checkbox-row";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { Textarea } from "../components/textarea";
import { showToast } from "../components/toast";
import { errorText, run } from "../onboarding/api";
import { pastedRef } from "../pull-requests/route";

/**
 * Create PR [D168]: a new branch if asked for, Commit and push local changes when there are some, Title
 * and Message (empty: the message writer's), head → base, then Create draft PR or Create PR. Each part Rust does only
 * once, so a retry after a refusal does what's left; refused, the dialog stays with what was written and GitHub's words.
 * A PR already there for the branch: Open PR in browser.
 */
function CreatePrDialog({ ask, open, onOpenChange }: { ask: CreateAsk; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { owner, repo, branch, changed, draft: startDraft = false } = ask;
  const [base, setBase] = useState<string | null>(null);
  useEffect(() => {
    run(["host", owner, "base"])
      .then((reply) => setBase(String(reply.base) || null))
      .catch(() => setBase(null));
  }, [owner]);
  const [name, setName] = useState("");
  const [commit, setCommit] = useState(changed);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<"draft" | "ready" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exists, setExists] = useState<string | null>(null);
  const create = (draft: boolean) => {
    setBusy(draft ? "draft" : "ready");
    setError(null);
    const args = ["host", owner, "create", ...(name.trim() ? ["--branch", name.trim()] : []), ...(commit && changed ? ["--commit"] : []), "--title", title, "--message", message, ...(draft ? ["--draft"] : []), ...(base ? ["--base", base] : [])];
    run(args)
      .then((reply) => {
        if (reply.existing) return setExists(String(reply.url));
        onOpenChange(false);
        setTitle("");
        setMessage("");
        showToast(`Created PR #${reply.number} for ${name.trim() ? name.trim() : branch}`, { actions: [{ label: "Open PR in browser", run: () => window.brigadier?.openLink(String(reply.url)) }] });
      })
      .catch((cause) => setError(errorText(cause)))
      .finally(() => setBusy(null));
  };
  // On its base (or no branch), the PR needs a new branch.
  const needsBranch = !branch || branch === base;
  const head = name.trim() || (needsBranch ? "New branch" : branch);
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && (onOpenChange(next), setExists(null))}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create PR</DialogTitle>
          {exists && <DialogDescription>A pull request already exists for this branch</DialogDescription>}
        </DialogHeader>
        {exists ? (
          <DialogFooter>
            <Button onClick={() => (window.brigadier?.openLink(exists), onOpenChange(false))}>Open PR in browser</Button>
          </DialogFooter>
        ) : (
          <>
            {needsBranch && <Input aria-label="New branch" placeholder="New branch" value={name} disabled={Boolean(busy)} onChange={(event) => setName(event.target.value)} />}
            {changed && <CheckboxRow label="Commit and push local changes" checked={commit} disabled={Boolean(busy)} onCheckedChange={setCommit} />}
            <label className="flex flex-col gap-1.5 text-sm">
              Title
              <Input placeholder="Title" value={title} disabled={Boolean(busy)} onChange={(event) => setTitle(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              Message
              <Textarea rows={4} placeholder="Description (leave empty to generate)" value={message} disabled={Boolean(busy)} onChange={(event) => setMessage(event.target.value)} />
            </label>
            <p className="truncate font-mono text-xs text-muted-foreground">
              {repo && `${repo} · `}
              {head} → {base ?? "-"}
            </p>
            <ErrorLine error={error} />
            <DialogFooter>
              <Button variant="outline" disabled={Boolean(busy)} onClick={() => create(true)}>
                {busy === "draft" ? "Creating…" : "Create draft PR"}
              </Button>
              <Button disabled={Boolean(busy)} onClick={() => create(startDraft)}>
                {busy === "ready" ? "Creating…" : startDraft ? "Create draft PR" : "Create PR"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Attach pull request [D169]: an existing PR (its link, owner/name#n or #n) joins the chat's PRs; the toast's
 * Undo takes it off again.
 */
function AttachPrDialog({ owner, open, onOpenChange }: { owner: string; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attach = async () => {
    const number = /^#?(\d+)$/.exec(text.trim())?.[1];
    const ref = pastedRef(text) ?? (number ? ((await run(["host", owner, "view", number])).pr?.ref as string | undefined) : undefined);
    if (!ref) throw new Error("Paste a pull request link, owner/name#n or #n.");
    await run(["host", owner, "attach", ref]);
    return ref;
  };
  const go = () => {
    setBusy(true);
    setError(null);
    attach()
      .then((ref) => {
        onOpenChange(false);
        setText("");
        showToast("Pull request associated with this chat", { actions: [{ label: "Undo", run: () => void run(["host", owner, "detach", ref]).catch((cause) => showToast(errorText(cause), { tone: "error" })) }] });
      })
      .catch((cause) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Attach pull request</DialogTitle>
        </DialogHeader>
        <Input autoFocus aria-label="Existing pull request" placeholder="Existing pull request" value={text} disabled={busy} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => event.key === "Enter" && text.trim() && go()} />
        <ErrorLine error={error} />
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={busy || !text.trim()} onClick={go}>
            Attach
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type CreateAsk = { owner: string; repo: string | null; branch: string | null; changed: boolean; draft?: boolean };
type Ask = ({ kind: "create" } & CreateAsk) | { kind: "attach"; owner: string };

let showAsk: ((ask: Ask) => void) | null = null;

/** Opens Create PR or Attach pull request; PrDialogHost draws it, outside any popover that a click inside would close. */
export function openPrDialog(ask: Ask): void {
  showAsk?.(ask);
}

/** Where `openPrDialog` shows its dialog: mounted once. */
export function PrDialogHost() {
  const [ask, setAsk] = useState<Ask | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    showAsk = (next) => (setAsk(next), setOpen(true));
    return () => {
      showAsk = null;
    };
  }, []);
  if (!ask) return null;
  return ask.kind === "create" ? <CreatePrDialog key={ask.owner} ask={ask} open={open} onOpenChange={setOpen} /> : <AttachPrDialog key={ask.owner} owner={ask.owner} open={open} onOpenChange={setOpen} />;
}
