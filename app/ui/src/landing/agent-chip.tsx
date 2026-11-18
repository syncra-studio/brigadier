import { Tile, TileRemove } from "../components/composer/attachments";
import { Sparkles, XCircle } from "./icons";

/**
 * What waits above the composer for the agent: a Resolve with agent or a failed run's Fix. Nothing is
 * sent until the user sends [D1019, D1027, D1044]. The composer carries it as an `agent` chip (panel/chips.ts).
 */
export type AgentChip =
  | { id: string; kind: "resolve"; conflicts: number; files: number; operation: "merging" | "rebasing" | "pulling"; onto: string }
  | { id: string; kind: "run"; run: string; failed: string };

const plural = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

function face(chip: AgentChip) {
  switch (chip.kind) {
    case "resolve":
      return { icon: <Sparkles />, title: `Resolve ${plural(chip.conflicts, "conflict")}`, detail: `${plural(chip.files, "file")} · ${chip.operation} ${chip.onto}` };
    case "run":
      return { icon: <XCircle className="text-destructive" />, title: `Fix ${chip.run}`, detail: chip.failed };
  }
}

/** One chip, in the composer's attachments row, the attachment tile's look [D1056]. */
export function AgentChipTile({ chip, onRemove }: { chip: AgentChip; onRemove: () => void }) {
  const { icon, title, detail } = face(chip);
  return (
    <Tile
      slot="agent-chip"
      hint={title}
      icon={<span className="flex svg:size-icon-md">{icon}</span>}
      title={title}
      detail={detail}
      remove={<TileRemove label={`Remove ${title}`} onClick={onRemove} />}
    />
  );
}
