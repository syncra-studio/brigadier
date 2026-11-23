import type { ComponentType } from "react";

import { Desktop, X } from "../../icons";
import { Grid, ImageSquare, Search } from "../../icons/tab";
import { Globe } from "../../icons/thread";
import { TeamGlyph } from "../../icons/worker-glyphs";
import { cx } from "../cx";
import { ComposerPill } from "./composer";

/**
 * Brigadier's own tools, switched on for the next message from the `/` or + menu: a pill beside +, and `text`, what the
 * lead reads after the message so it and its workers use that tool. PROPOSED.
 */
export type Tool = { id: string; name: string; line: string; Icon: ComponentType<{ className?: string }>; text: string };

export const TOOLS: Tool[] = [
  { id: "computer", name: "Computer use", line: "Use the apps on your Mac", Icon: Desktop, text: "Use computer use (`brigadier computer`) for this, and have your workers use it too." },
  { id: "browser", name: "Browser", line: "Open pages, click and type in Brigadier's browser", Icon: Globe, text: "Use Brigadier's browser (`brigadier browser`) for this, and have your workers use it too." },
  { id: "mockup", name: "Mockup", line: "Draw 3 looks to pick from before building", Icon: Grid, text: "Draw me a mockup first (`brigadier mockup`), before building it." },
  { id: "image", name: "Image", line: "Make or edit a picture", Icon: ImageSquare, text: "Make or edit the images this needs with your image tool." },
  { id: "research", name: "Web research", line: "Search and read the web, with sources", Icon: Search, text: "Research this on the web, and give me your sources." },
  { id: "workers", name: "Workers", line: "Split the job across workers in parallel", Icon: TeamGlyph, text: "Split this job across workers (`brigadier start`) that run in parallel." },
];
export const toolOf = (id: string) => TOOLS.find((each) => each.id === id);

/** A tool's colour, beside a command's blue, a skill's magenta and an MCP prompt's cyan. */
const TONE = "text-success";

export function ToolIcon({ id, className }: { id: string; className?: string }) {
  const Icon = toolOf(id)?.Icon;
  return Icon ? <Icon className={cx(TONE, className)} /> : null;
}

/** A tool switched on, beside +: its icon and name; a click switches it off. */
export function ToolPill({ id, onRemove }: { id: string; onRemove?: () => void }) {
  return (
    <ComposerPill className="text-foreground" aria-label={`Remove ${toolOf(id)?.name ?? id}`} onClick={onRemove}>
      <ToolIcon id={id} />
      {toolOf(id)?.name ?? id}
      <X className="text-muted-foreground" />
    </ComposerPill>
  );
}
