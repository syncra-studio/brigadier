import { useEffect, useState } from "react";

import { Badge } from "../components/badge";
import { cx } from "../components/cx";
import { Dialog, DialogContent } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { CodeLines } from "../files/code-lines";
import { CodeFileHeader, formatBytes } from "../files/viewer";
import { Spinner, X } from "../icons";
import { errorText } from "../onboarding/api";
import type { Kind } from "./plugins";

/** One file View shows, as Rust's `plugins show` says it: a skill's SKILL.md (`own` where you added it), or a server's settings as `<name>.json`, every value hidden. */
export type Shown = { name: string; path: string; text: string; own?: boolean };

/**
 * View, the old app's Open [D582, D600]: an item's files in a dialog the size of a file tab, each drawn as a file tab
 * draws a file, read only. A skillset's skills are its tabs; a skill you added shows in Finder, to edit it there.
 */
export function ViewDialog({ title, kind, at, read, reveal, onClose }: { title: string; kind: Kind; at?: string; read: () => Promise<Shown[]>; reveal: (name: string) => Promise<unknown>; onClose: () => void }) {
  const [files, setFiles] = useState<Shown[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    let live = true;
    read().then(
      (found) => {
        if (!live) return;
        setFiles(found);
        setShown(Math.max(0, found.findIndex((each) => each.name === at)));
      },
      (cause: unknown) => live && setFailed(errorText(cause)),
    );
    return () => {
      live = false;
    };
  }, []);
  const file = files?.[shown] ?? null;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-dialog="plugin-file" aria-label={title} showCloseButton={false} frame="max-w-plugin-file h-plugin-file-height overflow-hidden p-0">
        {/* The card is a grid: one column holds the header, tabs and text. */}
        <div className="flex min-h-0 flex-col">
        <CodeFileHeader
          path={file?.path ?? title}
          gone={false}
          onReveal={file?.own ? () => void reveal(file.name).catch((cause: unknown) => setFailed(errorText(cause))) : undefined}
          actions={
            <TooltipIconButton tooltip="Close" size="icon-sm" onClick={onClose}>
              <X />
            </TooltipIconButton>
          }
        >
          {file && (
            <Badge variant="secondary" title={kind === "server" ? "Server settings are read only here." : undefined}>
              Read only
            </Badge>
          )}
          {file && <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(new TextEncoder().encode(file.text).length)}</span>}
        </CodeFileHeader>
        {files && files.length > 1 && (
          <div role="tablist" aria-label="Skills" className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-3 py-1.5">
            {files.map((each, index) => (
              <button
                key={each.path}
                type="button"
                role="tab"
                aria-selected={index === shown}
                onClick={() => setShown(index)}
                className={cx("flex h-7 shrink-0 cursor-pointer items-center rounded-capsule px-3 text-label", index === shown ? "bg-fill" : "text-quiet-foreground")}
              >
                {each.name}
              </button>
            ))}
          </div>
        )}
        {file && kind === "skill" && (
          <p data-slot="read-only-reason" className="shrink-0 border-b border-border px-4 py-1.5 text-xs text-muted-foreground">
            {file.own ? "Open this file in your editor to change its instructions." : "It came from Browse: an update would replace any edits."}
          </p>
        )}
        {failed ? (
          <ErrorLine error={failed} className="p-4" />
        ) : !file ? (
          <Spinner aria-label="Opening" className="m-auto size-icon-md animate-spin text-muted-foreground" />
        ) : (
          <CodeLines key={file.path} text={file.text} path={file.path} active />
        )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
