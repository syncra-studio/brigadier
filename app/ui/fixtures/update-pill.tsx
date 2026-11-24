// Mockup only: the update pill at the sidebar's foot, the old app's outlined chip (A), live and in each of its states, on
// fake updates. ?v=real is the whole app itself, on a stub daemon whose Claude Code and Codex are outdated and whose
// Update runs a moment; it refuses the rest. Not the app.
import "../src/theme.css";
import "./fixtures.css";
// The real app's sidebar stays open in a pane narrower than its fold.
import "./sidebar-fill.css";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import claude from "../../../crates/core/src/adapters/claude/claude.svg?raw";
import codex from "../../../crates/core/src/adapters/codex/codex.svg?raw";
import opencode from "../../../crates/core/src/adapters/opencode/opencode.svg?raw";
import { Button, type ButtonProps } from "../src/components/button";
import { cx } from "../src/components/cx";
import { TooltipIconButton } from "../src/components/icon-button";
import { NavHeader, NavList, NavRow } from "../src/components/nav";
import { Popover, PopoverContent, PopoverTrigger } from "../src/components/popover";
import { Segmented } from "../src/components/segmented";
import { spacingPx, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "../src/components/tooltip";
import { ArrowRotateCw, BarChart, Check, ComposeEditSquare, DownloadSimple, Lightbulb, Plugin, PullRequestOpen, Settings, Spinner, ThumbMixed } from "../src/icons";
import type { Agent } from "../src/onboarding/api";
import { BrigadierMark } from "../src/onboarding/mark";
import { BarItem, Glyph, rowLabel, type UpdateItem, UpdateRow } from "../src/sidebar/updates";

type Where = "normal" | "narrow" | "strip";

const item = (target: string, name: string, mark: string | null, current: string, latest: string, action: UpdateItem["action"]["type"] = "run"): UpdateItem => ({
  target, name, mark, current, latest, action: { type: action } as UpdateItem["action"], progress: { type: "available" },
});
const CLAUDE = item("claude", "Claude Code", claude, "v2.1.88", "v2.1.90");
const CODEX = item("codex", "Codex", codex, "v0.51.0", "v0.52.0");
const OPENCODE = item("opencode", "OpenCode", opencode, "v1.2.4", "v1.3.0");
const APP = item("app", "Brigadier", null, "v0.1.0", "v0.2.0", "download");
const as = (type: "updating" | "updated", ...items: UpdateItem[]): UpdateItem[] => items.map((each) => ({ ...each, current: type === "updated" ? each.latest : each.current, progress: { type } }));
const STATES: [string, UpdateItem[]][] = [
  ["One agent", [CLAUDE]],
  ["Two agents", [CLAUDE, CODEX]],
  ["Brigadier and two agents", [APP, CLAUDE, CODEX]],
  ["Everything", [APP, CLAUDE, CODEX, OPENCODE]],
  ["Updating", as("updating", CLAUDE)],
  ["Updating two", as("updating", CLAUDE, CODEX)],
  ["Updated", as("updated", CLAUDE)],
  ["Restart", [{ ...APP, action: { type: "restart" } }]],
];

/** What the pill says about its items as a whole. */
function standing(items: UpdateItem[]) {
  if (items.some((each) => each.progress.type === "updating")) return "updating";
  if (items.length > 0 && items.every((each) => each.progress.type === "updated")) return "updated";
  return items.every((each) => each.action.type === "restart") ? "restart" : "available";
}
const STATE_GLYPH = {
  updating: <Spinner aria-hidden className="animate-spin motion-reduce:animate-none" />,
  updated: <Check aria-hidden />,
  restart: <ArrowRotateCw aria-hidden />,
  available: <DownloadSimple aria-hidden />,
};

/** The marks, as many as `most`; past that the last place says how many more. */
function Marks({ items, most, column = false, gap = "gap-1" }: { items: UpdateItem[]; most: number; column?: boolean; gap?: string }) {
  const shown = items.length > most ? items.slice(0, most - 1) : items;
  return (
    <span className={cx("flex shrink-0 items-center", column && "flex-col", gap)}>
      {shown.map((each) => (
        <Glyph key={each.target} item={each} className="size-icon-sm shrink-0" />
      ))}
      {items.length > shown.length && <span className="text-2xs font-medium tabular-nums">+{items.length - shown.length}</span>}
    </span>
  );
}

const MOTION = "relative flex shrink-0 items-center justify-center transition-all motion-safe:active:scale-press-button";
type Look = { className: string; body: ReactNode };

/** A: the old app's, an outlined round chip of an icon and the marks, filled only on hover; in the strip it stands up. */
function lookA(items: UpdateItem[], where: Where): Look {
  const strip = where === "strip";
  return {
    className: cx(
      MOTION,
      "rounded-capsule border border-border text-strip-foreground hover:bg-fill hover:text-foreground aria-expanded:bg-fill aria-expanded:text-foreground",
      strip ? "w-8 flex-col gap-1.5 py-2" : cx("h-7.5 px-2", where === "narrow" ? "gap-1" : "gap-1.5"),
    ),
    body: (
      <>
        {STATE_GLYPH[standing(items)]}
        <span className="flex text-foreground">
          <Marks items={items} column={strip} most={where === "narrow" ? 2 : 3} gap={where === "narrow" ? "gap-0.5" : "gap-1"} />
        </span>
      </>
    ),
  };
}

type Forced = "tip" | "list";
// Held on its side; kept inside a narrow pane.
const STILL = { side: "none", align: "shift" } as const;

/** The pill's button with its tip; `forced` keeps the tip open. */
function Chip({ label, tip, where, forced, children, ...props }: ButtonProps & { label: string; tip: ReactNode; where: Where; forced?: Forced }) {
  return (
    <Tooltip {...(forced && { open: forced === "tip" })}>
      <TooltipTrigger
        delay={0}
        render={
          <Button variant={null} size={null} aria-label={label} {...props}>
            {children}
          </Button>
        }
      />
      <TooltipContent side={where === "strip" ? "right" : "top"} className="h-7.5 max-w-96" {...(forced && { collisionAvoidance: STILL })}>
        <span className="min-w-0 truncate">{tip}</span>
      </TooltipContent>
    </Tooltip>
  );
}

/** The pill with its list, as the app's UpdatesRow holds them: one agent's update starts on the click, else the list opens. */
function Pill({ items, where, forced, onUpdate, onSkip }: { items: UpdateItem[]; where: Where; forced?: Forced; onUpdate: (item: UpdateItem) => void; onSkip: (item: UpdateItem) => void }) {
  const strip = where === "strip";
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState(items);
  if (items.length > 0 && items !== last) setLast(items);
  const shown = items.length > 0 ? items : last;
  const empty = items.length === 0;
  useEffect(() => {
    if (!empty || !open) return;
    const timer = setTimeout(() => setOpen(false), 200);
    return () => clearTimeout(timer);
  }, [empty, open]);
  const direct = items.length === 1 && items[0].action.type === "run" && items[0].progress.type === "available" ? items[0] : null;
  const { className, body } = lookA(shown, where);
  const runnable = shown.filter((each) => each.action.type !== "manual" && each.progress.type === "available");
  return (
    <BarItem show={!empty || open} axis={strip ? "y" : "x"}>
      <Popover open={forced ? forced === "list" : open} onOpenChange={(next) => !direct && setOpen(next)}>
        <PopoverTrigger
          render={<Chip label={direct ? `Update ${direct.name} to ${direct.latest}` : rowLabel(shown)} tip={direct ? `Update ${direct.name} to ${direct.latest}` : rowLabel(shown)} where={where} forced={forced} className={className} />}
          onClick={direct ? () => onUpdate(direct) : undefined}
        >
          {body}
        </PopoverTrigger>
        <PopoverContent
          side={strip ? "right" : "top"}
          align={strip ? "end" : "start"}
          sideOffset={() => spacingPx() * (strip ? 3 : 2)}
          padded={false}
          {...(forced && { collisionAvoidance: STILL, initialFocus: false })}
          className="flex w-96 max-w-available flex-col p-1.5"
        >
          <BarItem axis="y" show={shown.length > 1}>
            <div className="flex justify-end px-1.5 pt-1 pb-1.5">
              <Button size="sm" variant="secondary" disabled={runnable.length < 2} onClick={() => runnable.forEach(onUpdate)}>
                Update all
              </Button>
            </div>
          </BarItem>
          {shown.map((each) => (
            <BarItem key={each.target} axis="y" show={items.includes(each)}>
              <UpdateRow item={each} onUpdate={() => onUpdate(each)} onSkip={() => onSkip(each)} />
            </BarItem>
          ))}
          <BarItem axis="y" show={items.some((each) => each.target !== "app" && each.progress.type !== "available")}>
            <p className="px-1.5 pt-1 pb-1 text-xs text-muted-foreground">Sessions already running keep the version they started with.</p>
          </BarItem>
        </PopoverContent>
      </Popover>
    </BarItem>
  );
}

const NOOP = () => {};
/** The foot as the app draws it, with the pill where each variant puts it. */
function Foot({ where, pill }: { where: Where; pill: ReactNode }) {
  const strip = where === "strip";
  const side = strip ? "right" : "top";
  const icons = [
    <TooltipIconButton key="usage" look="rail" side={side} tooltip="Usage"><BarChart /></TooltipIconButton>,
    <TooltipIconButton key="awake" look="rail" side={side} tooltip="Keep awake"><Lightbulb /></TooltipIconButton>,
    <TooltipIconButton key="feedback" look="rail" side={side} tooltip="Send Feedback"><ThumbMixed /></TooltipIconButton>,
    <TooltipIconButton key="settings" look="rail" side={side} tooltip="Settings"><Settings /></TooltipIconButton>,
  ];
  if (strip)
    return (
      <div className="flex flex-col items-center gap-0.5 pb-1">
        <div className="pb-1">{pill}</div>
        {icons}
      </div>
    );
  return (
    <div className="flex shrink-0 flex-col px-2 pt-1 pb-2">
      <div data-foot className="flex items-center gap-0.5">
        {icons.toReversed()}
        <div className="flex">{pill}</div>
      </div>
    </div>
  );
}

const WIDTH = { normal: "w-left-sidebar", narrow: "w-left-sidebar-min", strip: "w-rail" };
/** The sidebar, or its foot's end of it, at its width. */
function Sidebar({ where, tall = false, pill }: { where: Where; tall?: boolean; pill: ReactNode }) {
  const pages = [["New chat", ComposeEditSquare], ["Plugins", Plugin], ["Pull Requests", PullRequestOpen]] as const;
  return (
    <div data-panel={where} className={cx("flex shrink-0 flex-col justify-end border border-border bg-sidebar", WIDTH[where], tall ? "h-96" : "pt-2")}>
      {tall && where !== "strip" && (
        <>
          <NavHeader start={<BrigadierMark className="size-icon-mark" />} title="Brigadier" />
          <div className="flex-1 ps-2 pe-2">
            <NavList>
              {pages.map(([label, Icon], at) => (
                <li key={label}>
                  <NavRow data-active={at === 0 || undefined}>
                    <Icon />
                    {label}
                  </NavRow>
                </li>
              ))}
            </NavList>
          </div>
        </>
      )}
      <Foot where={where} pill={pill} />
    </div>
  );
}

/** The pill working: a click updates (a while), shows its check, then leaves. */
function Live() {
  const [items, setItems] = useState<UpdateItem[]>([CLAUDE, CODEX]);
  const [where, setWhere] = useState<Where>("normal");
  const timers = useRef<number[]>([]);
  const show = (next: UpdateItem[]) => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setItems(next);
  };
  const change = (target: string, to: (item: UpdateItem) => UpdateItem | null) => setItems((all) => all.flatMap((each) => (each.target === target ? (to(each) ?? []) : each)));
  const onUpdate = ({ target, action }: UpdateItem) => {
    if (action.type === "restart") return change(target, () => null);
    change(target, (each) => ({ ...each, progress: { type: "updating" } }));
    timers.current.push(
      window.setTimeout(() => change(target, (each) => (action.type === "download" ? { ...each, action: { type: "restart" }, progress: { type: "available" } } : as("updated", each)[0])), 2500),
      window.setTimeout(() => change(target, (each) => (action.type === "download" ? each : null)), 4500),
    );
  };
  return (
    <Group title="Live: click it, hover it">
      <div className="flex w-full flex-col items-start gap-3">
        <div className="flex flex-wrap gap-2">
          <Segmented label="Width" value={where} onChange={setWhere} options={[{ value: "normal", label: "Normal" }, { value: "narrow", label: "Narrowest" }, { value: "strip", label: "Strip" }]} />
          {STATES.filter(([, each]) => standing(each) === "available" || standing(each) === "restart").map(([label, each]) => (
            <Button key={label} size="sm" variant="outline" onClick={() => show(each)}>
              {label}
            </Button>
          ))}
          <Button size="sm" variant="outline" onClick={() => show([])}>None</Button>
        </div>
        <Sidebar where={where} tall pill={<Pill items={items} where={where} onUpdate={onUpdate} onSkip={({ target }) => change(target, () => null)} />} />
      </div>
    </Group>
  );
}

const Group = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-sm font-medium">{title}</h2>
    <div className="flex flex-wrap items-end gap-4">{children}</div>
  </section>
);
/** One state, held still; `room` leaves space over the foot for what floats there. */
const Case = ({ label, items, where, forced, room }: { label: string; items: UpdateItem[]; where: Where; forced?: Forced; room?: string }) => (
  <figure className={cx("flex flex-col gap-1.5", where === "strip" && !forced && "w-20", room)}>
    <figcaption className="text-xs text-muted-foreground">{label}</figcaption>
    <span className="flex-1" />
    <Sidebar where={where} pill={<Pill items={items} where={where} forced={forced} onUpdate={NOOP} onSkip={NOOP} />} />
  </figure>
);

function Page() {
  const [, [two, both]] = STATES;
  return (
    <TooltipProvider>
      <main className="flex flex-col gap-8 p-6">
        <Live />
        <Group title="Normal width">
          {STATES.map(([label, items]) => <Case key={label} label={label} items={items} where="normal" />)}
        </Group>
        <Group title="Narrowest">
          {STATES.map(([label, items]) => <Case key={label} label={label} items={items} where="narrow" />)}
        </Group>
        <Group title="Strip">
          {STATES.map(([label, items]) => <Case key={label} label={label} items={items} where="strip" />)}
        </Group>
        <Group title="Hovered">
          <Case label="One agent" items={[CLAUDE]} where="normal" forced="tip" room="h-48 w-96" />
          <Case label={two} items={both} where="normal" forced="tip" room="h-48 w-96" />
          <Case label={`${two}, strip`} items={both} where="strip" forced="tip" room="w-96" />
        </Group>
        <Group title="The list open">
          <Case label={two} items={both} where="normal" forced="list" room="h-80 w-96" />
        </Group>
      </main>
    </TooltipProvider>
  );
}

/** What main hands the page in the app: a port to the daemon, here one that holds the fake agents, each outdated until updated. */
function fakeDaemon() {
  const { port1, port2 } = new MessageChannel();
  const agents: Agent[] = [CLAUDE, CODEX].map(({ target, name, mark, current, latest }) => ({
    name: target, label: name, mark, install: true, sign_in: null, enabled: true, update: `${target} update`, models_off: [], setup: null,
    path: `/usr/local/bin/${target}`, version: current.slice(1), latest: latest.slice(1), outdated: true, signed_in: true, models: [],
  }));
  const say = (frame: object) => {
    const json = new TextEncoder().encode(JSON.stringify(frame));
    const out = new Uint8Array(4 + json.length);
    new DataView(out.buffer).setUint32(0, json.length);
    out.set(json, 4);
    port2.postMessage(out);
  };
  port2.onmessage = ({ data }: MessageEvent<Uint8Array>) => {
    const { id, op, args = [] } = JSON.parse(new TextDecoder().decode(data.subarray(4)));
    const [command, name, action] = args as string[];
    const agent = agents.find((each) => each.name === name);
    if (op === "subscribe") return say({ re: id, n: 1, projects: [], rows: [] });
    if (op === "run" && command === "profile") return say({ re: id, ok: true, onboarded: true, intro_seen: true, tour_seen: true, agents });
    if (op === "run" && command === "agents") return say({ re: id, ok: true, agents: agent ? [agent] : agents });
    if (op === "run" && command === "setup" && agent && action === "close") {
      agent.setup = null;
      return say({ re: id, ok: true });
    }
    if (op === "run" && command === "setup" && agent && action === "update") {
      const run = { id: "fake", action, code: null, signal: null, code_page: null, reason: null } as const;
      agent.setup = { ...run, running: true };
      setTimeout(() => Object.assign(agent, { version: agent.latest, outdated: false, setup: { ...run, running: false, code: 0 } }), 2500);
      return say({ re: id, ok: true });
    }
    say({ re: id, ok: false, error: "not in this mockup", message: "Not in this mockup" });
  };
  window.postMessage("daemon-port", "*", [port1]);
  say({ status: "running", pid: 1, version: "mockup", build: 0 });
}

if (new URLSearchParams(location.search).get("v") === "real") {
  location.hash = "#home";
  fakeDaemon();
  void import("../src/main");
} else createRoot(document.getElementById("root")!).render(<Page />);
