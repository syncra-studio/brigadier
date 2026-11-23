import { useContext, useEffect, useState } from "react";

import { SessionOfThread } from "../accounts/limit";
import { Button } from "../components/button";
import { ToolRow } from "../components/thread/tool";
import { ask } from "../daemon";
import { openTab } from "../shell/tab-store";
import { typeIn } from "../terminal/terminal";
import { isStopKey, running as inView } from "./bang";
import type { Item } from "../thread/item";

/**
 * A `!` command's row [D316]: "Running ‹command›", then "Ran", opening to its Shell box, its output read again every 2 s
 * while it runs; Stop, or Ctrl+C in an empty composer, while it runs [D320], and Open in terminal, which runs it again in a new terminal tab.
 */
export function BangRow({ item }: { item: Extract<Item, { kind: "shell" }> }) {
  const session = useContext(SessionOfThread)?.id;
  const running = item.progress === "running";
  const [live, setLive] = useState("");
  useEffect(() => {
    if (!running || !session) return;
    // shortcut: read whole every 2 s while it runs; stream it as the terminal does if long runs get heavy.
    const read = () => ask({ op: "run", args: ["shell", session, "output", item.cmd] }, (reply) => void (reply.ok && setLive(String(reply.output))));
    read();
    const timer = window.setInterval(read, 2000);
    return () => clearInterval(timer);
  }, [running, session, item.cmd]);
  useEffect(() => {
    if (!running || !session) return;
    inView.push(item.cmd);
    const onKey = (event: KeyboardEvent) => {
      if (inView.at(-1) !== item.cmd || !isStopKey(event)) return;
      event.preventDefault();
      ask({ op: "run", args: ["shell", session, "stop", item.cmd] });
    };
    window.addEventListener("keydown", onKey, true);
    return () => (inView.splice(inView.indexOf(item.cmd), 1), window.removeEventListener("keydown", onKey, true));
  }, [running, session, item.cmd]);
  const again = () => session && typeIn.set(openTab(session, "terminal"), item.command);
  return (
    <div className="flex min-w-0 flex-col">
      <ToolRow keep={item.id} kind="run" name="" input={item.command} output={running ? live : item.output} progress={item.progress} exitCode={item.exitCode} line={item.command} />
      {item.error && <p className="ps-6 text-sm text-destructive">{item.error}</p>}
      {session && (
        <div className="flex gap-1 ps-5">
          {running && (
            <Button size="xs" variant="ghost" onClick={() => ask({ op: "run", args: ["shell", session, "stop", item.cmd] })}>
              Stop
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={again}>
            Open in terminal
          </Button>
        </div>
      )}
    </div>
  );
}
