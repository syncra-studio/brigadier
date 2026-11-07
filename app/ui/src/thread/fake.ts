// Fake sessions for the demo: huge mixed threads, and replies that stream at a token rate.
// Only a stand-in for what Rust will send; it holds no thread rules.
import type { FileChange, Item, Session, Turn } from "./item";

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
  return { path, change, from: null, diff: [`@@ -1,${lines.length} +1,${body.length} @@`, ...body].join("\n") };
}

type Draft = Item extends infer T ? (T extends Item ? Omit<T, "id" | "turnId"> : never) : never;

/** One turn's items, as a finished turn holds them. */
function turnItems(fake: Fake): Draft[] {
  const items: Draft[] = [{ kind: "message", role: "user", text: paragraph(fake), streaming: false }];
  if (fake.rand() < 0.7) items.push({ kind: "reasoning", text: paragraph(fake), streaming: false });
  for (let at = between(fake, 0, 6); at > 0; at--) {
    const lines = fake.rand() < 0.03 ? between(fake, 500, 3000) : between(fake, 0, 40);
    items.push({
      kind: "tool",
      name: pick(fake, ["shell", "read", "search", "web"]),
      input: pick(fake, COMMANDS),
      output: output(fake, lines),
      progress: fake.rand() < 0.05 ? "failed" : "done",
      exitCode: 0,
    });
  }
  if (fake.rand() < 0.4) items.push({ kind: "fileChange", changes: Array.from({ length: between(fake, 1, 4) }, () => diff(fake)), progress: "done" });
  const roll = fake.rand();
  if (roll < 0.05) items.push({ kind: "approval", title: `Run ${pick(fake, COMMANDS)}`, detail: sentence(fake), decision: fake.rand() < 0.8 ? "approved" : "denied" });
  else if (roll < 0.08) items.push({ kind: "question", question: sentence(fake), options: ["Yes", "No", "Not now"], answer: "Yes" });
  else if (roll < 0.11) items.push({ kind: "childAgent", sessionId: id(fake, "session"), title: sentence(fake).slice(0, 48), progress: "done" });
  else if (roll < 0.12) items.push({ kind: "compaction", summary: paragraph(fake) });
  else if (roll < 0.15) items.push({ kind: "notice", level: pick(fake, ["info", "warning", "error"] as const), text: sentence(fake) });
  else if (roll < 0.16) items.push({ kind: "unknown", raw: { type: "provider.custom", payload: { value: between(fake, 1, 99) } } });
  items.push({ kind: "message", role: "assistant", text: markdown(fake), streaming: false });
  return items;
}

/** A finished session of about `count` items. `huge` adds one very long tool output and one very long reply. */
export function fakeSession(count: number, seed = 1, huge = false): Session {
  const fake: Fake = { rand: random(seed), seq: 0 };
  const turns: Turn[] = [];
  const items: Item[] = [];
  let time = Date.UTC(2026, 10, 1);
  while (items.length < count) {
    const turn: Turn = { id: id(fake, "turn"), status: "done", startedAt: time, endedAt: (time += between(fake, 5, 300) * 1000) };
    turns.push(turn);
    for (const draft of turnItems(fake)) items.push({ ...draft, id: id(fake, "item"), turnId: turn.id } as Item);
  }
  items.length = count;
  if (huge && count > 4) {
    const at = Math.floor(count / 2);
    items[at] = { id: id(fake, "item"), turnId: items[at]!.turnId, kind: "tool", name: "shell", input: "cargo test -- --nocapture", output: output(fake, 30000), progress: "done", exitCode: 0 };
    items[at + 1] = { id: id(fake, "item"), turnId: items[at + 1]!.turnId, kind: "message", role: "assistant", text: markdown(fake, 600), streaming: false };
  }
  return { id: `session-${seed}`, title: "Fake session", turns, items };
}

/** A session that changes: a tiny external store for useSyncExternalStore. */
export class FakeThread {
  session: Session;
  private readonly fake: Fake;
  private readonly listeners = new Set<() => void>();

  constructor(count: number, seed = 1, huge = false) {
    this.session = fakeSession(count, seed, huge);
    this.fake = { rand: random(seed + 1), seq: 1e9 };
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  get = () => this.session;

  private emit(items: Item[], turns = this.session.turns): void {
    this.session = { ...this.session, turns, items };
    for (const listener of this.listeners) listener();
  }

  /** Replaces item `at`, so only its row draws again. */
  replace(at: number, item: Item): void {
    const items = this.session.items.slice();
    items[at] = item;
    this.emit(items);
  }

  append(item: Item, turns?: Turn[]): void {
    this.emit([...this.session.items, item], turns);
  }

  prepend(count: number): void {
    const older = fakeSession(count, this.fake.seq++).items.map((item) => ({ ...item, id: id(this.fake, "old") }));
    this.emit([...older, ...this.session.items]);
  }

  /**
   * Streams turns for ever until stopped: reasoning, a tool whose output grows, then a markdown reply.
   * Text is paced by the clock, not by ticks, so a slow renderer gets the same text in fewer updates.
   */
  stream(tokensPerSecond = 60, prefill = 0): () => void {
    const charsPerSecond = tokensPerSecond * 4;
    let stopped = false;
    let timer = 0;
    const run = async () => {
      while (!stopped) {
        const turn: Turn = { id: id(this.fake, "turn"), status: "running", startedAt: Date.now(), endedAt: null };
        const turns = [...this.session.turns, turn];
        this.append({ id: id(this.fake, "item"), turnId: turn.id, kind: "message", role: "user", text: paragraph(this.fake), streaming: false }, turns);
        const plan: Draft[] = [
          { kind: "reasoning", text: paragraph(this.fake), streaming: true },
          { kind: "tool", name: "shell", input: pick(this.fake, COMMANDS), output: output(this.fake, between(this.fake, 20, 200)), progress: "running", exitCode: null },
          { kind: "message", role: "assistant", text: markdown(this.fake, between(this.fake, 4, 12)), streaming: true },
        ];
        if (prefill) plan[2] = { kind: "message", role: "assistant", text: markdown(this.fake, prefill + 20), streaming: true };
        for (const draft of plan) {
          const full = draft.kind === "tool" ? draft.output : "text" in draft ? draft.text : "";
          const item = { ...draft, id: id(this.fake, "item"), turnId: turn.id } as Item;
          const at = this.session.items.length;
          const head = prefill && draft.kind === "message" ? markdown({ rand: random(prefill), seq: 0 }, prefill) + "\n\n" : "";
          this.append(withText(item, head, false));
          const start = performance.now();
          let shown = 0;
          while (!stopped && shown < full.length) {
            await new Promise((done) => (timer = window.setTimeout(done, 16 + this.fake.rand() * 34)));
            const due = Math.min(full.length, Math.floor(((performance.now() - start) / 1000) * charsPerSecond));
            if (due === shown) continue;
            shown = due;
            this.replace(at, withText(item, head + full.slice(0, shown), false));
          }
          if (stopped) return;
          this.replace(at, withText(item, head + full, true));
        }
        const ended = { ...turn, status: "done" as const, endedAt: Date.now() };
        this.emit(this.session.items, this.session.turns.map((each) => (each.id === turn.id ? ended : each)));
      }
    };
    void run();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }
}

function withText(item: Item, text: string, done: boolean): Item {
  if (item.kind === "tool") return { ...item, output: text, progress: done ? "done" : "running", exitCode: done ? 0 : null };
  if (item.kind === "message" || item.kind === "reasoning") return { ...item, text, streaming: !done };
  return item;
}
