// How the composer's `/` and `@` menus match what is typed, for both apps [D58].

/**
 * A row of the `@` menu: what a mention names. `label` is what its chip keeps (a path, a chat's title, a worker's
 * name). A `direct` row is no mention: picking it sends the next message to that worker alone. PROPOSED.
 */
export type Mention = {
  id: string;
  type: "file" | "folder" | "chat" | "worker" | "direct" | "tab" | "note" | "plugin";
  label: string;
  /** The row's name, when it isn't the label (a file's name for its path). */
  name?: string;
  /** Grey text after the name (a file's folder). */
  detail?: string;
  /** Grey text at the row's end. */
  hint?: string;
};

/** A part of the `@` menu: its heading (none for ranked results), rows and a grey note under them. PROPOSED. */
export type MentionGroup = { title: string | null; items: Mention[]; note?: string };

/** A `/` command's kind, the order the menu lists them in. */
export type CommandKind = "command" | "tool" | "skill" | "mcp" | "prompt";

/**
 * Where `query` matches `text`, as the menus match: at its start, anywhere in it, or letter by letter in order.
 * The matched letters' positions and how good the match is (0 start, 1 anywhere, 2 in order); null: no match.
 */
export function fuzzyMatch(text: string, query: string): { rank: 0 | 1 | 2; at: number[] } | null {
  const lower = text.toLowerCase();
  const want = query.toLowerCase();
  const run = (from: number) => Array.from(want, (_, index) => from + index);
  if (lower.startsWith(want)) return { rank: 0, at: run(0) };
  const inside = lower.indexOf(want);
  if (inside >= 0) return { rank: 1, at: run(inside) };
  const at: number[] = [];
  let from = 0;
  for (const letter of want) {
    const found = lower.indexOf(letter, from);
    if (found < 0) return null;
    at.push(found);
    from = found + 1;
  }
  return { rank: 2, at };
}

/** Commands matching `query`, best first within each kind, the kinds in order so no heading repeats. */
export function commandMatches<T extends { id: string; label: string; kind: CommandKind }>(commands: readonly T[], query: string): T[] {
  const order = { command: 0, tool: 1, skill: 2, mcp: 3, prompt: 4 };
  const rank = (command: T) => Math.min(fuzzyMatch(command.label, query)?.rank ?? 3, fuzzyMatch(command.id, query)?.rank ?? 3);
  return commands
    .map((command) => ({ command, rank: rank(command) }))
    .filter(({ rank }) => rank < 3)
    .sort((a, b) => order[a.command.kind] - order[b.command.kind] || a.rank - b.rank)
    .map(({ command }) => command);
}

/** A command as the `/` menu lists it, from Rust's `commands` reply. */
export function listedCommand(each: { name: string; description?: string; kind: CommandKind; instant: boolean }) {
  // A prompt kept as Claude listed it before prompts had a kind of their own ("mcp", a server's); library names have no `_`.
  const kind = each.kind === "mcp" && each.name.startsWith("mcp__") ? "prompt" : each.kind;
  return { id: `${kind}:${each.name}`, kind, label: `/${each.name}`, description: each.description || undefined, instant: each.instant };
}
