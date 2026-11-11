import { useSyncExternalStore } from "react";

import { showToast } from "../../components/toast";
import { addChip } from "../chips";
import type { GitAct, GitStep } from "../control";
import { useDaemon } from "../../daemon";
import { commitFiles, gitMove, landBranch, refreshStep, type Target, useGit } from "../git";
import { gitDone, gitFailed } from "../notice";
import { read as readPr, useCreatePr } from "./create-pr";
import type { SourceData } from "./data";

/** The control's act under way, by checkout: it outlives the view, and ends once the step it led to shows [D30, D1143]. */
const running = new Map<string, GitAct | "resolve">();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const keyOf = (target: Target | null) => (target ? JSON.stringify(target) : "");
const setRunning = (key: string, act: GitAct | "resolve" | null) => {
  if (act) running.set(key, act);
  else running.delete(key);
  for (const listener of listeners) listener();
};

/** A move's refusal: Rust's plain sentence, or ours with git's own words behind Details [D1142, D1264]. */
function failed(target: Target | null, said: string, error: string) {
  const at = error.indexOf("\n\n");
  if (at >= 0) return gitFailed(target, error.slice(0, at), error.slice(at + 2));
  if (!error.includes("\n")) return gitFailed(target, error);
  gitFailed(target, said, error);
}

/** A commit's success toast: its subject, shown under "Committed" [D1309]. */
const committed = (message: unknown) => `Committed · ${String(message ?? "").split("\n")[0]}`;

/** What Resolve with agent's chip asks: the operation and ref that really conflict, from Rust [D1093, D1290]. */
function resolveChip(session: string, step: GitStep) {
  const resolve = step.resolve;
  if (!resolve) return;
  const { op, ref, files } = resolve;
  const doing = op === "pull" ? `Pull ${ref} into this branch` : `Merge ${ref} into this branch`;
  const text = `${doing} and resolve the conflicts${files.length ? ` in ${files.join(", ")}` : ""}. Keep what both sides meant, then commit the merge.`;
  const chip = { id: `resolve:${op}:${ref}`, kind: "resolve" as const, conflicts: files.length, files: files.length, operation: op === "pull" ? ("pulling" as const) : ("merging" as const), onto: ref };
  addChip(session, { kind: "agent", id: crypto.randomUUID(), key: chip.id, pr: null, chip, text });
}

/**
 * The card's control's model (2.48) [D1278, D1285, D1286]: Rust's step, why the whole control can't run now, the act
 * under way, and each act as Rust's own move, its failure the notice above the composer [D1264]. Off while the
 * session's agent works, git can't be read or the daemon is away [D30, D1208, D1252]. `session`: whose PR and chip;
 * none in the gallery, where nothing moves.
 */
export function useSourceStep({ data, session = null }: { data: SourceData; session?: string | null }) {
  const target = useGit().target;
  const key = keyOf(target);
  const now = useSyncExternalStore(subscribe, () => running.get(key) ?? null);
  const pr = useCreatePr(session);
  // The watch's kept PRs [D1009], with a PR just made shown at once until a read lists it by number; another branch's kept PRs never bring it back [D30].
  const rows = useDaemon().rows;
  const kept = data.kept ?? rows?.find((row) => row.id === session)?.prs ?? undefined;
  const made = pr.fresh.filter((each) => (!kept?.branch || kept.branch === each.branch) && !kept?.prs.some((known) => known.number === each.number));
  const step = data.step;
  const off = data.offline ? "Brigadier isn't connected" : data.error ? "Git can't be read right now" : data.agentWorking ? "Waits for the turn to finish" : null;

  const run = (act: GitAct | "resolve") => {
    if (!step || off || now) return;
    // A host its CLI can't make PRs on gets its own page, pushed first [D1030].
    if (act === "createPr") return pr.onPick(pr.way === "page" ? "openPrPage" : "createPr");
    if (!session) return;
    if (act === "resolve") return resolveChip(session, step);
    const at = data.at ?? null;
    setRunning(key, act);
    // A failure is the composer's notice [D1264]; a success one short toast that goes by itself, in short words [D1309].
    const done = (said: string, ok: string) => (error: string | null) => {
      setRunning(key, null);
      if (error) return failed(target, said, error);
      gitDone(target);
      showToast(ok, { tone: "success" });
      // A push may have published the branch: its PRs are read now, which the watch then follows [D1047].
      if (act === "push" || act === "sync") readPr(session);
    };
    const base = step.base ?? "main";
    const branch = data.source?.branch ?? step.branch ?? "the branch";
    switch (act) {
      case "commit": {
        // One click, the writer's message; a writer failure says why, commits nothing and offers Type a message… [D1281, D1293, D1324].
        const sent = commitFiles(true, "", (reply) => {
          if (reply.ok) {
            gitDone(target);
            // The toast with the step it led to, not before it [D1309].
            return refreshStep(() => {
              setRunning(key, null);
              showToast(committed(reply.message), { tone: "success" });
            });
          }
          setRunning(key, null);
          if (reply.writer) gitFailed(target, reply.error ? `Couldn't write a commit message: ${reply.error}` : "Couldn't write a commit message.", reply.details ?? "", true);
          else failed(target, "Couldn't commit.", reply.error === "disconnected" ? "Brigadier isn't connected." : String(reply.error));
        });
        if (!sent) done("Couldn't commit.", "")("This checkout isn't on screen.");
        return;
      }
      case "push":
        // A branch with no upstream is published [D1045]; one with an upstream only pushed, nothing pulled.
        return gitMove([data.source?.upstream ? "push" : "publish"], done("Couldn't push.", `Pushed ${branch}`));
      case "sync":
        return gitMove(["sync"], done("Couldn't sync.", `Synced ${branch}`));
      case "catchUp":
        return at ? gitMove(["catch-up", at.head, at.base ?? "-"], done("Couldn't catch up.", `Caught up with ${base}`)) : done("", "")("Look again.");
      case "merge":
        return landBranch(at, done(`Couldn't merge into ${base}.`, `Merged into ${base}`));
    }
  };

  return { prs: data.prs ?? (kept ? [...kept.prs, ...made] : pr.prs), kept, step, off, running: now, run, dialogs: pr.dialog };
}
