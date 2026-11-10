import { Tile, TileRemove } from "../components/composer/attachments";
import { Comment } from "../icons";
import { Clock, Sparkles, XCircle } from "./icons";

/**
 * What waits above the composer for the agent: a Resolve with agent, or a PR's Fix, check, comment or event. Nothing
 * is sent until the user sends [D1019, D1027, D1044]. PROPOSED contract; the composer carries it once wired.
 */
export type AgentChip =
  | { id: string; kind: "resolve"; conflicts: number; files: number; operation: "merging" | "rebasing"; onto: string }
  | { id: string; kind: "fix"; pr: number; reasons: string }
  | { id: string; kind: "check"; pr: number; name: string }
  | { id: string; kind: "comment"; pr: number; author: string; where: string | null; body: string }
  | { id: string; kind: "event"; pr: number; what: string; detail: string };

const plural = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

function face(chip: AgentChip) {
  switch (chip.kind) {
    case "resolve":
      return { icon: <Sparkles />, title: `Resolve ${plural(chip.conflicts, "conflict")}`, detail: `${plural(chip.files, "file")} · ${chip.operation} ${chip.onto}` };
    case "fix":
      return { icon: <Sparkles />, title: `Fix #${chip.pr}`, detail: chip.reasons };
    case "check":
      return { icon: <XCircle className="text-destructive" />, title: `Log of ${chip.name}`, detail: `#${chip.pr} · failed check` };
    case "comment":
      return { icon: <Comment />, title: chip.body, detail: `#${chip.pr} · ${chip.author}${chip.where ? ` on ${chip.where}` : ""}` };
    case "event":
      return { icon: <Clock />, title: `#${chip.pr} · ${chip.what}`, detail: chip.detail };
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
