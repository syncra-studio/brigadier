// Fake sessions for the demo: huge mixed threads, and replies that stream at a token rate.
// Only a stand-in for what Rust will send; it holds no thread rules.
import type { ApprovalAction, FileChange, Item, Session, StepKind, Turn, Work } from "./item";

/** Seeded so every run draws the same thread. */
function random(seed: number): () => number {
  return () => {
    seed = (seed + 1831565813) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS =
  "the daemon session socket worktree branch commit thread reply event fold snapshot cursor tail row height scroll frame paint layout render index store memory provider agent tool output diff file change approval question model token stream buffer queue retry timeout handshake version schema migration lock writer reader channel port process window composer message reasoning summary compaction notice error state pending loading empty disconnected".split(
    " ",
  );

const CODE = {
  ts: `export function fold(events: Event[], from = 0): Snapshot {
  const rows = new Map<string, Row>();
  for (const event of events.slice(from)) {
    const row = rows.get(event.id) ?? { id: event.id, text: "" };
    rows.set(event.id, { ...row, text: row.text + event.delta });
  }
  return { rows: [...rows.values()], at: events.length };
}`,
  rust: `pub fn apply(&mut self, event: Event) -> Result<(), Error> {
    match event {
        Event::Delta { id, text } => self.rows.entry(id).or_default().push_str(&text),
        Event::Done { id } => {
            let row = self.rows.get_mut(&id).ok_or(Error::Missing(id))?;
            row.finish();
        }
    }
    self.seq += 1;
    Ok(())
}`,
  python: `def load(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as file:
        rows = [json.loads(line) for line in file if line.strip()]
    return sorted(rows, key=lambda row: row["seq"])`,
  bash: `cargo build --release
pnpm install --frozen-lockfile
rg -n "fn apply" crates/`,
};
type Language = keyof typeof CODE;
const LANGUAGES = Object.keys(CODE) as Language[];

const COMMANDS = ["rg -n \"apply\" crates", "cargo build", "pnpm typecheck", "ls -la app/ui/src", "git status --short", "cat Cargo.toml"];

export type Fake = { rand: () => number; seq: number };

const pick = <T>(fake: Fake, list: readonly T[]): T => list[Math.floor(fake.rand() * list.length)]!;
const between = (fake: Fake, low: number, high: number) => low + Math.floor(fake.rand() * (high - low + 1));
const id = (fake: Fake, prefix: string) => `${prefix}-${(fake.seq++).toString(36)}`;

function sentence(fake: Fake): string {
  const words = Array.from({ length: between(fake, 6, 18) }, () => pick(fake, WORDS));
  const text = words.join(" ");
  return text[0]!.toUpperCase() + text.slice(1) + ".";
}

const paragraph = (fake: Fake) => Array.from({ length: between(fake, 2, 5) }, () => sentence(fake)).join(" ");

function code(fake: Fake, lines?: number): string {
  const language = pick(fake, LANGUAGES);
  const body = lines
    ? Array.from({ length: lines }, (_, at) => CODE[language].split("\n")[at % CODE[language].split("\n").length]).join("\n")
    : CODE[language];
  return "```" + language + "\n" + body + "\n```";
}

function table(fake: Fake): string {
  const rows = Array.from({ length: between(fake, 2, 6) }, () => `| ${pick(fake, WORDS)} | ${between(fake, 1, 999)} ms | ${pick(fake, WORDS)} |`);
  return ["| Name | Time | Note |", "| --- | --- | --- |", ...rows].join("\n");
}

/** An assistant reply in markdown: prose, lists, code, sometimes a table or heading. */
export function markdown(fake: Fake, blocks = between(fake, 1, 7)): string {
  const parts: string[] = [];
  for (let at = 0; at < blocks; at++) {
    const roll = fake.rand();
    if (roll < 0.45) parts.push(paragraph(fake));
    else if (roll < 0.62) parts.push(code(fake, fake.rand() < 0.1 ? between(fake, 30, 120) : undefined));
    else if (roll < 0.77) parts.push(Array.from({ length: between(fake, 2, 6) }, () => `- ${sentence(fake)} Uses \`${pick(fake, WORDS)}\`.`).join("\n"));
    else if (roll < 0.87) parts.push(`## ${sentence(fake).slice(0, 40)}`);
    else if (roll < 0.94) parts.push(table(fake));
    else parts.push(`> ${sentence(fake)} **${pick(fake, WORDS)}** and _${pick(fake, WORDS)}_.`);
  }
  return parts.join("\n\n");
}

function output(fake: Fake, lines: number): string {
  return Array.from({ length: lines }, (_, at) => `${pick(fake, ["src", "crates", "app"])}/${pick(fake, WORDS)}.rs:${at + 1}: ${sentence(fake)}`).join("\n");
}

function diff(fake: Fake): FileChange {
  const path = `${pick(fake, ["crates/daemon/src", "app/ui/src", "app/main"])}/${pick(fake, WORDS)}.${pick(fake, ["rs", "ts", "tsx"])}`;
  const lines = CODE[pick(fake, LANGUAGES)].split("\n");
  const body = lines.flatMap((line) => {
    const roll = fake.rand();
    if (roll < 0.15) return [`-${line}`, `+${line.replace(/\w+/, pick(fake, WORDS))}`];
    if (roll < 0.25) return [`+${line}`];
    return [` ${line}`];
  });
  const change = pick(fake, ["added", "modified", "modified", "modified", "deleted"] as const);
  // Some changes come without counts: "not reported".
  const counted = fake.rand() < 0.95;
  const added = counted ? body.filter((line) => line.startsWith("+")).length : null;
  const removed = counted ? body.filter((line) => line.startsWith("-")).length : null;
  // Some come without a diff: only the path and kind were reported.
  const diff = fake.rand() < 0.9 ? [`@@ -1,${lines.length} +1,${body.length} @@`, ...body].join("\n") : null;
  return { path, change, from: null, diff, added, removed };
}

const ACTIONS: ApprovalAction[] = ["command", "command", "edit", "network", "permission", "plan", "land", "message", "browser", "other"];

/** A short bold heading, as Rust would pull from a thought, or none. */
function heading(fake: Fake): string | null {
  return fake.rand() < 0.6 ? `${pick(fake, WORDS)} ${pick(fake, WORDS)}`.replace(/^./, (c) => c.toUpperCase()) : null;
}

/** Times a finished session's items: inputs when sent, tools when run; some tools report no end. */
function stamp(draft: Draft, at: number): Draft {
  if (draft.kind === "message" && draft.role === "user") return { ...draft, sentAt: at };
  if (draft.kind === "tool" || draft.kind === "childAgent") return { ...draft, startedAt: at, endedAt: at % 13000 === 0 ? null : at + (at % 7000) + 400 };
  return draft;
}

type Draft = Item extends infer T ? (T extends Item ? Omit<T, "id" | "turnId"> : never) : never;
/** A group as the source sends it: the row, then its steps' items. */
type GroupDraft = { group: { kind: StepKind; n: number }[]; members: Draft[] };

const READS = ["crates/daemon/src/fold.rs", "app/ui/src/thread/item.ts", "Cargo.toml", "app/main/main.ts"];

/** `count` steps of one kind, as the items a turn holds for them. */
function steps(fake: Fake, kind: StepKind, count: number): Draft[] {
  return Array.from({ length: count }, (): Draft => {
    const lines = fake.rand() < 0.03 ? between(fake, 500, 3000) : between(fake, 0, 40);
    const tool = (name: string, input: string): Draft => ({
      kind: "tool",
      name,
      input,
      output: output(fake, lines),
      progress: fake.rand() < 0.05 ? "failed" : "done",
      exitCode: 0,
      step: kind,
    });
    switch (kind) {
      case "run":
        return tool("shell", pick(fake, COMMANDS));
      case "read":
        return tool("read", pick(fake, READS));
      case "search":
        return tool("search", `"${pick(fake, WORDS)}" in ${pick(fake, ["crates", "app/ui/src", "app/main"])}`);
      case "web":
        return tool("web", `${pick(fake, WORDS)} ${pick(fake, WORDS)}`);
      case "agent":
        // Some subagents report no step count or answer.
        return {
          kind: "childAgent",
          sessionId: id(fake, "session"),
          title: sentence(fake).slice(0, 48),
          progress: "done",
          current: null,
          steps: fake.rand() < 0.9 ? between(fake, 2, 40) : null,
          answer: fake.rand() < 0.85 ? paragraph(fake) : null,
        };
      case "other":
        return tool("issues.search", pick(fake, WORDS));
      case "edit":
        return { kind: "fileChange", changes: [diff(fake)], progress: "done" };
    }
  });
}

const KINDS: StepKind[] = ["run", "run", "run", "read", "read", "edit", "edit", "search", "web", "agent", "other"];

/** A group of 1–3 kinds, 1–4 steps each, drawn up front so the source sends the group ready-made. */
function group(fake: Fake): GroupDraft {
  const kinds = [...new Set(Array.from({ length: between(fake, 1, 3) }, () => pick(fake, KINDS)))];
  const plan = kinds.map((kind) => ({ kind, n: between(fake, 1, 4) }));
  return { group: plan, members: plan.flatMap((step) => steps(fake, step.kind, step.n)) };
}

/** Something between two groups that ends the first. */
function part(fake: Fake): Draft | null {
  const roll = fake.rand();
  if (roll < 0.08) return { kind: "approval", request: { id: `approval-${fake.rand()}`, reason: `Allow ${pick(fake, COMMANDS)}?`, input: sentence(fake), action: pick(fake, ACTIONS) }, decision: fake.rand() < 0.8 ? "approved" : "denied" };
  if (roll < 0.13) return { kind: "question", question: sentence(fake), options: ["Yes", "No", "Not now"], answer: "Yes" };
  if (roll < 0.15) return { kind: "compaction", summary: paragraph(fake), progress: "done" };
  if (roll < 0.2) return { kind: "notice", level: pick(fake, ["info", "warning", "error"] as const), text: sentence(fake) };
  if (roll < 0.22) return { kind: "unknown", raw: { type: "provider.custom", payload: { value: between(fake, 1, 99) } } };
  return null;
}

/** One finished turn: the input, its work (thinking, groups, the parts between), then the answer. */
function turnParts(fake: Fake): (Draft | GroupDraft)[] {
  const system = fake.rand() < 0.03;
  const text = system ? "Continue from where you stopped." : paragraph(fake);
  const parts: (Draft | GroupDraft)[] = [{ kind: "message", role: "user", origin: system ? "system" : "user", text, streaming: false }];
  if (fake.rand() < 0.7) parts.push({ kind: "reasoning", text: paragraph(fake), streaming: false, heading: heading(fake) });
  for (let at = between(fake, 0, 3); at > 0; at--) {
    // Commentary: a line the agent writes between its steps, with no actions under it.
    if (fake.rand() < 0.5) parts.push({ kind: "message", role: "assistant", text: sentence(fake), streaming: false });
    parts.push(group(fake));
    const between = part(fake);
    if (between) parts.push(between);
    // An answer a follow-up joined (Rust adds no item for that input yet, only the mark).
    if (fake.rand() < 0.08) parts.push({ kind: "message", role: "assistant", text: markdown(fake, 2), streaming: false, joined: true });
  }
  parts.push({ kind: "message", role: "assistant", text: markdown(fake), streaming: false, final: true });
  return parts;
}

/** Numbers items in order, with group rows and work folds as Rust sends them. */
class Writer {
  items: Item[] = [];
  turns: Turn[] = [];
  work: Work[] = [];
  private n = 1;

  add(draft: Draft, turn: Turn, at?: string): Item {
    const item = { ...stamp(draft, turn.startedAt + (this.n % 60) * 1000), id: at ?? `item-${this.n.toString(36)}`, turnId: turn.id, n: this.n++ } as Item;
    this.items.push(item);
    return item;
  }

  turn(fake: Fake, turn: Turn): void {
    this.turns.push(turn);
    const parts = turnParts(fake);
    // Each approval or question waited on the user; "Worked for" leaves the waits out.
    const asks = parts.filter((part) => "kind" in part && (part.kind === "approval" || part.kind === "question")).length;
    turn.waitingSince = null;
    turn.waitedMs = Math.min(asks * between(fake, 3, 90) * 1000, Math.floor((turn.endedAt! - turn.startedAt) / 2));
    let groups = 0;
    let first = 0;
    let last = 0;
    for (const [at, part] of parts.entries()) {
      const work = at > 0 && at < parts.length - 1;
      if ("group" in part) {
        const row = this.add({ kind: "group", steps: part.group, span: [this.n + 1, this.n + part.members.length] }, turn, `${turn.id}:g${groups++}`);
        for (const member of part.members) this.add(member, turn);
        first ||= row.n!;
        last = this.n - 1;
      } else {
        // The final answer's time is its turn's end, as Rust sends it.
        const item = this.add(at === parts.length - 1 ? ({ ...part, sentAt: turn.endedAt! } as Draft) : part, turn);
        if (work) {
          first ||= item.n!;
          last = item.n!;
        }
      }
    }
    if (first) this.work.push({ turnId: turn.id, ms: turn.endedAt! - turn.startedAt - turn.waitedMs, folded: [first, last] });
  }
}

/** A finished session of about `count` items. `huge` adds one very long command output and one very long reply. */
/** Lets the page draw and take input; a message isn't clamped like a nested timeout. */
const breathe = () => new Promise((done) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = done;
  channel.port2.postMessage(null);
});

export async function fakeSession(count: number, seed = 1, huge = false): Promise<Session> {
  const fake: Fake = { rand: random(seed), seq: 0 };
  const writer = new Writer();
  let time = Date.UTC(2026, 10, 1);
  let slice = performance.now();
  while (writer.items.length < count) {
    // Built a few ms at a time, so a big session doesn't freeze the page.
    if (performance.now() - slice > 8) {
      await breathe();
      slice = performance.now();
    }
    const startedAt = time;
    const turn: Turn = { id: id(fake, "turn"), status: "done", startedAt, endedAt: (time += between(fake, 5, 300) * 1000), backend: "fake" };
    writer.turn(fake, turn);
  }
  // Whole turns only: a cut turn's group and fold would cover the items after it.
  const items = writer.items;
  if (huge && count > 4) {
    const from = Math.floor(count / 2);
    const tool = items.findIndex((item, at) => at >= from && item.kind === "tool" && item.name === "shell");
    const answer = items.findIndex((item, at) => at >= from && item.kind === "message" && item.role === "assistant");
    if (tool >= 0) items[tool] = { ...items[tool]!, input: "cargo test -- --nocapture", output: output(fake, 30000) } as Item;
    if (answer >= 0) items[answer] = { ...items[answer]!, text: markdown(fake, 600) } as Item;
  }
  return { id: `session-${seed}`, title: "Fake session", turns: writer.turns, items, work: writer.work };
}

/** A session that changes: a tiny external store for useSyncExternalStore. */
export class FakeThread {
  session: Session;
  private readonly fake: Fake;
  private readonly listeners = new Set<() => void>();
  private n: number;

  constructor(session: Session, seed = 1) {
    this.session = session;
    this.fake = { rand: random(seed + 1), seq: 1e9 };
    this.n = (this.session.items.at(-1)?.n ?? 0) + 1;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = () => this.session;

  private emit(change: Partial<Session>): void {
    this.session = { ...this.session, ...change };
    for (const listener of this.listeners) listener();
  }

  /** Replaces item `at`, so only its row draws again. */
  replace(at: number, item: Item): void {
    const items = this.session.items.slice();
    items[at] = item;
    this.emit({ items });
  }

  append(...items: Item[]): void {
    this.emit({ items: [...this.session.items, ...items] });
  }

  private item(draft: Draft, turn: Turn, at?: string): Item {
    return { ...draft, id: at ?? id(this.fake, "item"), turnId: turn.id, n: this.n++ } as Item;
  }

  /** Stopped by the user: the turn and whatever in it was still live. */
  private stop(turnId: string): void {
    const now = Date.now();
    // An ended turn's last assistant message is its final answer, interrupted too.
    const answer = this.session.items.findLast((item) => item.turnId === turnId && item.kind === "message" && item.role === "assistant");
    this.emit({
      turns: this.session.turns.map((turn) => (turn.id === turnId ? { ...turn, status: "cancelled", endedAt: now } : turn)),
      items: this.session.items.map((item) =>
        item.turnId !== turnId
          ? item
          : item.kind === "tool" && item.progress === "running"
            ? { ...item, progress: "cancelled", endedAt: now }
            : item === answer
              ? { ...item, streaming: false, final: true, sentAt: now }
              : (item.kind === "message" || item.kind === "reasoning") && item.streaming
                ? { ...item, streaming: false }
                : item,
      ),
    });
  }

  /** Grows item `at`'s text to `full`, paced by the clock (a slow renderer gets the same text in fewer updates). */
  private async grow(at: number, item: Item, full: string, charsPerSecond: number, stopped: () => boolean, wait: (ms: number) => Promise<unknown>) {
    const start = performance.now();
    let shown = 0;
    while (!stopped() && shown < full.length) {
      await wait(16 + this.fake.rand() * 34);
      const due = Math.min(full.length, Math.floor(((performance.now() - start) / 1000) * charsPerSecond));
      if (due === shown) continue;
      shown = due;
      this.replace(at, withText(item, full.slice(0, shown), false));
    }
    if (!stopped()) this.replace(at, withText(item, full, true));
  }

  /**
   * Streams turns for ever until stopped: thinking, a group of commands whose output grows, then a markdown reply,
   * then the turn's work summary. `prefill` blocks of reply are there before it starts growing. `sentId` is the first
   * user message's id.
   */
  stream(tokensPerSecond = 60, prefill = 0, sentId?: string): () => void {
    const charsPerSecond = tokensPerSecond * 4;
    let stopped = false;
    let timer = 0;
    const wait = (ms: number) => new Promise((done) => (timer = window.setTimeout(done, ms)));
    let live: string | null = null;
    const run = async () => {
      while (!stopped) {
        const turn: Turn = { id: id(this.fake, "turn"), status: "running", startedAt: Date.now(), endedAt: null, backend: "fake", waitingSince: null, waitedMs: 0 };
        live = turn.id;
        this.emit({ turns: [...this.session.turns, turn] });
        this.append(this.item({ kind: "message", role: "user", origin: "user", text: paragraph(this.fake), streaming: false, sentAt: Date.now() }, turn, sentId));
        sentId = undefined;
        const thought = this.item({ kind: "reasoning", text: "", streaming: true, heading: heading(this.fake) }, turn);
        this.append(thought);
        await this.grow(this.session.items.length - 1, thought, paragraph(this.fake), charsPerSecond, () => stopped, wait);
        const note = this.item({ kind: "message", role: "assistant", text: "", streaming: true }, turn);
        this.append(note);
        await this.grow(this.session.items.length - 1, note, sentence(this.fake), charsPerSecond, () => stopped, wait);
        // The group row comes with its first step and is replaced as each next step starts.
        const commands = between(this.fake, 1, 3);
        type Group = Extract<Item, { kind: "group" }>;
        let row: Group | null = null;
        for (let step = 1; step <= commands && !stopped; step++) {
          const fresh: boolean = row === null;
          const base: Group = row ?? (this.item({ kind: "group", steps: [], span: [0, 0] }, turn, `${turn.id}:g0`) as Group);
          const command = this.item({ kind: "tool", name: "shell", input: pick(this.fake, COMMANDS), output: "", progress: "running", exitCode: null, step: "run", startedAt: Date.now(), endedAt: null }, turn);
          const next: Group = { ...base, steps: [{ kind: "run", n: step }], span: [fresh ? command.n! : base.span[0], command.n!] };
          row = next;
          if (fresh) this.append(next, command);
          else {
            this.replace(this.session.items.findIndex((item) => item.id === base.id), next);
            this.append(command);
          }
          await this.grow(this.session.items.length - 1, command, output(this.fake, between(this.fake, 20, 200)), charsPerSecond * 4, () => stopped, wait);
        }
        const head = prefill ? markdown({ rand: random(prefill), seq: 0 }, prefill) + "\n\n" : "";
        const answer = this.item({ kind: "message", role: "assistant", text: head, streaming: true }, turn);
        const folded: [number, number] = [thought.n!, answer.n! - 1];
        this.append(answer);
        await this.grow(this.session.items.length - 1, answer, head + markdown(this.fake, prefill ? prefill + 20 : between(this.fake, 4, 12)), charsPerSecond, () => stopped, wait);
        if (stopped) return;
        live = null;
        const ended = { ...turn, status: "done" as const, endedAt: Date.now() };
        // The answer is the last item: the turn's end makes it final.
        this.emit({
          items: [...this.session.items.slice(0, -1), { ...this.session.items.at(-1)!, final: true, sentAt: ended.endedAt } as Item],
          turns: this.session.turns.map((each) => (each.id === turn.id ? ended : each)),
          work: [...(this.session.work ?? []), { turnId: turn.id, ms: ended.endedAt - turn.startedAt, folded }],
        });
        // The user reads the answer before sending the next message.
        await wait(between(this.fake, 5, 8) * 1000);
      }
    };
    void run();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      if (live) this.stop(live);
    };
  }
}

function withText(item: Item, text: string, done: boolean): Item {
  if (item.kind === "tool") return { ...item, output: text, progress: done ? "done" : "running", exitCode: done ? 0 : null, endedAt: done ? Date.now() : null };
  if (item.kind === "message" || item.kind === "reasoning") return { ...item, text, streaming: !done };
  return item;
}
