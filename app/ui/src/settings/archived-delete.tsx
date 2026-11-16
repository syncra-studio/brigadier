import { useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { ConfirmForm } from "../components/confirm-dialog";
import { ErrorLine } from "../components/error-line";
import { Radio, RadioGroup } from "../components/radio";
import { showToast } from "../components/toast";
import { ask } from "../daemon";
import { hideDeleting } from "../sessions/archive";
import { readDelete } from "../sessions/archived";

type Check = { state: "checking" } | { state: "done"; branch: string | null } | { state: "failed"; error: string };

const titleOf = (row: { title: string }) => row.title || "New session";

/**
 * Delete (N)… and Delete all…: DeleteForm's workflow for several sessions in one confirm [D35, D181]. Each
 * branch with work that never landed is named, kept unless asked; Delete waits for every check.
 */
export function DeleteManyForm({ rows, first, onClose }: { rows: { id: string; title: string }[]; first: Check[]; onClose: () => void }) {
  const [checks, setChecks] = useState<Record<string, Check>>(() => Object.fromEntries(rows.map((row, at) => [row.id, first[at]!])));
  const [drop, setDrop] = useState("keep");
  const live = useRef(true);
  const check = (id: string) => {
    setChecks((now) => ({ ...now, [id]: { state: "checking" } }));
    void readDelete(id).then((next) => live.current && setChecks((now) => ({ ...now, [id]: next })));
  };
  // The rows and their first checks come with it; Retry reads again.
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const of = (id: string): Check => checks[id] ?? { state: "checking" };
  const failed = rows.filter((row) => of(row.id).state === "failed");
  const branched = rows.flatMap((row) => {
    const each = of(row.id);
    return each.state === "done" && each.branch ? [{ row, branch: each.branch }] : [];
  });
  const confirm = () => {
    onClose();
    for (const row of rows) {
      const each = of(row.id);
      const branch = each.state === "done" && each.branch && drop === "delete" ? "delete" : "keep";
      hideDeleting(row.id, true);
      ask({ op: "run", args: ["delete", row.id, "--branch", branch] }, (reply) => {
        if (reply.ok) return;
        hideDeleting(row.id, false);
        const why = reply.left?.[0] ?? (reply.error === "disconnected" ? "Brigadier isn't running" : (reply.message ?? reply.error ?? "it failed"));
        showToast(`Couldn't delete “${titleOf(row)}”: ${why}`, { tone: "error" });
      });
    }
  };
  const many = `${rows.length} session${rows.length === 1 ? "" : "s"}`;
  return (
    <ConfirmForm
      title={`Delete ${many}?`}
      description={`This permanently deletes ${many}. This can't be undone.`}
      confirm={`Delete ${many}`}
      destructive
      disabled={!rows.every((row) => of(row.id).state === "done")}
      onConfirm={confirm}
      onCancel={onClose}
    >
      {rows.some((row) => of(row.id).state === "checking") && <p className="text-xs text-muted-foreground">Checking their branches…</p>}
      {failed.length > 0 && (
        <div className="flex items-start gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            {failed.map((row) => {
              const each = of(row.id);
              return <ErrorLine key={row.id} error={`Couldn't check the branch of “${titleOf(row)}”: ${each.state === "failed" ? each.error : ""}`} />;
            })}
          </div>
          <Button variant="ghost" size="sm" onClick={() => failed.forEach((row) => check(row.id))}>
            Retry
          </Button>
        </div>
      )}
      {branched.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <p className="text-xs text-muted-foreground">{branched.length === 1 ? "This branch has" : "These branches have"} work that never landed:</p>
          <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
            {branched.map(({ row, branch }) => (
              <li key={row.id} className="truncate">
                <code className="font-mono text-foreground">{branch}</code> · {titleOf(row)}
              </li>
            ))}
          </ul>
          <RadioGroup value={drop} onValueChange={(value) => setDrop(String(value))} className="flex flex-col gap-2">
            <label className="flex items-center gap-2 text-sm">
              <Radio value="keep" />
              {branched.length === 1 ? "Keep branch" : "Keep branches"}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Radio value="delete" />
              {branched.length === 1 ? "Delete it too" : "Delete them too"}
            </label>
          </RadioGroup>
        </div>
      )}
    </ConfirmForm>
  );
}
