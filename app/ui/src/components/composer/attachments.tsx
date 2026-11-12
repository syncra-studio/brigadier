import { createContext, type MouseEventHandler, type ReactNode, useContext } from "react";

import { File, FileCode, FileDocument, FileImage, Paperclip, Spinner, Warning, X } from "../../icons";
import { formatBytes } from "../../files/viewer";
import { cx } from "../cx";
import { ImagePreview } from "../image-viewer";

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
  const failed = attachment?.state === "failed";
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
      title={failed ? attachment.error : label}
      className={cx("inline-flex max-w-full cursor-pointer items-center gap-0.5 rounded-control border bg-muted p-0.5 align-middle text-label text-foreground", failed ? "border-destructive" : "border-border")}
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
  onOpen,
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
  /** One click opens it [D2104]. */
  onOpen?: () => void;
}) {
  const body = (
    <>
      <span className="flex size-control-lg shrink-0 items-center justify-center rounded-icon-button bg-background text-muted-foreground">{icon}</span>
      <span className="flex min-w-0 flex-col text-start">
        <span className="truncate text-sm">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{detail}</span>
      </span>
    </>
  );
  return (
    <div
      data-slot={slot}
      title={hint}
      className={cx(
        "group/tile relative flex w-attachment-card shrink-0 items-center gap-2 rounded-surface border p-1.5 pe-7",
        invalid ? "border-invalid" : "border-border",
      )}
    >
      {onOpen ? (
        <button type="button" aria-label={`Open ${hint}`} onClick={onOpen} className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm focus-visible:focus-ring">
          {body}
        </button>
      ) : (
        body
      )}
      {remove}
    </div>
  );
}

/** A file's tile: its kind's icon (or a spinner, or the failure's sign), its name and a second line. */
function FileTile({ attachment, remove, onOpen }: { attachment: Attachment; remove: ReactNode; onOpen?: () => void }) {
  const { name, mime, state } = attachment;
  const failed = state === "failed";
  const Icon = mime.startsWith("image/") ? FileImage : mime.startsWith("text/") || mime === "application/pdf" ? FileDocument : Paperclip;
  return (
    <Tile
      slot="attachment-file"
      hint={failed ? (attachment.error ?? "Couldn't attach this file") : baseName(name)}
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
      onOpen={state === "ready" ? onOpen : undefined}
    />
  );
}

/** An image's tile: a rounded thumbnail (pulsing until its bytes show), a spinner over it while stored. */
function ImageTile({ attachment, remove, onOpen }: { attachment: Attachment; remove: ReactNode; onOpen?: () => void }) {
  const { url, name } = attachment;
  const thumb = (
    <div className={cx("size-full overflow-hidden rounded-surface bg-muted", !url && "animate-pulse motion-reduce:animate-none")}>
      {url && <img src={url} alt={name} draggable={false} className={cx("size-full object-cover", attachment.state === "uploading" && "opacity-disabled")} />}
    </div>
  );
  return (
    <div data-slot="attachment-image" title={name} className="group/tile relative size-attachment-thumb shrink-0">
      {url && attachment.state === "ready" && onOpen ? (
        <button type="button" aria-label={`Preview ${name}`} onClick={onOpen} className="size-full cursor-pointer rounded-surface focus-visible:focus-ring">
          {thumb}
        </button>
      ) : (
        thumb
      )}
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
export function AttachmentTiles({ ids, onRemove, onOpen }: { ids: readonly string[]; onRemove: (id: string) => void; onOpen?: (attachment: Attachment) => void }) {
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
            {image ? <ImageTile attachment={attachment} remove={remove} onOpen={onOpen && (() => onOpen(attachment))} /> : <FileTile attachment={attachment} remove={remove} onOpen={onOpen && (() => onOpen(attachment))} />}
          </div>
        );
      })}
    </div>
  );
}

type SentTile = { id: string; name: string; mime: string; bytes: number; pasted?: boolean; url: string };

/**
 * A sent message's files, above its bubble: images as smaller thumbnails that open the viewer, other files as
 * cards with their kind and size that open with one click, as the old app's message attachments [D146].
 */
export function SentAttachments({
  files,
  onOpen,
}: {
  files: readonly SentTile[];
  onOpen: (file: SentTile) => void;
}) {
  if (files.length === 0) return null;
  const images = files.filter((file) => file.mime.startsWith("image/"));
  return (
    <ul data-slot="message-attachments" aria-label="Attachments" className="flex flex-wrap items-end justify-end gap-2">
      {files.map((file) => (
        <li key={file.id} className="flex">
          {file.mime.startsWith("image/") ? (
            <ImagePreview url={file.url} name={file.name} gallery={images.length > 1 ? { images, index: images.indexOf(file) } : undefined}>
              <button
                type="button"
                data-slot="attachment-image"
                aria-label={`Preview ${file.name}`}
                title={file.name}
                className="relative size-attachment-sent shrink-0 cursor-pointer overflow-hidden rounded-surface bg-muted focus-visible:focus-ring"
              >
                <img src={file.url} alt={file.name} draggable={false} className="size-full object-cover" />
                <span aria-hidden className="pointer-events-none absolute inset-0 rounded-surface ring-1 ring-border ring-inset" />
              </button>
            </ImagePreview>
          ) : (
            <button type="button" aria-label={`Open ${file.pasted ? "Pasted text" : file.name}`} onClick={() => onOpen(file)} className="cursor-pointer rounded-surface text-start focus-visible:focus-ring">
              <Tile
                slot="attachment-file"
                hint={file.name}
                icon={<FileTypeIcon name={file.name} className="size-icon-md" />}
                title={file.pasted ? "Pasted text" : file.name}
                detail={`${kindOf(file.name, file.mime)} · ${formatBytes(file.bytes)}`}
                remove={null}
              />
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
