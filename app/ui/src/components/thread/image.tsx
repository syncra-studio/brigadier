import { createContext, useContext, useEffect, useState } from "react";

import { SessionOfThread } from "../../accounts/limit";
import { daemonRun } from "../../session/composer";
import { urlOf } from "../../session/files";
import type { Item } from "../../thread/item";
import { FileRef, linkPath } from "../../thread/refs";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { ImageContextMenu, ImagePreview } from "../image-viewer";
import { showToast } from "../toast";
import { IMAGE_WORDS } from "../../../../shared/words";
import { pathOf } from "../../../../shared/markdown";

type Size = { width: number; height: number };
type Made = Extract<Item, { kind: "image" }>;

/** Its widths: 400 for a square or tall image, 480 for a wide one, the column for one twice as wide as tall [D289]. */
function widthOf(size: Size | null): string {
  const ratio = size ? size.width / size.height : 1;
  return ratio >= 2 ? "max-w-full" : ratio > 1.01 ? "max-w-120" : "max-w-100";
}

const revealIn = (owner: string, file: string) =>
  void daemonRun(["attach", owner, "reveal", file]).then((reply) => !reply.ok && showToast(String(reply.error ?? "Couldn't show the image in Finder"), { tone: "error" }));

/**
 * An image the agent makes [D289, D299, D300]: while it's made, "Creating image" over a square
 * of faint breathing dots, no made-up progress; once made, the picture at its own shape in that place, opening the
 * viewer, its right-click Copy, Download and Show in Finder.
 */
export function ImageRow({ item }: { item: Made }) {
  const owner = useContext(SessionOfThread)?.id;
  const [size, setSize] = useState<Size | null>(null);
  if (item.progress === "failed") {
    const limit = item.error === "usageLimitExceeded";
    return <ErrorLine size="sm" error={limit ? IMAGE_WORDS.limit : IMAGE_WORDS.failed} />;
  }
  if (item.progress !== "done") {
    return (
      <div className="flex flex-col gap-2">
        <span className="w-fit text-sm shimmer">{IMAGE_WORDS.making}</span>
        <div role="img" aria-label={IMAGE_WORDS.making} className="aspect-square w-full max-w-100 rounded-image bg-fill">
          <div className="size-full rounded-image image-making" />
        </div>
      </div>
    );
  }
  if (!owner || !item.attachment || !item.name) return <p className="text-sm text-muted-foreground">{IMAGE_WORDS.missing}</p>;
  const url = urlOf(owner, item.attachment);
  const reveal = () => revealIn(owner, item.attachment!);
  const image = { name: item.name, url, reveal };
  return (
    <ImagePreview url={url} name={item.name} reveal={reveal}>
      <ImageContextMenu image={image}>
        <button type="button" aria-label="Open image" className={cx("block w-full cursor-zoom-in overflow-hidden rounded-image focus-visible:focus-ring", widthOf(size))}>
          <img src={url} alt={item.prompt ?? "Image"} onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} className="block h-auto w-full animate-fade-in" />
        </button>
      </ImageContextMenu>
    </ImagePreview>
  );
}

/** Its size once it can be drawn, so it never shows broken; null when it can't. */
export async function drawable(url: string): Promise<Size | null> {
  const picture = new Image();
  picture.src = url;
  return picture.decode().then(
    () => (picture.naturalWidth ? { width: picture.naturalWidth, height: picture.naturalHeight } : null),
    () => null,
  );
}

/** Its reply is still being written. */
export const Streaming = createContext(false);

/** Inside a link: a click there is the link's, so an image draws plain and its words are plain. */
export const InLink = createContext(false);

/** An image that can't be drawn, as its alt text or file name: a link where it can be opened, a web image's in the browser, a file's by `onOpen`. */
export function ImageWords({ src, alt, onOpen }: { src?: string; alt?: string; onOpen?: () => void }) {
  const inLink = useContext(InLink);
  const web = /^(https?:|\/\/)/i.test(src ?? "");
  const words = alt || linkPath(web ? src!.replace(/[?#].*/, "") : (src ?? "")).split("/").findLast(Boolean) || "Image";
  const link = web ? <a href={src!.replace(/^\/\//, "https://")} target="_blank" rel="noreferrer">{words}</a> : onOpen && <FileRef word={words} open={onOpen} />;
  return <span data-slot="image-words">{(!inLink && link) || words}</span>;
}

/** `early`: read while its reply was still being written. */
type Picture = { name: string; url: string; size: Size | null; at?: string; early: boolean };
/** Read once for each place it's in, kept while the app runs: a row scrolled back, or drawn again as its text streams, has it at once. */
const pictures = new Map<string, { picture?: Picture; read: Promise<Picture> }>();
let reads = 0;
/** One that couldn't be drawn while its reply was written is read once more when that ends: it may be there by then. */
const again = (picture: Picture, streaming: boolean) => !picture.size && picture.early && !streaming;
function pictureOf(key: string, owner: string, src: string, streaming: boolean) {
  const had = pictures.get(key);
  if (had && !(had.picture && again(had.picture, streaming))) return had;
  const path = pathOf(src);
  const read = daemonRun(["attach", owner, "view", path]).then(async (reply): Promise<Picture> => {
    // The same copy's address may hold a newer picture: each read asks for it anew.
    const url = reply.ok ? `${urlOf(owner, reply.id)}?${++reads}` : "";
    const picture = { name: path.split("/").pop()!, url, size: url ? await drawable(url) : null, at: reply.at ?? undefined, early: streaming };
    entry.picture = picture;
    // One that can't be drawn yet may be by the next time its row is.
    if (!picture.size) setTimeout(() => pictures.get(key) === entry && pictures.delete(key), 10_000);
    return picture;
  });
  const entry: { picture?: Picture; read: Promise<Picture> } = { read };
  pictures.set(key, entry);
  return entry;
}

/** A thread's image by a path on disk or in its checkout, from the session's own copy, drawn as one the agent makes; nothing until it can be. */
export function ReplyImage({ src, alt, title, owner, keep }: { src: string; alt?: string; title?: string; owner: string; keep: string }) {
  const inLink = useContext(InLink);
  const key = `${owner}\n${keep}\n${src}`;
  const streaming = useContext(Streaming);
  const [picture, setPicture] = useState(() => pictures.get(key)?.picture);
  const [broken, setBroken] = useState(false);
  useEffect(() => {
    if (picture && !again(picture, streaming)) return;
    let live = true;
    void pictureOf(key, owner, src, streaming).read.then((read) => live && setPicture(read));
    return () => void (live = false);
  }, [key, streaming, picture]);
  if (!picture) return null;
  const { name, url, size, at } = picture;
  const reveal = at ? () => revealIn(owner, at) : undefined;
  if (!size || broken) return <ImageWords src={src} alt={alt} onOpen={reveal} />;
  const drawn = <img src={url} alt={alt || name} title={title} width={size.width} height={size.height} onError={() => setBroken(true)} className="block h-auto max-w-full" />;
  const look = cx("my-3 block w-fit overflow-hidden rounded-image", widthOf(size));
  if (inLink) return <span data-slot="reply-image" className={look}>{drawn}</span>;
  return (
    <ImagePreview url={url} name={name} reveal={reveal}>
      <ImageContextMenu image={{ name, url, reveal }}>
        <button type="button" aria-label={alt ? `Open image: ${alt}` : "Open image"} data-slot="reply-image" className={cx(look, "cursor-zoom-in focus-visible:focus-ring")}>
          {drawn}
        </button>
      </ImageContextMenu>
    </ImagePreview>
  );
}
