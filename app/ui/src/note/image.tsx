import { $isCodeNode } from "@lexical/code-core";
import type { TextMatchTransformer } from "@lexical/markdown";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { DRAG_DROP_PASTE } from "@lexical/rich-text";
import { $findMatchingParent, mergeRegister } from "@lexical/utils";
import {
  $createParagraphNode,
  $getNodeByKey,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  DecoratorNode,
  type LexicalEditor,
  type NodeKey,
  PASTE_COMMAND,
  type SerializedLexicalNode,
  type Spread,
} from "lexical";
import { createContext, type DragEvent, type ReactNode, type RefObject, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { ImageContextMenu, ImagePreview } from "../components/image-viewer";
import { showToast } from "../components/toast";
import { Spinner } from "../icons";
import { daemonSource, openFolders } from "../projects/store";
import { failure } from "../session/composer";
import { base64, dropped } from "../session/files";
import { $ensureCaret, PICK_IMAGE_COMMAND } from "./blocks";
import type { useNoteRun } from "./run";

type Run = ReturnType<typeof useNoteRun>;

/** The note an editor shows, whose images it draws and adds to. */
export const NoteOfEditor = createContext<{ note: string; run: Run } | null>(null);

/** An image in a note's Markdown, `![alt](<note>.images/<path>)`: `path` as written, in `<>` where it holds spaces, `title` with its space and quotes. */
type Picture = { note: string; path: string; alt: string; title: string };
type SerializedImageNode = Spread<Picture, SerializedLexicalNode>;

const decoded = (path: string) => {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};
const written = ({ note, path, alt, title }: Picture) => {
  const to = `${note}.images/${path}`;
  return `![${alt.replace(/[\\[\]]/g, "\\$&")}](${/[\s()]/.test(path) ? `<${to}>` : to}${title})`;
};

/** An image where it sits in the note's text, in a line, a list or a table cell. */
export class ImageNode extends DecoratorNode<ReactNode> {
  __picture: Picture;
  /** Came from a clipboard: another note's is copied into this one. */
  __pasted: boolean;

  static getType(): string {
    return "note-image";
  }
  static clone(node: ImageNode): ImageNode {
    return new ImageNode(node.__picture, node.__pasted, node.__key);
  }
  static importJSON({ note, path, alt, title }: SerializedImageNode): ImageNode {
    return new ImageNode({ note, path, alt, title }, true);
  }
  constructor(picture: Picture, pasted = false, key?: NodeKey) {
    super(key);
    this.__picture = picture;
    this.__pasted = pasted;
  }
  exportJSON(): SerializedImageNode {
    return { ...super.exportJSON(), ...this.__picture };
  }
  createDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "note-image";
    return span;
  }
  updateDOM(): false {
    return false;
  }
  isInline(): true {
    return true;
  }
  // The caret steps over it and Backspace takes it at once, rather than selecting it first.
  isKeyboardSelectable(): false {
    return false;
  }
  getTextContent(): string {
    return written(this.__picture);
  }
  getPicture(): Picture {
    return this.getLatest().__picture;
  }
  setPicture(picture: Picture): void {
    this.getWritable().__picture = picture;
  }
  decorate(): ReactNode {
    return <NoteImage picture={this.__picture} nodeKey={this.__key} />;
  }
}

/** The form Rust reads too (crates/core/src/message/notes.rs). */
const NOTE = /(?:\.\/)?([A-Za-z0-9_][A-Za-z0-9_-]{0,127})\.images\//.source;
const KIND = /\.(?:png|jpe?g|gif|webp)/.source;
const FORM = new RegExp(`(?<!\\\\)!\\[((?:\\\\.|[^[\\]\\\\])*)\\]\\((?:${NOTE}([^()<>.\\s/\\\\][^()\\s/\\\\]*${KIND})|<${NOTE}([^.<>/\\\\][^<>/\\\\]*${KIND})>)(\\s+"[^"()]*")?\\)`, "i");

export const IMAGE: TextMatchTransformer = {
  dependencies: [ImageNode],
  export: (node) => (node instanceof ImageNode ? written(node.getPicture()) : null),
  importRegExp: FORM,
  regExp: new RegExp(`${FORM.source}$`, "i"),
  replace: (text, [, alt = "", plain, plainPath, angled = "", angledPath = "", title = ""]) => {
    text.replace(new ImageNode({ note: plain ?? angled, path: plainPath ?? angledPath, title, alt: alt.replace(/\\([^\w\s])/g, "$1") }));
  },
  trigger: ")",
  type: "text-match",
};

/** Images on their way into a note's folder, or that didn't get there; `preview` shows one meanwhile. */
type Adding = { preview?: string; error?: string; again?: () => void };
const adding = new Map<string, Adding>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => (listeners.add(listener), () => void listeners.delete(listener));
const keyOf = (note: string, path: string) => `${note}/${path}`;
function setAdding(key: string, to: Adding | null): void {
  if (to) adding.set(key, to);
  else adding.delete(key);
  for (const listener of listeners) listener();
}

async function add(run: Run, note: string, path: string, from: () => Promise<string[]>, preview?: string): Promise<void> {
  const key = keyOf(note, path);
  setAdding(key, { preview });
  const error = await from()
    .then((args) => run(["image", note, path, ...args]))
    .then((reply) => (reply.ok ? null : failure(reply)), String);
  if (error !== null) return setAdding(key, { preview, error, again: () => void add(run, note, path, from, preview) });
  setAdding(key, null);
  if (preview) URL.revokeObjectURL(preview);
}

/** A name of its own in the note's folder, after the file's, plain in a path and in Markdown. */
const nameFor = (name: string, extension: string) =>
  `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image"}-${crypto.randomUUID().slice(0, 8)}.${extension}`;

const KINDS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** Puts `files`' images where the caret is, each kept in the note's folder behind it. Call inside an update. */
function $addImages(run: Run, note: string, files: File[]): void {
  const images = files.filter((file) => file.type in KINDS);
  if (images.length < files.length) showToast("Notes take PNG, JPEG, GIF and WebP images.", { tone: "error" });
  if (images.length === 0) return;
  $ensureCaret();
  const selection = $getSelection();
  // Code holds text only: after it.
  const code = $isRangeSelection(selection) ? $findMatchingParent(selection.anchor.getNode(), $isCodeNode) : null;
  if (code) {
    const line = $createParagraphNode();
    code.insertAfter(line);
    line.select();
  }
  $insertNodes(
    images.map((file) => {
      const stem = (file.name || "Pasted image").replace(/\.[^.]*$/, "");
      const path = nameFor(stem, KINDS[file.type]!);
      const onDisk = window.brigadier?.pathForFile(file) ?? "";
      const from = async () => (onDisk ? ["--path", onDisk] : ["--data", base64(await file.arrayBuffer())]);
      // Out of the editor's update: what shows it changes there.
      queueMicrotask(() => void add(run, note, path, from, URL.createObjectURL(file)));
      return new ImageNode({ note, path, alt: stem, title: "" });
    }),
  );
}

/** Pasted, dropped and picked images, and those copied here from another note. */
export function ImagePlugin() {
  const [editor] = useLexicalComposerContext();
  const own = useContext(NoteOfEditor);
  const input = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!own) return;
    const { note, run } = own;
    return mergeRegister(
      editor.registerCommand(DRAG_DROP_PASTE, (files) => ($addImages(run, note, files), true), COMMAND_PRIORITY_LOW),
      // A picture copied in a browser has HTML with it, a file copied in Finder its name; words with a picture of them stay words.
      editor.registerCommand(
        PASTE_COMMAND,
        (event) => {
          const data = event instanceof ClipboardEvent ? event.clipboardData : null;
          const files = [...(data?.files ?? [])];
          if (!data || files.length === 0 || data.types.includes("application/x-lexical-editor")) return false;
          if (data.getData("text/plain") && !files.some((file) => window.brigadier?.pathForFile(file))) return false;
          event.preventDefault();
          $addImages(run, note, files);
          return true;
        },
        COMMAND_PRIORITY_LOW,
      ),
      editor.registerCommand(PICK_IMAGE_COMMAND, () => (input.current?.click(), true), COMMAND_PRIORITY_LOW),
      editor.registerNodeTransform(ImageNode, (node) => {
        const was = node.getPicture();
        if (!node.getLatest().__pasted || was.note === note) return;
        const at = was.path.lastIndexOf(".");
        const path = nameFor(decoded(was.path.slice(0, at)).replace(/-[0-9a-f]{8}$/, ""), was.path.slice(at + 1));
        node.setPicture({ ...was, note, path });
        queueMicrotask(() => void add(run, note, path, async () => ["--from", `${was.note}/${decoded(was.path)}`]));
      }),
    );
  }, [editor, own]);
  return (
    <input
      ref={input}
      type="file"
      accept={Object.keys(KINDS).join(",")}
      multiple
      hidden
      onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = "";
        if (files.length > 0) editor.dispatchCommand(DRAG_DROP_PASTE, files);
        editor.focus();
      }}
    />
  );
}

/** Files dropped on a note: its editor takes images where they fall, its empty parts at its end; a folder adds a project, as on the rest of the window [D2018]. */
export function noteDrop(editor: RefObject<LexicalEditor | null>) {
  const carries = (event: DragEvent) => event.dataTransfer.types.includes("Files");
  return {
    "data-drop": "attach",
    onDragOver: (event: DragEvent) => {
      if (!carries(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDropCapture: (event: DragEvent) => {
      if (!carries(event)) return;
      const folders: string[] = [];
      let files = 0;
      dropped(event, (path) => folders.push(path), () => (files += 1));
      if (folders.length > 0) void openFolders(daemonSource, folders);
      if (files > 0) return;
      event.preventDefault();
      event.stopPropagation();
    },
    onDrop: (event: DragEvent) => {
      if (!carries(event) || event.defaultPrevented) return;
      event.preventDefault();
      const files = [...event.dataTransfer.files];
      editor.current?.update(() => {
        $getRoot().selectEnd();
        editor.current?.dispatchCommand(DRAG_DROP_PASTE, files);
      });
    },
  };
}

function NoteImage({ picture, nodeKey }: { picture: Picture; nodeKey: NodeKey }) {
  const [editor] = useLexicalComposerContext();
  const note = useContext(NoteOfEditor)?.note;
  const state = useSyncExternalStore(subscribe, () => adding.get(keyOf(picture.note, picture.path)));
  const url = state?.preview ?? `/note-image/${picture.note}/${encodeURIComponent(decoded(picture.path))}`;
  // The address that didn't load, so the next one is tried.
  const [lost, setLost] = useState<string | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  // Saved, or tried again: what didn't load before may now.
  useEffect(() => setLost(null), [state]);
  const saving = state && (!state.preview || lost === url);
  const broken = picture.note !== note || lost === url;
  const shown = !state?.error && !saving && !broken;
  // Its own keys, before the editor takes them as typing: Enter and Space open it, Backspace and Delete take it out.
  useEffect(() => {
    const element = button.current;
    const keys = (event: KeyboardEvent) => {
      const out = event.key === "Backspace" || event.key === "Delete";
      if (!out && event.key !== "Enter" && event.key !== " ") return;
      event.stopPropagation();
      if (!out) return;
      event.preventDefault();
      editor.update(() => {
        const node = $getNodeByKey(nodeKey);
        node?.selectNext(0, 0);
        node?.remove();
      });
      editor.focus();
    };
    element?.addEventListener("keydown", keys);
    return () => element?.removeEventListener("keydown", keys);
  }, [editor, nodeKey, shown]);
  if (state?.error) {
    return (
      <span className="note-image-line">
        <ErrorLine error={`“${picture.alt || "Image"}” isn't saved: ${state.error}`} actions={<Button size="sm" variant="ghost" onClick={state.again}>Try again</Button>} />
      </span>
    );
  }
  // Nothing to show of it yet: one copied from another note.
  if (saving) return <span className="note-image-line"><Spinner aria-label={`Saving ${picture.alt || "image"}`} className="size-icon-md motion-safe:animate-spin" /></span>;
  // Another note's and the web's are never read; one of this note's may be gone.
  if (broken) return <span className="note-image-line">{picture.alt ? `“${picture.alt}” isn't in this note.` : "This image isn't in this note."}</span>;
  const name = picture.alt || "Image";
  return (
    <ImagePreview url={url} name={name}>
      <ImageContextMenu image={{ name, url }}>
        <button ref={button} type="button" aria-label={`Open ${name}`} aria-busy={state !== undefined} className="note-image-button">
          <img src={url} alt={picture.alt} draggable={false} className="note-image-picture" onError={() => setLost(url)} />
          {state && <Spinner aria-label="Saving" className="note-image-saving" />}
        </button>
      </ImageContextMenu>
    </ImagePreview>
  );
}
