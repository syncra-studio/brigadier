import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useCallback, useEffect, useRef, useState } from "react";

import { openLink, swapped } from "../browser/links";
import { Button } from "../components/button";
import { EmptyState } from "../components/empty-state";
import { Dock } from "../icons";
import { own } from "../shell/tab-store";
import { ask, termHandlers, useDaemon } from "../daemon";

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
 * A terminal on its own host: a setup run's output (core::SETUP: an install, update or sign-in) under its line's Show
 * output [D45, D29], or a terminal tab's shell (core::TERM) [D315]. The screen is the host's log replayed, so it comes
 * back the same after the app or daemon restarts [D60]. Keys and sizes go to the host, named by the run's spawn id, so
 * a stale one is refused. `ended`: its host is gone with no exit logged (the Mac restarted); `onRestart` offers a new
 * one once it ends; `onGone`: its folder went (a sweep took it); `active`: it may take the keyboard.
 */
export function TerminalPane({ id, ended, onRestart, onGone, active = true }: { id: string; ended?: boolean; onRestart?: () => void; onGone?: () => void; active?: boolean }) {
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
      // OSC 8 links.
      linkHandler: { activate: (event, uri) => openLink(uri, { swap: swapped(event) }) },
    });
    const fit = new FitAddon();
    xterm.loadAddon(fit);
    xterm.open(element);
    term.current = { xterm, fit };
    // ⌘C copies a selection (else it's the shell's ^C as typed), ⌘K clears, as the old app's terminal did.
    xterm.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown" || !event.metaKey) return true;
      if (event.key === "c" && xterm.hasSelection()) {
        void navigator.clipboard.writeText(xterm.getSelection());
        return false;
      }
      if (event.key === "k") {
        xterm.clear();
        return false;
      }
      return true;
    });
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
    const handler = (frame: Record<string, any>) => {
      if (frame.watch !== mine) return;
      if (frame.reset) return void (mine = ask({ op: "terminal", session: id }, opened));
      if (frame.error === "not_found" && onGone) return onGone();
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
        t.xterm.write(bytes, () => ask({ op: "term_ack", term: id, bytes: bytes.length }));
      }
    };
    termHandlers.add(handler);
    function opened(reply: Record<string, any>) {
      if (!reply.ok && reply.error === "not_found" && onGone) return onGone();
      if (!reply.ok) return setState({ is: "error", message: reply.error });
      if (!reply.found) setState({ is: "closed" });
    }
    mine = ask({ op: "terminal", session: id }, opened);
    const observer = new ResizeObserver(offerSize);
    observer.observe(host.current!);
    return () => {
      clearTimeout(settle);
      observer.disconnect();
      termHandlers.delete(handler);
      ask({ op: "terminal", session: id, stop: true });
    };
  }, [id, daemon]);

  useEffect(() => {
    if (term.current) term.current.xterm.options.disableStdin = !live;
    if (live && active) term.current?.xterm.focus();
  }, [live, active]);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-terminal-background">
      <div className={`relative min-h-0 flex-1 ${daemon ? "" : "opacity-disabled"}`}>
        <div ref={host} className="absolute inset-0 px-3 font-mono text-xs" />
        {(state.is === "closed" || state.is === "error") && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-terminal-background text-sm">
            {state.is === "closed" && <p className="text-muted-foreground">Starting…</p>}
            {state.is === "error" && <p className="text-destructive">{state.message}</p>}
          </div>
        )}
        {/* It keeps its last screen: that is the sign-in's result. */}
        {(state.is === "exited" || (ended && state.is === "live")) && (
          <div className="absolute inset-x-0 bottom-0 flex items-center justify-center gap-3 border-t border-divider bg-terminal-background py-2 text-sm">
            <span className="text-muted-foreground">The terminal ended</span>
            {onRestart && (
              <Button size="xs" variant="ghost" onClick={onRestart}>
                Restart
              </Button>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * A terminal tab: its shell, started once in its session's folder (Home's: its project's, or the home folder), then shown
 * live; one that ended offers Restart [D315, D320]. Its id is its tab's, kept when a draft's tabs become its session's.
 */
export function TerminalTab({ owner, tab, active }: { owner: string; tab: string; active: boolean }) {
  const { daemon } = useDaemon();
  const [run, setRun] = useState<{ live: boolean; n: number } | { error: string }>();
  const key = own(owner);
  const start = useCallback(
    (again: boolean) =>
      ask({ op: "run", args: ["terminal", key, again ? "restart" : "start", tab] }, (reply) =>
        setRun((was) => reply.ok ? { live: Boolean(reply.live), n: (was && "n" in was ? was.n : 0) + 1 } : { error: String(reply.error ?? "The shell didn't start") }),
      ),
    [key, tab],
  );
  const failed = Boolean(run && "error" in run);
  // Again each time it comes to the front after a refusal: its session may be restored since.
  useEffect(() => {
    if (daemon && (active || !failed)) start(false);
  }, [daemon, start, active && failed]);
  if (run && "error" in run) return <EmptyState variant="centered" icon={Dock} title="Terminal" detail={run.error} className="m-auto" />;
  if (!run) return <section className="flex-1 bg-terminal-background" />;
  // Started again once its shell was swept (archived, then restored): a new pane on the new shell.
  return <TerminalPane key={run.n} id={`term-${tab}`} ended={!run.live} onRestart={() => start(true)} onGone={() => start(false)} active={active} />;
}
