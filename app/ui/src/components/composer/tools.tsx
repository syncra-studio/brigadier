import type { ComponentType } from "react";

import { Desktop } from "../../icons";
import { Grid, ImageSquare, Search } from "../../icons/tab";
import { Globe } from "../../icons/thread";
import { TeamGlyph } from "../../icons/worker-glyphs";
import { cx } from "../cx";
import { COMMAND_TONES } from "./kind-icons";
import type { SlashCommand } from "./menus";

/**
 * Brigadier's own tools, picked from the `/` or + menu or typed as `/<id>`: a chip in the text, which Rust
 * (crates/core/src/message.rs `tool`) sends as what it asks of the agent, after the message. PROPOSED.
 */
export type Tool = { id: string; line: string; Icon: ComponentType<{ className?: string }> };

export const TOOLS: Tool[] = [
  { id: "computer", line: "Use the apps on your Mac", Icon: Desktop },
  { id: "browser", line: "Open pages, click and type in Brigadier's browser", Icon: Globe },
  { id: "mockup", line: "Draw 3 looks to pick from before building", Icon: Grid },
  { id: "image", line: "Make or edit a picture", Icon: ImageSquare },
  { id: "research", line: "Search and read the web, with sources", Icon: Search },
  { id: "workers", line: "Split the job across workers in parallel", Icon: TeamGlyph },
];

/** The tools as the `/` and + menus list them, each typed as its chip like a skill. */
export const TOOL_COMMANDS: SlashCommand[] = TOOLS.map((tool) => ({ id: tool.id, kind: "tool", label: `/${tool.id}`, description: tool.line, instant: false }));

export function ToolIcon({ id, className }: { id: string; className?: string }) {
  const Icon = TOOLS.find((each) => each.id === id)?.Icon;
  return Icon ? <Icon className={cx(COMMAND_TONES.tool, className)} /> : null;
}
