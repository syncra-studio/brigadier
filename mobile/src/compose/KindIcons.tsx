// The composer's kind icons, as the desktop's composer/kind-icons.tsx, tools.tsx and model-picker.tsx ProviderMark draw
// them, from the desktop's own icon files [D98, D99].
import { SvgXml } from "react-native-svg";
import { Chat, CodeSquareSlash, Desktop, File, Folder, Globe, Mcp, StickyNote, ToolsSkills } from "../../../app/ui/src/icons";
import { Plugin } from "../../../app/ui/src/icons/settings";
import { Grid, ImageSquare, Search } from "../../../app/ui/src/icons/tab";
import { Terminal } from "../../../app/ui/src/icons/thread";
import { TeamGlyph, WorkerGlyph } from "../../../app/ui/src/icons/worker-glyphs";
import { color, colorOf, spacing } from "../theme";
import type { Command, Mention } from "./Menus";
import { COMMAND_TONES } from "./Menus";

/** An agent's mark, from its adapter (an SVG, trusted, built in), drawn as the desktop's innerHTML does; without one, a terminal. */
export function ProviderMark({ mark, size = spacing.iconMd }: { mark: string | null | undefined; size?: number }) {
  if (!mark) return <Terminal width={size} height={size} color={color.foreground} />;
  // A mark may fill with a desktop colour (var(--color-brand-…)), which SvgXml can't resolve: the theme's value instead.
  return <SvgXml xml={mark.replace(/var\(--color-([a-z0-9-]+)\)/g, (_, name: string) => colorOf(name))} width={size} height={size} color={color.foreground} />;
}

const TOOL_ICONS: Record<string, typeof Desktop> = { computer: Desktop, browser: Globe, mockup: Grid, image: ImageSquare, research: Search, workers: TeamGlyph };

/** A `/` row's icon: a tool's own, Rust's SVG mark, else its kind's in its colour (an image URL is the Mac's, so its kind's). */
export function CommandIcon({ command }: { command: Command }) {
  if (command.kind === "tool") {
    const Icon = TOOL_ICONS[command.id];
    return Icon ? <Icon className="size-icon-md" color={COMMAND_TONES.tool} /> : null;
  }
  if (command.icon?.startsWith("<svg")) return <ProviderMark mark={command.icon} />;
  const Icon = command.kind === "skill" ? ToolsSkills : command.kind === "mcp" || command.kind === "prompt" ? Mcp : CodeSquareSlash;
  return <Icon className="size-icon-md" color={COMMAND_TONES[command.kind]} />;
}

/** A mention's icon: a chat, a worker's glyph, a tab, a note, a plugin, a folder or a file. */
export function MentionIcon({ item }: { item: Mention }) {
  if (item.type === "worker" || item.type === "direct") return <WorkerGlyph id={item.id} />;
  if (item.type === "note") return <StickyNote className="size-icon-md text-warning" />;
  const Icon = { chat: Chat, tab: Globe, plugin: Plugin, folder: Folder }[item.type] ?? File;
  return <Icon className="size-icon-md text-muted-foreground" />;
}
