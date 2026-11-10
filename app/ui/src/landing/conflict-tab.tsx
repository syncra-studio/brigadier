import { Fragment, type ReactNode, useRef } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import type { Accepting, Choice, Conflict, ConflictFile } from "./conflicts";
import { Sparkles } from "./icons";
import { StepCounter } from "./step-counter";

/**
 * A conflicted file's conflicts in place, as the old conflict tab drew them [D48, D1044]: each with Accept Current
 * Change, Accept Incoming Change, Accept Both Changes and Compare Changes, ↑↓ between them, the current side blue
 * and the incoming green. Resolve with agent in its header leaves a chip above the composer and sends nothing
 * [D1019, D1044]. An accept shows at once and settles by the conflict's id when Rust sends the file again [D30].
 */
export function ConflictTab({
  file,
  error,
  offline = false,
  accepting = {},
  onAccept,
  onCompare,
  onResolveWithAgent,
}: {
  /** undefined while it loads. */
  file: ConflictFile | undefined;
  /** Why the file couldn't be read. */
  error?: string;
  /** The daemon is gone: the file as last read, its actions off. */
  offline?: boolean;
  accepting?: Readonly<Record<string, Accepting>>;
  onAccept: (conflict: string, choice: Choice) => void;
  onCompare: () => void;
  onResolveWithAgent: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const at = useRef(-1);
  if (!file) {
    return (
      <div data-slot="conflict-tab" className="flex min-h-0 flex-1 items-center justify-center p-4 text-sm text-muted-foreground">
        {error ? <ErrorLine size="sm" error={error} /> : "Loading…"}
      </div>
    );
  }
  const count = file.segments?.filter((segment) => segment.type === "conflict").length ?? 0;
  const step = (by: 1 | -1) => {
    at.current = (at.current + by + count) % count;
    root.current?.querySelector(`[data-conflict="${at.current}"]`)?.scrollIntoView({ block: "center" });
  };
  const rows: Row[] = [];
  let seen = -1;
  for (const segment of file.segments ?? []) {
    if (segment.type === "common") {
      for (const text of segment.lines) rows.push({ kind: "line", text });
      continue;
    }
    seen += 1;
    const pending = accepting[segment.id];
    rows.push({ kind: "lens", conflict: seen, content: <ConflictLens conflict={segment} pending={pending} offline={offline} onAccept={onAccept} onCompare={onCompare} /> });
    rows.push(...markedRows(segment));
  }
  return (
    <div ref={root} data-slot="conflict-tab" className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex h-control-lg shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="flex-1 truncate px-1.5 text-sm text-muted-foreground">{file.path}</span>
        {(offline || (count === 0 && file.segments !== null)) && (
          <span className="px-1.5 text-xs text-muted-foreground">{offline ? "Reconnecting…" : "No conflicts left"}</span>
        )}
        <Button variant="soft" size="xs" className="me-1" disabled={offline} onClick={onResolveWithAgent}>
          <Sparkles />
          Resolve with agent
        </Button>
        <StepCounter noun="conflict" onStep={step} enabled={count > 0} />
      </div>
      {file.rebasing && (
        <div data-slot="conflict-rebase" className="flex h-control-sm shrink-0 items-center border-b border-border px-3.5 text-xs text-muted-foreground">
          <span className="truncate">
            Rebasing {file.rebasing.step} of {file.rebasing.total}
            {file.rebasing.subject && <span className="text-foreground">: {file.rebasing.subject}</span>}
          </span>
        </div>
      )}
      {file.segments === null ? (
        <p className="p-4 text-sm text-muted-foreground">
          One side deleted this file. Stage it in the Source panel to keep it deleted, or discard it to keep your version.
        </p>
      ) : (
        <Code rows={rows} />
      )}
    </div>
  );
}

const CHOICE_WORDS: Record<Choice, string> = { current: "Current", incoming: "Incoming", both: "Both" };

/** The actions over one conflict; while its accept is on the way, what was picked; if that failed, why, and the actions again. */
function ConflictLens({
  conflict,
  pending,
  offline,
  onAccept,
  onCompare,
}: {
  conflict: Conflict;
  pending: Accepting | undefined;
  offline: boolean;
  onAccept: (conflict: string, choice: Choice) => void;
  onCompare: () => void;
}) {
  if (pending && !pending.error) return <span>Accepting {CHOICE_WORDS[pending.choice]} Change…</span>;
  const off = offline;
  const lens = (
    <Lens
      actions={[
        { label: "Accept Current Change", run: () => onAccept(conflict.id, "current"), disabled: off },
        { label: "Accept Incoming Change", run: () => onAccept(conflict.id, "incoming"), disabled: off },
        { label: "Accept Both Changes", run: () => onAccept(conflict.id, "both"), disabled: off },
        { label: "Compare Changes", run: onCompare },
      ]}
    />
  );
  return pending?.error ? <ErrorLine error={`Failed to accept the change: ${pending.error}`} actions={lens} /> : lens;
}

/** One shown row: a numbered line, tinted by its side, or a row of actions over a conflict. */
type Row = { kind: "line"; text: string; tint?: Tint; muted?: string } | { kind: "lens"; content: ReactNode; conflict: number };

type Tint = "currentHead" | "current" | "incoming" | "incomingHead" | "base";

const TINT: Record<Tint, string> = {
  currentHead: "bg-conflict-current-head",
  current: "bg-conflict-current",
  incoming: "bg-success-wash",
  incomingHead: "bg-success-border",
  base: "bg-muted",
};

function Code({ rows }: { rows: Row[] }) {
  let number = 0;
  return (
    <div className="min-h-0 flex-1 overflow-auto py-2 font-mono text-diff">
      {rows.map((row, index) => {
        if (row.kind === "lens") {
          return (
            <div key={index} data-conflict={row.conflict} data-slot="conflict-lens" className="flex min-h-5 items-center ps-14 font-sans text-xs text-muted-foreground">
              {row.content}
            </div>
          );
        }
        number += 1;
        return (
          <div key={index} className={cx("flex min-h-5 leading-5 whitespace-pre", row.tint && TINT[row.tint])}>
            <span className="w-12 shrink-0 pe-4 text-end text-muted-foreground select-none">{number}</span>
            <span className="pe-4">
              {row.text.replace(/\r?\n$/, "")}
              {row.muted && <span className="text-muted-foreground"> {row.muted}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** Actions in a row, split by bars, as the editor shows them over a conflict. */
function Lens({ actions }: { actions: { label: string; run: () => void; disabled?: boolean }[] }) {
  return (
    <>
      {actions.map((action, index) => (
        <Fragment key={action.label}>
          {index > 0 && <span className="px-1">|</span>}
          <button
            type="button"
            disabled={action.disabled}
            onClick={action.run}
            className="cursor-pointer rounded-xs hover:text-foreground hover:underline focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-disabled"
          >
            {action.label}
          </button>
        </Fragment>
      ))}
    </>
  );
}

/** A conflict's lines as git marked them, each side tinted. */
function markedRows(conflict: Conflict): Row[] {
  const marker = (mark: string, label: string) => `${mark.repeat(conflict.size)} ${label}`.trimEnd();
  return [
    { kind: "line", text: marker("<", conflict.currentLabel), tint: "currentHead", muted: "(Current Change)" },
    ...conflict.current.map((text): Row => ({ kind: "line", text, tint: "current" })),
    ...(conflict.base
      ? [
          { kind: "line" as const, text: marker("|", conflict.baseLabel), tint: "base" as const },
          ...conflict.base.map((text): Row => ({ kind: "line", text, tint: "base" })),
        ]
      : []),
    { kind: "line", text: "=".repeat(conflict.size) },
    ...conflict.incoming.map((text): Row => ({ kind: "line", text, tint: "incoming" })),
    { kind: "line", text: marker(">", conflict.incomingLabel), tint: "incomingHead", muted: "(Incoming Change)" },
  ];
}
