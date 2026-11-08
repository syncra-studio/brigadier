import { Chat, CodeSquareSlash, File, FileDocument, FileImage, FilePresentation, FileSpreadsheet, Folder, Mcp, ToolsSkills } from "../../icons";
import { ProviderMark } from "./pickers";

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

/**
 * A command row's icon: Rust's (an SVG mark, or a same-origin image), else its kind's in colour: a command blue,
 * a skill magenta, an MCP prompt cyan.
 */
export function CommandKindIcon({ kind, icon }: { kind: "command" | "skill" | "mcp"; icon?: string | null }) {
  if (icon?.startsWith("<svg")) return <ProviderMark mark={icon} className="size-icon-md" />;
  if (icon) return <img src={icon} alt="" draggable={false} className="size-icon-md rounded-xs object-contain" />;
  if (kind === "skill") return <ToolsSkills aria-hidden className="text-ansi-magenta" />;
  if (kind === "mcp") return <Mcp aria-hidden className="text-ansi-cyan" />;
  return <CodeSquareSlash aria-hidden className="text-link" />;
}
