import { useCallback, useEffect, useRef, useState } from "react";

import { ErrorLine } from "../components/error-line";
import { daemonRun } from "../session/composer";
import { HOME } from "./tab-store";

/** How long typing rests before an edit is kept, as the old app's. */
const KEEP_AFTER_MS = 500;

/**
 * The composer's pasted text in its own tab, as the old app's PastedTextView: a page to edit it on, each edit kept by
 * Rust under the same id once typing rests and as the tab goes, so Send carries it. Sent or taken out, it says so [D2098].
 */
export function PasteTab({ owner, id }: { owner: string; id: string }) {
  const [text, setText] = useState<string | null>(null);
  const [state, setState] = useState<{ gone: true } | { error: string } | null>(null);
  const pending = useRef<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void daemonRun(["attach", owner, "list"]).then(async (reply) => {
      if (!reply.ok) return live && setState({ error: String(reply.error ?? "Couldn't read this pasted text.") });
      if (!reply.files.some((file: { id: string; sent: boolean }) => file.id === id && !file.sent)) return live && setState({ gone: true });
      const response = await fetch(`/attachment/${owner === HOME ? "home" : owner}/${id}`).catch(() => null);
      const body = response?.ok ? await response.text() : null;
      if (live) body === null ? setState({ error: "Couldn't read this pasted text." }) : setText(body);
    });
    return () => {
      live = false;
    };
  }, [owner, id]);
  const keep = useCallback(() => {
    window.clearTimeout(timer.current);
    const next = pending.current;
    if (next === null) return;
    pending.current = null;
    void daemonRun(["attach", owner, "write", id, next]).then((reply) => {
      if (reply.ok) return;
      setState(String(reply.error).includes("no longer") ? { gone: true } : { error: String(reply.error ?? "Couldn't keep this edit.") });
    });
  }, [owner, id]);
  // Closed with an edit not yet kept: it's kept now.
  useEffect(() => keep, [keep]);
  return (
    <div data-slot="paste-tab" className="min-h-0 flex-1 overflow-y-auto px-5 pt-15 pb-32">
      <div className="mx-auto w-full max-w-184">
        {state && "gone" in state ? (
          <p className="text-sm text-muted-foreground">This pasted text is no longer in the message.</p>
        ) : state ? (
          <ErrorLine size="sm" error={state.error} />
        ) : (
          text !== null && (
            <textarea
              aria-label="Pasted text"
              defaultValue={text}
              spellCheck={false}
              onChange={(event) => {
                pending.current = event.target.value;
                window.clearTimeout(timer.current);
                timer.current = window.setTimeout(keep, KEEP_AFTER_MS);
              }}
              className="block min-h-48 w-full resize-none bg-transparent text-plan whitespace-pre-wrap text-foreground caret-foreground outline-none field-sizing-content"
            />
          )
        )}
      </div>
    </div>
  );
}
