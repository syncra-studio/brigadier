import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { ask, setTermHandler, useDaemon } from "../daemon";

/** The pane's states: the stream loading, the run not started yet, live, ended, failed. */
type State = { is: "loading" | "closed" | "live" | "exited" } | { is: "error"; message: string };

// The 16 colours' tokens: ansi-<name> and ansi-bright-<name>.
const ANSI = ["ansi-black", "ansi-red", "ansi-green", "ansi-yellow", "ansi-blue", "ansi-magenta", "ansi-cyan", "ansi-white"];

/** The terminal in the theme's colours, the old app's tokens. */
function theme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const token = (name: string) => style.getPropertyValue(`--color-${name}`).trim();
  const colors = Object.fromEntries(
    ANSI.map((each) => each.slice("ansi-".length)).flatMap((name) => [
      [name, token(`ansi-${name}`)],
      [`bright${name[0].toUpperCase()}${name.slice(1)}`, token(`ansi-bright-${name}`)],
    ]),
  );
  const [background, foreground, scrim] = ["terminal-background", "terminal-foreground", "scrim"].map(token);
  return { ...colors, background, foreground, cursor: foreground, cursorAccent: background, selectionBackground: scrim };
}

const bytesOf = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/**
 * An account's sign-in (core::SETUP), run by its own host [D45]. The screen is the host's log
 * replayed, so it comes back the same after the app or daemon restarts [D60]. Keys and sizes go to
 * the host, named by the run's spawn id, so a stale one is refused. Close ends the run.
 */
export function TerminalPane({ id, title, onClose }: { id: string; title: string; onClose: () => void }) {
  const { daemon } = useDaemon();
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<{ xterm: Terminal; fit: FitAddon; spawn?: number }>(null);
  const [state, setState] = useState<State>({ is: "loading" });
  const live = state.is === "live" && Boolean(daemon);

  // One xterm per session, kept while the daemon reconnects so the screen never blanks.
  useEffect(() => {
    const element = host.current!;
    const style = getComputedStyle(element);
    const xterm = new Terminal({
      fontFamily: style.fontFamily,
      fontSize: Number.parseFloat(style.fontSize),
      lineHeight: 1.2,
      theme: theme(),
      cursorStyle: "bar",
      cursorBlink: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(element);
    term.current = { xterm, fit };
    const keys = xterm.onData((bytes) => {
      const t = term.current;
      if (t?.spawn !== undefined) ask({ op: "keys", session: id, spawn: t.spawn, bytes });
    });
    return () => {
      keys.dispose();
      xterm.dispose();
      term.current = null;
    };
  }, [id]);

  // The stream: the last terminal replayed from its start, then followed. Asked again on reconnect.
  useEffect(() => {
    const t = term.current;
    if (!t || !daemon) return;
    let mine = -1;
    // The size the pane offers once the stream settles; the host logs it, and it comes back.
    let settle = 0;
    const offerSize = () => {
      clearTimeout(settle);
      settle = window.setTimeout(() => {
        const size = t.fit.proposeDimensions();
        if (!size || t.spawn === undefined || (size.cols === t.xterm.cols && size.rows === t.xterm.rows)) return;
        ask({ op: "resize", session: id, spawn: t.spawn, cols: size.cols, rows: size.rows });
      }, 150);
    };
    // Sizes, starts and ends apply after the bytes before them are drawn: xterm writes later.
    const inOrder = (apply: () => void) => t.xterm.write("", apply);
    setTermHandler((frame) => {
      if (frame.watch !== mine) return;
      if (frame.reset) return void (mine = ask({ op: "terminal", session: id }, opened));
      if (frame.error) return setState({ is: "error", message: frame.error === "not_found" ? "Session not found" : frame.error });
      if (frame.start) {
        const { spawn, cols, rows } = frame.start;
        inOrder(() => {
          t.spawn = spawn;
          t.xterm.reset();
          t.xterm.resize(cols, rows);
          setState({ is: "live" });
          offerSize();
        });
      } else if (frame.resize) {
        const { cols, rows } = frame.resize;
        inOrder(() => {
          t.xterm.resize(cols, rows);
          offerSize();
        });
      } else if (frame.exited) {
        inOrder(() => {
          t.spawn = undefined;
          setState({ is: "exited" });
        });
      } else if (frame.data) {
        const bytes = bytesOf(frame.data);
        // Acked once drawn, so the daemon sends no faster than xterm draws.
        t.xterm.write(bytes, () => ask({ op: "term_ack", bytes: bytes.length }));
      }
    });
    function opened(reply: Record<string, any>) {
      if (!reply.ok) return setState({ is: "error", message: reply.error });
      if (!reply.found) setState({ is: "closed" });
    }
    mine = ask({ op: "terminal", session: id }, opened);
    const observer = new ResizeObserver(offerSize);
    observer.observe(host.current!);
    return () => {
      clearTimeout(settle);
      observer.disconnect();
      setTermHandler(undefined);
    };
  }, [id, daemon]);

  useEffect(() => {
    if (term.current) term.current.xterm.options.disableStdin = !live;
    if (live) term.current?.xterm.focus();
  }, [live]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-terminal-background">
      <header className="flex h-control-md shrink-0 items-center gap-2 px-3 text-sm text-muted-foreground">
        <span className="flex-1 truncate">{title}</span>
        <Button size="xs" variant="ghost" onClick={onClose}>
          Close
        </Button>
      </header>
      <div className={`relative min-h-0 flex-1 ${daemon ? "" : "opacity-disabled"}`}>
        <div ref={host} className="absolute inset-0 px-3 font-mono text-xs" />
        {(state.is === "closed" || state.is === "error") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-terminal-background text-sm">
            {state.is === "closed" && <p className="text-muted-foreground">Starting…</p>}
            {state.is === "error" && <p className="text-destructive">{state.message}</p>}
          </div>
        )}
        {/* It keeps its last screen: that is the sign-in's result. */}
        {state.is === "exited" && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 border-t border-divider bg-terminal-background py-2 text-sm">
            <span className="text-muted-foreground">The terminal ended</span>
          </div>
        )}
      </div>
    </section>
  );
}
