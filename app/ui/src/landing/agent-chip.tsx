import { Tile, TileRemove } from "../components/composer/attachments";
import { Sparkles, XCircle } from "./icons";

export type { AgentChip } from "../../../shared/chips";
import { type AgentChip, agentChipWords } from "../../../shared/chips";

const face = (chip: AgentChip) => ({ icon: chip.kind === "resolve" ? <Sparkles /> : <XCircle className="text-destructive" />, ...agentChipWords(chip) });

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
