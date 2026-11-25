import { type DragEvent, type ReactNode, type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { type Attachment, AttachmentsContext, AttachmentTiles } from "../components/composer/attachments";
import type { Chip, Draft } from "../components/composer/draft";
import type { ComposerFieldHandle } from "../components/composer/field";
import type { Mentions } from "../components/composer/menus";
import { viewImage } from "../components/image-viewer";
import { ask } from "../daemon";
import { Paperclip } from "../icons";
import { daemonSource, openFolders } from "../projects/store";
import { openAttachment } from "../shell/tab-store";
import { giveChipTabs } from "../browser/give";
import type { SentFile } from "../thread/item";
import type { Runner } from "./composer";
import { HOME_DRAFT } from "./draft";

/*
 * The composer's files: each gets its id here and is shown at once, while Rust stores it under its session's folder
 * (Home's in its draft folder) and checks it against the app's and the agent's limits; it settles by that id, failed
 * with Rust's reason [D30, D127, D487, D492, D2022 #14]. Kept per owner while the app runs, so a switch keeps them.
 */
type Files = { all: Map<string, Attachment>; tiles: string[] };
const owners = new Map<string, Files>();
const listeners = new Set<() => void>();
const NONE: Files = { all: new Map(), tiles: [] };
const filesOf = (owner: string) => owners.get(owner) ?? NONE;
function change(owner: string, next: (files: Files) => Files): void {
  owners.set(owner, next(filesOf(owner)));
  listeners.forEach((listener) => listener());
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Its thumbnail, from main's `app:` handler, which serves only that owner's own folders [D127]. */
/** Where an attachment of `owner` (a session, or Home's draft) is served. */
export const urlOf = (owner: string, id: string) => `/attachment/${owner === HOME_DRAFT ? "home" : owner}/${id}`;
const set = (owner: string, id: string, attachment: Attachment) => change(owner, (files) => ({ ...files, all: new Map(files.all).set(id, attachment) }));

export const dropTiles = (draft: string) => change(draft, (now) => ({ ...now, tiles: [] }));

/** Drops the tiles of a session's question cards that no longer wait, its other drafts' kept. */
export function forgetTiles(session: string, keep: ReadonlySet<string>): void {
  for (const draft of owners.keys()) if (draft.startsWith(`${session}\n`) && !keep.has(draft.split("\n")[1]!)) owners.delete(draft);
}

/** `draft`'s files as Rust keeps a sent message's, and its words as Rust's row shows them, `from` images before its first. */
export function saidDraft(owner: string, draft: Draft, from: number): { text: string; files: SentFile[]; images: number } {
  const all = filesOf(owner).all;
  let n = from;
  const image = () => `[Image #${++n}]`;
  let text = draft.parts.map((part) => (typeof part === "string" ? part : part.kind === "image" ? image() : "label" in part ? part.label : (part.preview ?? ""))).join("");
  const tiles = draft.attachmentIds.flatMap((id) => all.get(id) ?? []);
  const isImage = (each: Attachment) => each.mime.startsWith("image/");
  for (const each of [...tiles.filter(isImage), ...tiles.filter((one) => !isImage(one))]) text += `${text && !/\s$/.test(text) ? " " : ""}${isImage(each) ? image() : `[${each.name}]`}`;
  const ids = [...draft.parts.flatMap((part) => (typeof part !== "string" && "attachmentId" in part ? [part.attachmentId] : [])), ...draft.attachmentIds];
  return { text, images: n, files: [...new Set(ids)].flatMap((id) => all.get(id) ?? []).map(({ id, name, mime }) => ({ id, name, mime, bytes: 0, pasted: mime === "text/plain" && !draft.attachmentIds.includes(id) })) };
}

/** A file put in `owner`'s folder from elsewhere (a PR's Fix [D174]), known to its composer if that has listed them. */
export const stored = (owner: string, id: string, name: string) => owners.has(owner) && set(owner, id, { id, name, mime: "text/plain", state: "ready", url: urlOf(owner, id) });

export const base64 = (buffer: ArrayBuffer) => {
  const bytes = new Uint8Array(buffer);
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
};

/** Hands `file` to Rust; a file on disk goes by its path, so a too-large one is never read whole here. */
async function store(run: Runner, owner: string, id: string, file: File, backend: string | undefined) {
  const path = window.brigadier?.pathForFile(file) ?? "";
  const from = path ? ["--path", path] : ["--data", base64(await file.arrayBuffer())];
  return run(["attach", owner, "add", id, file.name || "Pasted image.png", ...(backend ? ["--backend", backend] : []), ...from]);
}

/** The draft as Rust takes it, when it holds more than words; none for plain text [D109]. */
export function payload(parts: Draft["parts"], tiles: readonly string[]): string | undefined {
  return parts.some((part) => typeof part !== "string") || tiles.length > 0 ? JSON.stringify({ parts, attachmentIds: tiles }) : undefined;
}

/** A folder dropped in the composer, as an @folder mention [D2018]. */
const folderChip = (path: string): Chip => ({ kind: "mention", id: path, type: "folder", label: path });

/**
 * One composer's files, mentions and drops, for `owner` (a session's id, or Home's draft): the field's attachments,
 * the tiles over it, the `@` menu's search, and why Send waits (a file still being stored, or an image the model
 * can't take) [D127, D388, D2010, D2022 #14].
 */
export function useComposerFiles({ owner, draft = owner, run, field, backend, project, images = true, onTiles, main = true }: { owner: string; /** Whose tiles: each of Home's drafts has its own, their files all Home's. */ draft?: string; run: Runner; field: RefObject<ComposerFieldHandle | null>; backend?: string; project?: string | null; images?: boolean; /** The tiles changed: the draft keeps them. */ onTiles?: (tiles: string[]) => void; /** False for a question card's: drops on the thread stay the composer's. */ main?: boolean }) {
  const { all } = useSyncExternalStore(subscribe, () => filesOf(owner));
  const { tiles: shownTiles } = useSyncExternalStore(subscribe, () => filesOf(draft));
  const files = { all, tiles: shownTiles };
  const shown = useRef(files.tiles);
  useEffect(() => {
    if (shown.current === files.tiles) return;
    shown.current = files.tiles;
    onTiles?.(files.tiles);
  }, [files.tiles]);
  const [results, setResults] = useState<Mentions["results"]>(null);
  const asked = useRef<string | null>(null);
  // After a restart, the draft's files come back from Rust's folder, by their ids.
  const load = () =>
    void run(["attach", owner, "list"]).then((reply) => {
      for (const each of reply.files ?? []) if (!filesOf(owner).all.has(each.id)) set(owner, each.id, { id: each.id, name: each.name, mime: each.mime, state: "ready", url: urlOf(owner, each.id) });
    });
  useEffect(() => {
    if (!owners.has(owner)) load();
  }, [owner]);

  const attach = (id: string, file: File, inText: boolean) => {
    const mime = file.type || "application/octet-stream";
    set(owner, id, { id, name: file.name || "Pasted image.png", mime, state: "uploading" });
    if (!inText) change(draft, (now) => ({ ...now, tiles: [...now.tiles, id] }));
    void store(run, owner, id, file, backend).then((reply) => {
      const name = file.name || "Pasted image.png";
      if (reply.ok) return set(owner, id, { id, name, mime, state: "ready", url: urlOf(owner, id) });
      set(owner, id, { id, name, mime, state: "failed", error: String(reply.message ?? reply.error ?? "Couldn't attach this file") });
      // A failed image or paste in the text shows as a tile too, saying why.
      if (inText) change(draft, (now) => ({ ...now, tiles: now.tiles.includes(id) ? now.tiles : [...now.tiles, id] }));
    });
  };
  const remove = (id: string) => {
    change(draft, (now) => ({ ...now, tiles: now.tiles.filter((each) => each !== id) }));
    void run(["attach", owner, "remove", id]);
  };
  /** After a send: the tiles leave with the message; its files are the session's now, and each tab its chips name is its agent's [D775]. */
  const sent = (parts: Draft["parts"] = []) => {
    dropTiles(draft);
    if (owner !== HOME_DRAFT) giveChipTabs(owner, parts);
  };
  /** Tiles back with what's there now, anything added meanwhile kept; files this view hasn't listed yet are read again. */
  const restore = (tiles: readonly string[]) => {
    change(draft, (now) => ({ ...now, tiles: [...new Set([...tiles, ...now.tiles])] }));
    if (tiles.some((id) => !filesOf(owner).all.has(id))) load();
  };
  const ready = (ids: readonly string[]) => ids.filter((id) => files.all.get(id)?.state !== "failed");
  /** The message's files that went, the failed ones left out. */
  const tiles = () => ready(files.tiles);

  const mentions: Mentions = {
    results,
    onQuery: (query) => {
      asked.current = query;
      if (query === null) return setResults(null);
      ask({ op: "mention", owner, tabs: draft, q: query, ...(project ? { project } : {}) }, (reply) => {
        // An older query's answer drops: only the one asked last shows [D127].
        if (reply.ok && reply.query === asked.current) setResults({ query: reply.query, groups: reply.groups });
      });
    },
  };

  /** Why Send waits now, in the old app's words; none when it can go. */
  const hold = (parts: Draft["parts"]) => {
    const ids = [...parts.flatMap((part) => (typeof part !== "string" && "attachmentId" in part ? [part.attachmentId] : [])), ...files.tiles];
    if (ids.some((id) => files.all.get(id)?.state === "uploading")) return "Files uploading…";
    const image = ids.some((id) => files.all.get(id)?.mime.startsWith("image/") && files.all.get(id)?.state === "ready");
    if (image && !images) return "This model does not support image inputs. Try a different model";
    return undefined;
  };

  /** Files dropped on the composer attach; a folder becomes an @folder mention [D2004, D2018]. */
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    dropped(event, (folder) => insert(field, folderChip(folder)), attach);
  };
  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };

  const tilesRow = (
    <AttachmentsContext value={files.all}>
      <AttachmentTiles ids={files.tiles} onRemove={remove} onOpen={(file) => (file.mime.startsWith("image/") ? viewImage([{ name: file.name, url: file.url! }], 0) : openAttachment(owner, file.id, file.name))} />
    </AttachmentsContext>
  );
  if (main) {
    attachers.set(owner, attach);
    fields.set(owner, field);
  }
  return { attachments: files.all, tileIds: files.tiles, tiles, attach, sent, restore, mentions, hold, onDrop, onDragOver, tilesRow };
}

/** What a drop holds: each folder by its path, each file to attach. */
export function dropped(event: DragEvent, onFolder: (path: string) => void, attach: (id: string, file: File, inText: boolean) => void): void {
  const items = [...event.dataTransfer.items];
  [...event.dataTransfer.files].forEach((file, at) => {
    const path = window.brigadier?.pathForFile(file) ?? "";
    if (items[at]?.webkitGetAsEntry()?.isDirectory && path) onFolder(path);
    else attach(crypto.randomUUID(), file, false);
  });
}

/** A chip at the end of the text, a space each side, as the + menu adds one. */
function insert(field: RefObject<ComposerFieldHandle | null>, chip: Chip): void {
  const now = field.current;
  if (!now) return;
  const parts = now.parts();
  const last = parts.at(-1);
  const apart = last !== undefined && !(typeof last === "string" && /\s$/.test(last));
  now.set([...parts, ...(apart ? [" "] : []), chip, " "]);
}

/** Each open composer's attach, so a drop on its thread reaches it, and its field, for the summary card's Sources + [D155]. */
const attachers = new Map<string, (id: string, file: File, inText: boolean) => void>();
const fields = new Map<string, RefObject<ComposerFieldHandle | null>>();
export const chipInto = (owner: string, chip: Chip) => insert(fields.get(owner) ?? { current: null }, chip);
export const attachInto = (owner: string, files: File[]) => files.forEach((file) => attachers.get(owner)?.(crypto.randomUUID(), file, false));

/**
 * Files dropped on session `owner`'s thread attach to its composer; a folder there adds a project, as on the rest of the
 * window [D2004, D2018]. While files are dragged over it, the old app's "Drop to attach" tint and pill.
 */
export function ThreadDrop({ owner, children }: { owner: string; children: ReactNode }) {
  const [dragging, setDragging] = useState(false);
  const attach = (id: string, file: File, inText: boolean) => attachers.get(owner)?.(id, file, inText);
  const files = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  return (
    <div
      className="relative min-h-0 flex-1"
      data-drop="attach"
      onDragOver={(event) => {
        if (!files(event)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(event) => {
        setDragging(false);
        if (!files(event)) return;
        event.preventDefault();
        event.stopPropagation();
        const folders: string[] = [];
        dropped(event, (path) => folders.push(path), attach);
        if (folders.length > 0) void openFolders(daemonSource, folders);
      }}
    >
      {children}
      {dragging && (
        <div aria-hidden data-slot="drop-overlay" className="pointer-events-none absolute inset-0 z-30 flex animate-fade-in items-center justify-center bg-drop-tint">
          <div data-slot="drop-pill" className="flex items-center gap-1.5 rounded-capsule bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-sm">
            <Paperclip className="size-icon-sm text-muted-foreground" />
            Drop to attach
          </div>
        </div>
      )}
    </div>
  );
}
