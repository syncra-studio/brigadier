import { Chat, CodeSquareSlash, File, FileDocument, FileImage, FilePresentation, FileSpreadsheet, Folder, Globe, Mcp, StickyNote, ToolsSkills } from "../../icons";
import { cx } from "../cx";
import { Plugin } from "../../icons/settings";
import { WorkerGlyph } from "../../icons/worker-glyphs";
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
export function FileBadge({ name, className }: { name: string; className?: string }) {
  const extension = extensionOf(name);
  const glyph = GLYPHS.find(([pattern]) => pattern.test(extension));
  if (glyph) {
    const [, Icon, tone] = glyph;
    return <Icon aria-hidden className={cx(tone, className)} />;
  }
  if (!extension) return <File aria-hidden className={cx("text-muted-foreground", className)} />;
  const letters = extension.slice(0, 4).toUpperCase();
  // Drawn in the icon's own box, the letters shrinking to fit four.
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={className ?? "size-icon-md"}>
      <rect x="0.5" y="2.5" width="15" height="11" rx="3" className="fill-fill-active" />
      <text x="8" y="10.4" textAnchor="middle" fontSize={letters.length > 3 ? 5 : letters.length > 2 ? 5.75 : 6.75} className="fill-foreground font-sans font-semibold">
        {letters}
      </text>
    </svg>
  );
}

/** A file's colour, where its kind's glyph has one: for its chip's name, as a command's chip takes its kind's. */
export const fileTone = (name: string) => GLYPHS.find(([pattern]) => pattern.test(extensionOf(name)))?.[2];

/** A note's chip label as its emoji, if it has one, and its name [D921]. */
export function noteName(label: string): { emoji: string | null; name: string } {
  const emoji = /^(\p{Extended_Pictographic}\uFE0F?)\s+/u.exec(label);
  return emoji ? { emoji: emoji[1]!, name: label.slice(emoji[0].length) } : { emoji: null, name: label };
}

/** A note's colour, for its icon and its chip's name, as a skill's is magenta [D921]. */
export const NOTE_TONE = "text-warning";

/** A mention's icon, in a menu row or its chip: a file's badge, a folder, a chat, a worker's glyph, a note's emoji or page. `className` sizes it (a menu row's own size otherwise). */
export function MentionKindIcon({ type, id, label, className }: { type: "file" | "folder" | "chat" | "worker" | "direct" | "tab" | "note" | "plugin"; id?: string; label: string; className?: string }) {
  if (type === "note") {
    const { emoji } = noteName(label);
    if (emoji) return <span aria-hidden className={cx("inline-flex items-center justify-center leading-none", className ?? "size-icon-md")}>{emoji}</span>;
    return <StickyNote aria-hidden className={cx(NOTE_TONE, className)} />;
  }
  if (type === "tab") return <Globe aria-hidden className={cx("text-muted-foreground", className)} />;
  if (type === "plugin") return <Plugin aria-hidden className={cx("text-muted-foreground", className)} />;
  if (type === "worker" || type === "direct") return <WorkerGlyph id={id ?? label} className={className} />;
  if (type === "chat") return <Chat aria-hidden className={cx("text-muted-foreground", className)} />;
  if (type === "folder") return <Folder aria-hidden className={cx("text-muted-foreground", className)} />;
  return <FileBadge name={label} className={className} />;
}

/** A command's colour by kind, for its icon and its chip's name. */
/** A tool's is green (components/composer/tools.tsx). */
export const COMMAND_TONES = { command: "text-link", tool: "text-success", skill: "text-ansi-magenta", mcp: "text-ansi-cyan" };

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
