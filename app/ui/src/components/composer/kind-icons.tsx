import { Chat, CodeSquareSlash, File, FileDocument, FileImage, FilePresentation, FileSpreadsheet, Folder, Mcp, ToolsSkills } from "../../icons";
import { cx } from "../cx";
import { ProviderMark } from "./model-picker";

const extensionOf = (name: string) => (name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "");

/** A coloured file glyph by kind: documents blue, PDFs red, sheets green, slides orange, images magenta. */
const GLYPHS: [RegExp, typeof File, string][] = [
  [/^pdf$/, FileDocument, "text-destructive"],
  [/^(md|mdx|txt|rst|docx?|rtf|pages)$/, FileDocument, "text-link"],
  [/^(csv|tsv|xlsx?|numbers)$/, FileSpreadsheet, "text-success"],
  [/^(pptx?|key)$/, FilePresentation, "text-full-access"],
  [/^(png|jpe?g|gif|webp|svg|heic|bmp|ico)$/, FileImage, "text-ansi-magenta"],
];

/**
 * A file's icon in a menu: its kind's glyph in its colour, or for code and config a grey badge with its
 * extension ("TS", "JSON"); a file with no extension, a plain page.
 */
export function FileBadge({ name }: { name: string }) {
  const extension = extensionOf(name);
  const glyph = GLYPHS.find(([pattern]) => pattern.test(extension));
  if (glyph) {
    const [, Icon, tone] = glyph;
    return <Icon aria-hidden className={tone} />;
  }
  if (!extension) return <File aria-hidden className="text-muted-foreground" />;
  const letters = extension.slice(0, 4).toUpperCase();
  // Drawn in the icon's own box, the letters shrinking to fit four.
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-icon-md">
      <rect x="0.5" y="2.5" width="15" height="11" rx="3" className="fill-fill-active" />
      <text x="8" y="10.4" textAnchor="middle" fontSize={letters.length > 3 ? 5 : letters.length > 2 ? 5.75 : 6.75} className="fill-foreground font-sans font-semibold">
        {letters}
      </text>
    </svg>
  );
}

/** A mention row's icon: a file's badge, a folder, a chat. */
export function MentionKindIcon({ type, label }: { type: "file" | "folder" | "chat"; label: string }) {
  if (type === "chat") return <Chat aria-hidden className="text-muted-foreground" />;
  if (type === "folder") return <Folder aria-hidden className="text-muted-foreground" />;
  return <FileBadge name={label} />;
}

/** A command's colour by kind, for its icon and its chip's name. */
export const COMMAND_TONES = { command: "text-link", skill: "text-ansi-magenta", mcp: "text-ansi-cyan" };

/**
 * A command's icon: Rust's (an SVG mark, or a same-origin image), else its kind's in colour: a command blue,
 * a skill magenta, an MCP prompt cyan. `className` sizes it (a menu row's own size otherwise).
 */
export function CommandKindIcon({ kind, icon, className }: { kind: "command" | "skill" | "mcp"; icon?: string | null; className?: string }) {
  if (icon?.startsWith("<svg")) return <ProviderMark mark={icon} className={className ?? "size-icon-md"} />;
  if (icon) return <img src={icon} alt="" draggable={false} className={cx("rounded-xs object-contain", className ?? "size-icon-md")} />;
  const Icon = kind === "skill" ? ToolsSkills : kind === "mcp" ? Mcp : CodeSquareSlash;
  return <Icon aria-hidden className={cx(COMMAND_TONES[kind], className)} />;
}
