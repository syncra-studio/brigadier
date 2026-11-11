import { type RefObject, useEffect, useState } from "react";

import { copyWithToast } from "../components/copy-button";
import type { BranchRead } from "./source/branch-ops";
import type { SourceData, SourceOps } from "./source/panel";
import { BranchNameBox, folderItems, QuickPick, sessionItems } from "./source/quick-pick";

/** The quick pick or name box open under the branch: `from`, `base` and `newSession` list branches to pick. */
export type Picker = "branch" | "rename" | "create" | "from" | "base" | "newSession" | null;

/**
 * The branch's quick pick, D1021's, anchored under `anchor` [D1150, D1262]: in a session Copy name, Rename branch…,
 * Change what it lands into…, Open on the host and New session from another branch…, no search; in your own folder
 * real switching with its search, off while the agent works [D1265]. Its list is read again each time it opens.
 * Without `ops` (the gallery) a pick only closes.
 */
export function useBranchPicker({ data, ops, base, nowMs, anchor }: { data: SourceData; ops?: SourceOps; base: string | null; nowMs: number; anchor: RefObject<Element | null> }) {
  const [picker, setPickerNow] = useState<Picker>(null);
  // What the quick pick lists; undefined while it's read.
  const [read, setRead] = useState<BranchRead | null | undefined>(undefined);
  const [from, setFrom] = useState<string | null>(null);
  const branchOps = ops?.branch;
  const state = data.source;
  const folder = state?.checkout === "folder";
  const setPicker = (next: Picker) => {
    setPickerNow(next);
    if (!next || next === "create" || !branchOps) return;
    setRead(undefined);
    // A read that failed has said why: the pick closes rather than load for ever.
    branchOps.read((answer) => (answer ? setRead(answer) : setPickerNow(null)));
  };
  // The pickers float outside the card's inert part: a disconnect closes them.
  const offline = data.offline ?? false;
  useEffect(() => {
    if (offline) setPickerNow(null);
  }, [offline]);

  const pickers = state && (
    <>
      {picker === "branch" && (
        <QuickPick
          place={{ anchor }}
          placeholder={folder ? "Select a branch to switch to" : "This session works on its own branch"}
          search={folder}
          items={folder ? folderItems(read === undefined && branchOps ? null : (read?.branches ?? data.branches ?? null), state.branch, nowMs) : sessionItems(read?.base ?? base ?? "main", read ? (read.page && read.host) : (data.host ?? null))}
          off={folder && (data.agentWorking || read?.working) ? "Branches can't switch while the agent is working." : null}
          onPick={(item) => {
            setPicker(null);
            if (item.id === "rename") setPicker("rename");
            else if (item.id === "create") {
              setFrom(null);
              setPicker("create");
            } else if (item.id === "createFrom") setPicker("from");
            else if (item.id === "lands") setPicker("base");
            else if (item.id === "new") setPicker("newSession");
            else if (item.id === "copy" && state.branch) copyWithToast(state.branch, "branch name");
            else if (item.id === "open" && read?.page) branchOps?.openPage(read.page);
            else if (folder) branchOps?.switchTo(item.title, item.id.startsWith("true:"));
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {(picker === "from" || picker === "base" || picker === "newSession") && (
        <QuickPick
          place={{ anchor }}
          placeholder={picker === "from" ? "Select a ref to create the branch from" : picker === "base" ? `What ${state.branch ?? "this branch"} lands into` : "Select a branch to start a session from"}
          // The branches but the checked-out one, as the folder's list has them; Home starts a session from a local one.
          // The base it lands into now is marked in the row's description, as VS Code marks the current item.
          items={read === undefined && branchOps ? null : (folderItems((read?.branches ?? data.branches ?? []).filter((each) => picker !== "newSession" || !each.remote), state.branch, nowMs)?.slice(2).map((item) => (picker === "base" && item.title === (read?.base ?? base) ? { ...item, hint: `current · ${item.hint}` } : item)) ?? null)}
          onPick={(item) => {
            setPicker(null);
            if (picker === "from") {
              setFrom(item.title);
              setPickerNow("create");
            } else if (picker === "base") branchOps?.setBase(item.title);
            else branchOps?.newSession(item.title);
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {(picker === "rename" || picker === "create") && (
        <BranchNameBox
          place={{ anchor }}
          placeholder={picker === "create" ? "New branch name" : "New name for the branch"}
          hint={picker === "rename" ? `Enter renames ${state.branch ?? "the branch"}${read?.prs?.length ? " · The PR stays on the old name" : ""}` : `Enter creates it from ${from ?? state.branch ?? "what is checked out"} and switches to it`}
          initial={picker === "rename" ? (state.branch ?? "") : ""}
          onName={(name) => {
            setPicker(null);
            if (picker === "rename") branchOps?.rename(name);
            else branchOps?.create(name, from);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );

  return {
    picker,
    open: (next: Picker) => {
      if (next === "create") setFrom(null);
      setPicker(next);
    },
    pickers,
  };
}
