import type { ComponentType } from "react";

import { Desktop } from "../../icons";
import { Grid, ImageSquare, Search } from "../../icons/tab";
import { Globe } from "../../icons/thread";
import { TeamGlyph } from "../../icons/worker-glyphs";
import { cx } from "../cx";
import { COMMAND_TONES } from "./kind-icons";
import type { SlashCommand } from "./menus";
import { TOOL_LINES } from "../../../../shared/session/composer";

/**
 * Brigadier's own tools, picked from the `/` or + menu or typed as `/<id>`: a chip in the text, which Rust
 * (crates/core/src/message.rs `tool`) sends as what it asks of the agent, after the message. PROPOSED.
 */
export type Tool = { id: string; line: string; Icon: ComponentType<{ className?: string }> };

const TOOL_ICONS: Record<string, Tool["Icon"]> = { computer: Desktop, browser: Globe, mockup: Grid, image: ImageSquare, research: Search, workers: TeamGlyph };
export const TOOLS: Tool[] = TOOL_LINES
  // Computer use is macOS's alone for now [D158].
  .filter(([id]) => id !== "computer" || window.brigadier?.platform === "darwin")
  .map(([id, line]) => ({ id, line, Icon: TOOL_ICONS[id]! }));

/** The tools as the `/` and + menus list them, each typed as its chip like a skill. */
export const TOOL_COMMANDS: SlashCommand[] = TOOLS.map((tool) => ({ id: tool.id, kind: "tool", label: `/${tool.id}`, description: tool.line, instant: false }));

export function ToolIcon({ id, className }: { id: string; className?: string }) {
  const Icon = TOOLS.find((each) => each.id === id)?.Icon;
  return Icon ? <Icon className={cx(COMMAND_TONES.tool, className)} /> : null;
}
