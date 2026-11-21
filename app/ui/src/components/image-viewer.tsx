import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import {
  type ComponentProps,
  type Dispatch,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type SetStateAction,
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { ChevronLeft, ChevronRight, Download, Minus, Plus, X } from "../icons";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./context-menu";
import { cx } from "./cx";
import { Dialog, DialogClose, DialogTitle, DialogTrigger } from "./dialog";
import { showToast } from "./toast";

const RAMP = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5];
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const percentage = new Intl.NumberFormat(undefined, { style: "percent", maximumFractionDigits: 0 });
const PRESS = "cursor-pointer transition-all focus-visible:focus-ring motion-safe:active:scale-press disabled:cursor-not-allowed disabled:opacity-disabled";
const roundButton = cx(
  "flex h-10 min-w-10 items-center justify-center rounded-capsule bg-muted text-foreground shadow-image-viewer-button hover:bg-popover",
  PRESS,
);
const zoomButton = cx("flex size-9 items-center justify-center rounded-capsule bg-fill-hover hover:bg-marker", PRESS);

/** One image a viewer can show. */
export type ViewerImage = { name: string; url: string };
type Gallery = { images: readonly ViewerImage[]; index: number };
type Size = { width: number; height: number };

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && !!target.closest("input, textarea, select, [contenteditable=true]");
}

async function copyImage(url: string): Promise<void> {
  try {
    // Start the clipboard write during the user gesture; the PNG may finish later.
    const png = (async () => {
      const picture = new Image();
      picture.src = url;
      await picture.decode();
      const canvas = document.createElement("canvas");
      canvas.width = picture.naturalWidth;
      canvas.height = picture.naturalHeight;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.drawImage(picture, 0, 0);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("PNG conversion failed"))), "image/png"));
    })();
    await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
  } catch {
    showToast("Could not copy image", { tone: "error" });
  }
}

/** Saves a copy of a sent image where the user picks, starting in Downloads, as the old viewer's Download. */
async function downloadImage(image: ViewerImage): Promise<void> {
  try {
    await window.brigadier?.saveAttachment(new URL(image.url, location.href).pathname, image.name || "image");
  } catch {
    showToast("Could not download image", { tone: "error" });
  }
}

/** Reuse around thumbnail triggers so their right-click menu matches the full image. */
export function ImageContextMenu({
  image,
  children,
  ...trigger
}: { image: ViewerImage; children: ReactElement } & Omit<ComponentProps<typeof ContextMenuTrigger>, "render" | "children">) {
  // What a trigger around it passes on (the viewer's click, its ref) reaches the thumbnail too.
  return (
    <ContextMenu>
      <ContextMenuTrigger render={children} {...trigger} />
      <ContextMenuContent>
        <ContextMenuItem onClick={() => void copyImage(image.url)}>Copy</ContextMenuItem>
        <ContextMenuItem onClick={() => void downloadImage(image)}>Download</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** Whether to morph: the browser can, and the user hasn't asked for less motion. */
function morphs(): boolean {
  return typeof document.startViewTransition === "function" && !matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The full-window image viewer: the image over a near-black backdrop, grown out of the thumbnail
 * that opened it and shrunk back into it on close (a plain fade where the browser can't morph,
 * at once with less motion); "− 100% +" zoom (also +, −, 0, and pinch or ⌘-wheel); ‹ › and ←/→
 * between the images of a set, with "2 of 5"; Esc, × or a click on the backdrop closes it.
 * `children` is the thumbnail that opens it.
 */
export function ImagePreview({
  url,
  name,
  gallery,
  children,
}: {
  url: string;
  name: string;
  /** The set this image belongs to (a message's images), and where it is in it. */
  gallery?: Gallery | undefined;
  children: ReactElement;
}) {
  const images = gallery?.images ?? [{ name, url }];
  const first = gallery?.index ?? 0;
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState(first);
  const [morph, setMorph] = useState(false);
  // How it opened: grown out of its thumbnail, or faded in. Only a fade-in has the enter fade:
  // added once a morph is over, it would fade the shown viewer out and in again.
  const [grown, setGrown] = useState(false);
  const thumbnail = useRef<HTMLElement | null>(null);
  const shown = useRef<HTMLImageElement | null>(null);
  // The thumbnail's picture size: the opening image is laid out at its own size from its first
  // frame, not grown to it once it loads.
  const [size, setSize] = useState<Size | null>(null);

  const show = (opener: HTMLElement) => {
    thumbnail.current = opener.querySelector("img") ?? opener;
    const picture = thumbnail.current instanceof HTMLImageElement && thumbnail.current.naturalWidth > 0 ? thumbnail.current : null;
    setSize(picture ? { width: picture.naturalWidth, height: picture.naturalHeight } : null);
    setAt(first);
    if (!morphs()) {
      setGrown(false);
      setOpen(true);
      return;
    }
    const thumb = thumbnail.current;
    thumb.dataset.imageMorph = "";
    document
      .startViewTransition(async () => {
        delete thumb.dataset.imageMorph;
        flushSync(() => {
          setMorph(true);
          setGrown(true);
          setOpen(true);
        });
        // The new picture is taken once the image can be drawn.
        await shown.current?.decode().catch(() => undefined);
      })
      .finished.finally(() => setMorph(false));
  };

  const hide = () => {
    const thumb = thumbnail.current;
    // Back into its thumbnail only from the image that opened it.
    if (!morphs() || !thumb || at !== first) {
      setOpen(false);
      return;
    }
    // The shown image takes the shared name first, so the morph starts from it.
    flushSync(() => setMorph(true));
    document
      .startViewTransition(() => {
        flushSync(() => setOpen(false));
        thumb.dataset.imageMorph = "";
      })
      .finished.finally(() => {
        delete thumb.dataset.imageMorph;
        setMorph(false);
      });
  };

  return (
    <Viewer open={open} onHide={hide} images={images} at={at} setAt={setAt} first={first} size={size} morph={morph} grown={grown} shown={shown}>
      <DialogTrigger
        render={children}
        nativeButton={children.type === "button"}
        onClick={(event) => {
          event.preventDefault();
          show(event.currentTarget);
        }}
      />
    </Viewer>
  );
}

let showViewer: ((gallery: Gallery) => void) | null = null;

/** Opens the viewer on `images[index]` with no thumbnail to grow from (a composer chip's); ImageViewerHost draws it. */
export function viewImage(images: ViewerImage[], index: number): void {
  showViewer?.({ images, index });
}

/** Where `viewImage` shows the viewer: mounted once. */
export function ImageViewerHost() {
  const [images, setImages] = useState<readonly ViewerImage[]>([]);
  const [at, setAt] = useState(0);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    showViewer = (gallery) => {
      setImages(gallery.images);
      setAt(gallery.index);
      setOpen(true);
    };
    return () => {
      showViewer = null;
    };
  }, []);
  return <Viewer open={open} onHide={() => setOpen(false)} images={images} at={at} setAt={setAt} />;
}

/** The viewer's dialog, shared by ImagePreview and ImageViewerHost; `children` is its trigger, if any. */
function Viewer({
  open,
  onHide,
  images,
  at,
  setAt,
  first = 0,
  size = null,
  morph = false,
  grown = false,
  shown,
  children,
}: {
  open: boolean;
  onHide: () => void;
  images: readonly ViewerImage[];
  at: number;
  setAt: Dispatch<SetStateAction<number>>;
  /** The image it opened on, which alone knows its size early and morphs. */
  first?: number;
  size?: Size | null;
  morph?: boolean;
  grown?: boolean;
  shown?: { current: HTMLImageElement | null };
  children?: ReactNode;
}) {
  const zoomKeys = useRef<ZoomKeys>(null);
  const step = (by: number) => setAt((current) => Math.min(images.length - 1, Math.max(0, current + by)));
  const image = images[at];
  // Shrunk back into the thumbnail: gone at once, so only the thumbnail holds the morph's name.
  const motion = { "data-morph": morph || undefined, "data-grown": grown || undefined, "data-gone": (!open && morph) || undefined };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onHide())}>
      {children}
      <BaseDialog.Portal>
        <BaseDialog.Backdrop {...motion} className="fixed inset-0 z-popup bg-image-viewer image-viewer-motion" />
        <BaseDialog.Popup
          {...motion}
          data-slot="image-preview"
          onKeyDown={(event: KeyboardEvent) => {
            if (typing(event.target) || event.altKey || event.ctrlKey || event.metaKey) return;
            if (event.shiftKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) return;
            if (event.key === "ArrowLeft") step(-1);
            else if (event.key === "ArrowRight") step(1);
            else if (!zoomKeys.current?.press(event.key)) return;
            event.preventDefault();
          }}
          onClick={(event) => {
            if (event.target === event.currentTarget) onHide();
          }}
          className="fixed inset-0 z-popup flex flex-col items-center justify-center bg-image-viewer p-16 outline-none image-viewer-motion"
        >
          <DialogTitle className="sr-only">Image preview</DialogTitle>
          {image && (
            <ShownImage
              key={at}
              image={image}
              size={at === first ? size : null}
              morph={morph && at === first}
              imageRef={shown}
              zoomKeys={zoomKeys}
              onBackdrop={onHide}
              count={images.length > 1 ? `${at + 1} of ${images.length}` : null}
            />
          )}
          {images.length > 1 && (
            <>
              <StepButton side="start" disabled={at === 0} onClick={() => step(-1)} />
              <StepButton side="end" disabled={at >= images.length - 1} onClick={() => step(1)} />
            </>
          )}
        </BaseDialog.Popup>
      </BaseDialog.Portal>
    </Dialog>
  );
}

/** ‹ or › at mid-height, to the image before or after. */
function StepButton({ side, disabled, onClick }: { side: "start" | "end"; disabled: boolean; onClick: () => void }) {
  const Icon = side === "start" ? ChevronLeft : ChevronRight;
  const label = side === "start" ? "Previous image" : "Next image";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cx(roundButton, "absolute top-1/2 z-10 -translate-y-1/2", side === "start" ? "left-3" : "right-3")}
    >
      <Icon className="size-icon-md rtl:rotate-180" />
    </button>
  );
}

/** The shown image's zoom keys (+ − 0): `press` says whether it took the key. */
type ZoomKeys = { press: (key: string) => boolean };

/** The image is centred when it fits; its overflow is panned by dragging. */
function ShownImage({
  image,
  size,
  morph,
  imageRef,
  zoomKeys,
  onBackdrop,
  count,
}: {
  image: ViewerImage;
  /** Its picture size when already known (from its thumbnail). */
  size: Size | null;
  morph: boolean;
  imageRef: { current: HTMLImageElement | null } | undefined;
  zoomKeys: Ref<ZoomKeys>;
  onBackdrop: () => void;
  count: string | null;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<Size | null>(size);
  const [room, setRoom] = useState({ width: innerWidth - 128, height: innerHeight - 240 });
  const [scale, setScale] = useState<number | null>(null);
  const fit = natural ? Math.min(1, room.width / natural.width, room.height / natural.height) : 1;
  const current = scale ?? fit;
  const anchor = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  const [panning, setPanning] = useState(false);
  const viewWidth = natural ? natural.width * fit : room.width;
  const viewHeight = natural ? natural.height * fit : room.height;
  const canPan = !!natural && current > fit;
  useEffect(() => {
    const resize = () => setRoom({ width: Math.max(1, innerWidth - 128), height: Math.max(1, innerHeight - 240) });
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const zoomTo = (next: number, x?: number, y?: number) => {
    const box = frame.current;
    if (!box || !natural) return;
    next = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
    const bounds = box.getBoundingClientRect();
    const px = x === undefined ? box.clientWidth / 2 : x - bounds.left;
    const py = y === undefined ? box.clientHeight / 2 : y - bounds.top;
    anchor.current = {
      x: (box.scrollLeft + px - Math.max(0, (box.clientWidth - natural.width * current) / 2)) / current,
      y: (box.scrollTop + py - Math.max(0, (box.clientHeight - natural.height * current) / 2)) / current,
      left: px,
      top: py,
    };
    setScale(next);
  };
  useLayoutEffect(() => {
    const box = frame.current;
    const point = anchor.current;
    if (!box || !natural || !point) return;
    box.scrollLeft = point.x * current + Math.max(0, (box.clientWidth - natural.width * current) / 2) - point.left;
    box.scrollTop = point.y * current + Math.max(0, (box.clientHeight - natural.height * current) / 2) - point.top;
    anchor.current = null;
  }, [current, natural]);
  const stepZoom = (by: number) => {
    const ramp = [...RAMP, Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fit))].toSorted((a, b) => a - b);
    zoomTo(by > 0 ? (ramp.find((value) => value > current + 0.00001) ?? ZOOM_MAX) : (ramp.findLast((value) => value < current - 0.00001) ?? ZOOM_MIN));
  };
  useImperativeHandle(zoomKeys, () => ({
    press: (key) => {
      if (key === "+" || key === "=") stepZoom(1);
      else if (key === "-") stepZoom(-1);
      else if (key === "0") {
        anchor.current = null;
        setScale(null);
        if (frame.current) {
          frame.current.scrollLeft = 0;
          frame.current.scrollTop = 0;
        }
      } else return false;
      return true;
    },
  }));
  // A native non-passive listener also suppresses the webview's own pinch/page zoom.
  const wheelZoom = useEffectEvent((event: globalThis.WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1);
    zoomTo(current * Math.exp(-delta / 200), event.clientX, event.clientY);
  });
  useEffect(() => {
    const box = frame.current;
    const wheel = (event: globalThis.WheelEvent) => wheelZoom(event);
    box?.addEventListener("wheel", wheel, { passive: false });
    return () => box?.removeEventListener("wheel", wheel);
  }, []);
  // Laid out at its zoomed size once its picture size is known, else held to the room.
  const zoomed = natural ? { "data-width": natural.width * current, "data-height": natural.height * current } : {};
  return (
    <>
      <div className="absolute top-3 right-3 z-10 flex gap-2">
        <button type="button" aria-label="Download image" title="Download image" className={roundButton} onClick={() => void downloadImage(image)}>
          <Download className="size-icon-md" />
        </button>
        <DialogClose aria-label="Close image preview" title="Close image preview" className={roundButton}>
          <X className="size-icon-md" />
        </DialogClose>
      </div>
      {/* Esc and the close button give keyboard dismissal. */}
      <div
        ref={frame}
        data-slot="image-preview-frame"
        tabIndex={-1}
        data-width={viewWidth}
        data-height={viewHeight}
        className={cx("min-h-0 shrink-0 touch-none overflow-hidden outline-none select-none image-viewer-size", canPan && (panning ? "cursor-grabbing" : "cursor-grab"))}
        onClick={(event) => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          if (event.target === event.currentTarget || (event.target instanceof HTMLElement && event.target.dataset.slot === "image-preview-canvas")) onBackdrop();
        }}
        onPointerDown={(event) => {
          if (!canPan || event.button !== 0) return;
          const box = event.currentTarget;
          box.setPointerCapture(event.pointerId);
          drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop, moved: false };
          setPanning(true);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start || start.id !== event.pointerId) return;
          start.moved ||= Math.hypot(event.clientX - start.x, event.clientY - start.y) > 3;
          event.currentTarget.scrollLeft = start.left - (event.clientX - start.x);
          event.currentTarget.scrollTop = start.top - (event.clientY - start.y);
        }}
        onPointerUp={(event) => {
          if (!drag.current || drag.current.id !== event.pointerId) return;
          suppressClick.current = drag.current.moved;
          drag.current = null;
          setPanning(false);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
          setPanning(false);
        }}
      >
        <div data-slot="image-preview-canvas" {...zoomed} className="flex min-h-full min-w-full items-center justify-center image-viewer-size">
          <ImageContextMenu image={image}>
            <img
              ref={(element) => {
                if (imageRef) imageRef.current = element;
              }}
              src={image.url}
              alt={image.name}
              draggable={false}
              onLoad={(event) => setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
              {...(natural ? zoomed : { "data-max-height": room.height })}
              data-image-morph={morph || undefined}
              className={cx("shrink-0 rounded-image-viewer object-contain image-viewer-size", natural ? "max-w-none" : "max-w-full")}
            />
          </ImageContextMenu>
        </div>
      </div>
      <div data-slot="image-preview-controls" className="mt-5 flex flex-col items-center gap-3 text-foreground">
        <div data-slot="image-preview-zoom" className="flex items-center gap-1 rounded-capsule bg-fill-hover p-1">
          <button type="button" aria-label="Zoom out image" title="Zoom out image" disabled={current <= ZOOM_MIN} onClick={() => stepZoom(-1)} className={zoomButton}>
            <Minus className="size-icon-md" />
          </button>
          <span data-slot="image-preview-scale" aria-live="polite" className="min-w-16 text-center text-sm tabular-nums">
            {percentage.format(current)}
          </span>
          <button type="button" aria-label="Zoom in image" title="Zoom in image" disabled={current >= ZOOM_MAX} onClick={() => stepZoom(1)} className={zoomButton}>
            <Plus className="size-icon-md" />
          </button>
        </div>
        {count && (
          <span data-slot="image-preview-count" className="text-sm tabular-nums">
            {count}
          </span>
        )}
      </div>
    </>
  );
}
