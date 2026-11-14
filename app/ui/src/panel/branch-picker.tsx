import { type RefObject, useEffect, useState } from "react";

import type { BranchRead } from "./source/branch-ops";
import type { SourceData, SourceOps } from "./source/data";
import { BranchNameBox, folderItems, QuickPick } from "./source/quick-pick";

/** The quick pick or name box open under the branch: `from` lists branches to create one from. */
export type Picker = "branch" | "create" | "from" | null;

/**
 * The branch's quick pick, D1021's, anchored under `anchor` [D1150, D1262]: in your own folder real switching with its
 * search, off while the agent works [D1265], its list read again each time it opens; a worktree's branch has none
 * [D242]. Without `ops` (the gallery) a pick only closes.
 */
export function useBranchPicker({ data, ops, nowMs, anchor }: { data: SourceData; ops?: SourceOps; nowMs: number; anchor: RefObject<Element | null> }) {
  const [picker, setPickerNow] = useState<Picker>(null);
  // What the quick pick lists; undefined while it's read.
  const [read, setRead] = useState<BranchRead | null | undefined>(undefined);
  const [from, setFrom] = useState<string | null>(null);
  const branchOps = ops?.branch;
  const state = data.source;
  const folder = state?.checkout === "folder";
  const setPicker = (next: Picker) => {
    setPickerNow(next);
    if (!next || next === "create" || !folder || !branchOps) return;
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
          placeholder="Select a branch to switch to"
          search
          items={folderItems(read === undefined && branchOps ? null : (read?.branches ?? data.branches ?? null), state.branch, nowMs)}
          off={(data.agentWorking || read?.working) ? "Branches can't switch while the agent is working." : null}
          onPick={(item) => {
            setPicker(null);
            if (item.id === "create") {
              setFrom(null);
              setPicker("create");
            } else if (item.id === "createFrom") setPicker("from");
            else branchOps?.switchTo(item.title, item.id.startsWith("true:"));
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === "from" && (
        <QuickPick
          place={{ anchor }}
          placeholder="Select a ref to create the branch from"
          // The branches but the checked-out one, as the folder's list has them.
          items={read === undefined && branchOps ? null : (folderItems(read?.branches ?? data.branches ?? [], state.branch, nowMs)?.slice(2) ?? null)}
          onPick={(item) => {
            setPicker(null);
            setFrom(item.title);
            setPickerNow("create");
          }}
          onClose={() => setPicker(null)}
        />
      )}
      {picker === "create" && (
        <BranchNameBox
          place={{ anchor }}
          placeholder="New branch name"
          hint={`Enter creates it from ${from ?? state.branch ?? "what is checked out"} and switches to it`}
          onName={(name) => {
            setPicker(null);
            branchOps?.create(name, from);
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </>
  );

  return {
    picker,
    folder,
    open: (next: Picker) => {
      if (next === "create") setFrom(null);
      setPicker(next);
    },
    pickers,
  };
}
