import { useContext, useState } from "react";

import { SessionOfThread } from "../../accounts/limit";
import { daemonRun } from "../../session/composer";
import { urlOf } from "../../session/files";
import type { Item } from "../../thread/item";
import { cx } from "../cx";
import { ErrorLine } from "../error-line";
import { ImageContextMenu, ImagePreview } from "../image-viewer";
import { showToast } from "../toast";

type Made = Extract<Item, { kind: "image" }>;

/** Its widths: 400 for a square or tall image, 480 for a wide one, the column for one twice as wide as tall [D289]. */
function widthOf(size: { width: number; height: number } | null): string {
  const ratio = size ? size.width / size.height : 1;
  return ratio >= 2 ? "max-w-full" : ratio > 1.01 ? "max-w-120" : "max-w-100";
}

/**
 * An image the agent makes [D289, D299, D300]: while it's made, "Creating image" over a square
 * of faint breathing dots, no made-up progress; once made, the picture at its own shape in that place, opening the
 * viewer, its right-click Copy, Download and Show in Finder.
 */
export function ImageRow({ item }: { item: Made }) {
  const owner = useContext(SessionOfThread)?.id;
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  if (item.progress === "failed") {
    const limit = item.error === "usageLimitExceeded";
    return <ErrorLine size="sm" error={limit ? "Couldn't create the image: its usage limit was reached." : "Couldn't create the image."} />;
  }
  if (item.progress !== "done") {
    return (
      <div className="flex flex-col gap-2">
        <span className="w-fit text-sm shimmer">Creating image</span>
        <div role="img" aria-label="Creating image" className="aspect-square w-full max-w-100 rounded-image bg-fill">
          <div className="size-full rounded-image image-making" />
        </div>
      </div>
    );
  }
  if (!owner || !item.attachment || !item.name) return <p className="text-sm text-muted-foreground">The image isn't available.</p>;
  const url = urlOf(owner, item.attachment);
  const reveal = () =>
    void daemonRun(["attach", owner, "reveal", item.attachment!]).then((reply) => !reply.ok && showToast(String(reply.error ?? "Couldn't show the image in Finder"), { tone: "error" }));
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
