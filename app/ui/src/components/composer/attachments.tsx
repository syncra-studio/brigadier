import { createContext, type MouseEventHandler, type ReactNode, useContext } from "react";

import { File, FileCode, FileDocument, FileImage, Paperclip, Spinner, Warning, X } from "../../icons";
import { cx } from "../cx";

/**
 * A file going with a message: an image or a long paste in the text (a chip), any other file as a tile beside
 * it. Rust stores it under the session's folder and says how it went; the composer adds it at once, by the id
 * it made, and settles by that id. PROPOSED to the owning runs (msgs/w15-fields-3.md).
 */
export type Attachment = {
  id: string;
  name: string;
  mime: string;
  state: "uploading" | "ready" | "failed";
  /** Why it failed, in plain words. */
  error?: string;
  /** Where its bytes show (an image's thumbnail); none yet, the box pulses. */
  url?: string;
};

/** The composer's attachments by id, for its chips and tiles. */
export const AttachmentsContext = createContext<ReadonlyMap<string, Attachment>>(new Map());

/** The number an image or pasted text has in the text ("Image #2"), by attachment id; the field counts them. */
export const ChipNumbers = createContext<ReadonlyMap<string, number>>(new Map());

/** A file's icon by its extension. */
export function FileTypeIcon({ name, className }: { name: string; className?: string }) {
  const extension = name.includes(".") ? (name.split(".").pop()?.toLowerCase() ?? "") : "";
  const Icon = /^(png|jpe?g|gif|webp|svg|heic|bmp|ico)$/.test(extension)
    ? FileImage
    : /^(md|mdx|txt|rst|pdf|docx?|rtf)$/.test(extension)
      ? FileDocument
      : !extension || /^(json|ya?ml|toml|lock|ini|env|csv|xml|plist|cfg|conf)$/.test(extension)
        ? File
        : FileCode;
  return <Icon aria-hidden className={className} />;
}

/** "PDF", "PNG image", "Text": what a file's tile says under its name. */
function kindOf(name: string, mime: string): string {
  if (mime === "application/pdf") return "PDF";
  const extension = name.includes(".") ? name.split(".").pop()?.toUpperCase() : undefined;
  if (mime.startsWith("image/")) return extension ? `${extension} image` : "Image";
  if (mime.startsWith("text/")) return extension ? `${extension} text` : "Text";
  return extension ? `${extension} file` : "File";
}

const baseName = (name: string) => name.slice(name.lastIndexOf("/") + 1);

/**
 * The ✕ that takes an attachment out: a dark dot at a tile's corner (on an image only while hovered or
 * focused), or `small` inside a chip, its reach a little larger than it looks.
 */
export function TileRemove({
  label,
  onClick,
  onHover = false,
  small = false,
}: {
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  onHover?: boolean;
  small?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cx(
        "flex shrink-0 cursor-pointer items-center justify-center rounded-capsule bg-foreground text-background focus-visible:focus-ring",
        "transition-all motion-safe:active:scale-press",
        small ? "relative size-icon-xs after:absolute after:-inset-1" : "absolute end-1.5 top-1.5 z-10 size-icon-md",
        onHover && "opacity-0 group-hover/tile:opacity-100 focus-visible:opacity-100",
      )}
    >
      <X aria-hidden className={small ? "size-2" : "size-icon-xs"} />
    </button>
  );
}

/**
 * An image or a pasted text where it sits in the text: its thumbnail or icon, and "Image #n" or the paste's first
 * words (cut with …); in the field a ✕.
 */
export function InlineAttachment({
  id,
  paste = false,
  preview,
  onOpen,
  onRemove,
}: {
  id: string;
  paste?: boolean;
  /** A paste's first words. */
  preview?: string;
  onOpen?: () => void;
  onRemove?: MouseEventHandler<HTMLButtonElement>;
}) {
  const attachment = useContext(AttachmentsContext).get(id);
  const n = useContext(ChipNumbers).get(id);
  const label = paste ? (preview ? `Pasted text: ${preview}…` : `Pasted text${n ? ` #${n}` : ""}`) : `Image${n ? ` #${n}` : ""}`;
  const busy = attachment?.state === "uploading";
  const face = (
    <>
      <span aria-hidden className={cx("inline-flex min-w-0 items-center gap-1 rounded-sm", paste ? "px-0.5" : "pe-0.5", busy && "opacity-disabled")}>
        {paste ? (
          <FileDocument className="size-icon-sm shrink-0" />
        ) : attachment?.url ? (
          <img src={attachment.url} alt="" draggable={false} className="size-icon-md shrink-0 rounded-xs object-cover" />
        ) : (
          <FileImage className="size-icon-sm shrink-0" />
        )}
        {/* A very short preview: the words run out at the chip's edge. */}
        <span className={cx(paste && preview && "max-w-32 truncate")}>{paste && preview ? preview : label}</span>
      </span>
      {/* Screen readers hear the whole label, not the cut words. */}
      <span className="sr-only">{label}</span>
    </>
  );
  return (
    <span
      data-slot={paste ? "inline-paste" : "inline-image"}
      title={label}
      className="inline-flex max-w-full cursor-pointer items-center gap-0.5 rounded-control border border-border bg-muted p-0.5 align-middle text-label text-foreground"
    >
      {onOpen ? (
        // A button where it opens, so Tab reaches it and Enter or Space opens it.
        <button type="button" onClick={onOpen} className="inline-flex min-w-0 cursor-pointer items-center rounded-sm focus-visible:focus-ring">
          {face}
        </button>
      ) : (
        face
      )}
      {onRemove && <TileRemove small label={`Remove ${paste ? "pasted text" : label}`} onClick={onRemove} />}
    </span>
  );
}

/**
 * A tile in the attachments row: an icon in its box, a title over a second line, and its ✕. A file's tile is one;
 * so is anything else that goes with the next message, such as a comment on a diff.
 */
export function Tile({
  slot,
  hint,
  icon,
  title,
  detail,
  invalid = false,
  remove,
}: {
  slot: string;
  /** The whole title, shown on hover. */
  hint: string;
  icon: ReactNode;
  title: ReactNode;
  detail: ReactNode;
  /** A red border, for a tile that failed. */
  invalid?: boolean;
  remove: ReactNode;
}) {
  return (
    <div
      data-slot={slot}
      title={hint}
      className={cx(
        "group/tile relative flex w-attachment-card shrink-0 items-center gap-2 rounded-surface border p-1.5 pe-7",
        invalid ? "border-invalid" : "border-border",
      )}
    >
      <span className="flex size-control-lg shrink-0 items-center justify-center rounded-icon-button bg-background text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-col text-start">
        <span className="truncate text-sm">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      </span>
      {remove}
    </div>
  );
}

/** A file's tile: its kind's icon (or a spinner, or the failure's sign), its name and a second line. */
function FileTile({ attachment, remove }: { attachment: Attachment; remove: ReactNode }) {
  const { name, mime, state } = attachment;
  const failed = state === "failed";
  const Icon = mime.startsWith("image/") ? FileImage : mime.startsWith("text/") || mime === "application/pdf" ? FileDocument : Paperclip;
  return (
    <Tile
      slot="attachment-file"
      hint={baseName(name)}
      invalid={failed}
      icon={
        failed ? (
          <Warning aria-label="Upload failed" className="size-icon-md text-destructive" />
        ) : state === "uploading" ? (
          <Spinner aria-label="Uploading" className="size-icon-md motion-safe:animate-spin" />
        ) : (
          <Icon aria-hidden className="size-icon-md" />
        )
      }
      title={baseName(name)}
      detail={failed ? (attachment.error ?? "Couldn't attach this file") : state === "uploading" ? "Attaching…" : kindOf(name, mime)}
      remove={remove}
    />
  );
}

/** An image's tile: a rounded thumbnail (pulsing until its bytes show), a spinner over it while stored. */
function ImageTile({ attachment, remove }: { attachment: Attachment; remove: ReactNode }) {
  const { url, name } = attachment;
  return (
    <div data-slot="attachment-image" title={name} className="group/tile relative size-attachment-thumb shrink-0">
      <div className={cx("size-full overflow-hidden rounded-surface bg-muted", !url && "animate-pulse motion-reduce:animate-none")}>
        {url && (
          <img src={url} alt={name} draggable={false} className={cx("size-full object-cover", attachment.state === "uploading" && "opacity-disabled")} />
        )}
      </div>
      <span aria-hidden className="pointer-events-none absolute inset-0 rounded-surface ring-1 ring-border ring-inset" />
      {attachment.state === "uploading" && (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <Spinner aria-label="Uploading" className="size-icon-md motion-safe:animate-spin" />
        </span>
      )}
      {remove}
    </div>
  );
}

/**
 * The files attached beside the text, over the field: images as thumbnails, other files as tiles, each with
 * its ✕. One that failed shows as a tile saying why, so pass an image or paste in the text that failed too
 * (its chip stays in the text). Ids with no attachment yet show nothing.
 */
export function AttachmentTiles({ ids, onRemove }: { ids: readonly string[]; onRemove: (id: string) => void }) {
  const all = useContext(AttachmentsContext);
  return (
    <div data-slot="composer-attachments" className="flex w-full flex-wrap items-end gap-2 px-1 pt-1 pb-1.5 empty:hidden">
      {ids.map((id) => {
        const attachment = all.get(id);
        if (!attachment) return null;
        const image = attachment.mime.startsWith("image/") && attachment.state !== "failed";
        const remove = <TileRemove label={`Remove ${baseName(attachment.name)}`} onHover={image} onClick={() => onRemove(id)} />;
        return (
          <div key={id} data-slot="composer-attachment" data-state={attachment.state} className="motion-safe:animate-fade-in">
            {image ? <ImageTile attachment={attachment} remove={remove} /> : <FileTile attachment={attachment} remove={remove} />}
          </div>
        );
      })}
    </div>
  );
}
