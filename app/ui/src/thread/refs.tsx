import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from "react";

import { SessionOfThread } from "../accounts/limit";
import { ChipContext, ComposerChip, type OpenKind } from "../components/composer/chip";
import type { Chip } from "../components/composer/draft";
import { ask, useDaemon, useFolderChat } from "../daemon";
import { STATE_WORDS } from "../landing/pr-words";
import { openPr } from "../panel/open";
import { PR_LOOK } from "../panel/source/rows";
import { PrHoverCard } from "../pull-requests/hover-card";
import { pastedRef } from "../pull-requests/route";
import type { Pr } from "../panel/types";
import { openChip, useListedCommands } from "../session/commands";
import { daemonRun } from "../session/composer";
import { openFile } from "../shell/tab-store";
import { File } from "../icons";
import { viewImage } from "../components/image-viewer";
import { showToast } from "../components/toast";
import { urlOf } from "../session/files";

const SEG = String.raw`\.?[\w@-]+(?:\.[\w@-]+)*`;
/**
 * A word an answer may name, in its text or as a whole inline code: a PR (#12), a session's id, a path (`/abs/a.ts`,
 * `src/a.ts:12`, `docs/`), a `/` command or skill, a file's bare name (README.md).
 */
const WORD = new RegExp(
  String.raw`(?<![\w/#.:@-])(#\d+|s(?:-[a-z0-9]+){2}|\/?(?:${SEG}\/)+(?:${SEG})?(?::\d+){0,2}|\/\w[\w:-]*(?:\.[\w-]+)*|[\w@-]+(?:\.[\w@-]+)+(?::\d+){0,2})(?![\w/@-])`,
  "g",
);
const LINE = /((?::\d+){1,2})$/;
const pathish = (word: string) => !word.startsWith("#") && (word.includes(".") || word.slice(1).includes("/"));

/**
 * Splits an answer's text into its words that may be refs, each a `span` with `data-ref`, which `RefWord` draws as a
 * chip when the session knows it, else as the word. Each piece keeps its place in the source, so it still fades in.
 */
export const remarkRefs = () => (tree: MdNode) => {
  const walk = (node: MdNode) => {
    node.children = node.children?.flatMap((child): MdNode[] => {
      if (SKIP.has(child.type)) return [child];
      if (child.type !== "text") return (walk(child), [child]);
      const value = child.value ?? "";
      const base = (child.position?.end.offset ?? value.length) - value.length;
      const piece = (from: number, to: number): MdNode => ({ type: "text", value: value.slice(from, to), position: { start: { offset: base + from }, end: { offset: base + to } } });
      const out: MdNode[] = [];
      let done = 0;
      for (const match of value.matchAll(WORD)) {
        const [from, to] = [match.index, match.index + match[0].length];
        if (from > done) out.push(piece(done, from));
        out.push({ type: "ref", data: { hName: "span", hProperties: { dataRef: match[0] } }, children: [piece(from, to)] });
        done = to;
      }
      if (!out.length) return [child];
      if (done < value.length) out.push(piece(done, value.length));
      return out;
    });
  };
  walk(tree);
};
type MdNode = { type: string; value?: string; position?: { start: { offset?: number }; end: { offset?: number } }; children?: MdNode[]; data?: object };
const SKIP = new Set(["link", "linkReference", "inlineCode", "code", "html"]);

type Hit = { path: string; at: string; folder: boolean; image: boolean; outside?: boolean };
type Found = Record<string, Hit>;
const RefsContext = createContext<((word: string, label?: ReactNode) => ReactNode) | null>(null);

/** A link's target as a path: `file:///a%20b.png` is `/a b.png`. */
export const linkPath = (href: string) => {
  const path = href.replace(/^file:\/\//i, "");
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
};
/** Markdown links' targets, which may be paths WORD can't take whole (`~/a.png`, spaces): `<…>` whole, else to a space. */
const LINK = /\]\((?:<([^>\n]+)>|([^)\s]+))/g;

/**
 * A file link's click, the same in a lead's thread and a worker's [D290]: an image, wherever it is, in the viewer;
 * any other file or folder outside the checkout in Finder; one in it in a preview tab.
 */
function openHit(owner: string, hit: Hit, line?: string) {
  const failed = (reply: Record<string, any>) => !reply.ok && showToast(String(reply.error ?? `Couldn't open ${hit.path}`), { tone: "error" });
  if (hit.image) {
    return void daemonRun(["attach", owner, "view", hit.at]).then((reply) =>
      reply.ok ? viewImage([{ name: hit.at.split("/").pop() ?? "Image", url: urlOf(owner, reply.id) }], 0) : failed(reply),
    );
  }
  if (hit.outside) return void daemonRun(["attach", owner, "reveal", hit.at]).then(failed);
  openFile(owner, hit.path, { line: line ? Number(line) : undefined, preview: true });
}

/**
 * An answer's refs: the files and folders its words name in the session's checkout (Rust's, asked once it's whole), its
 * PRs from the card's list, its sessions, its `/` commands and skills as the composer lists them. A file draws as a link
 * [D113]; the rest as the composer's chip; anything the session doesn't know stays text [D251].
 */
export function AnswerRefs({ text, done, children }: { text: string; done: boolean; children: ReactNode }) {
  const owner = useContext(SessionOfThread)?.id;
  const rows = useDaemon().rows;
  const listed = useListedCommands(owner);
  const [found, setFound] = useState<Found>({});
  useEffect(() => {
    if (!owner || !done) return;
    const links = [...text.matchAll(LINK)].map((match) => linkPath((match[1] ?? match[2])!));
    const paths = [...new Set([...[...text.matchAll(WORD)].map((match) => match[0]), ...links].map((word) => word.replace(LINE, "")).filter(pathish))].slice(0, 200);
    if (!paths.length) return;
    let live = true;
    ask({ op: "paths", owner, paths }, (reply) => live && reply.ok && setFound(reply.found));
    return () => {
      live = false;
    };
  }, [owner, text, done]);
  // A folder chat's bare number names no repository.
  const prs = useFolderChat(owner) ? undefined : rows?.find((row) => row.id === owner)?.prs?.prs;
  const value = useMemo(() => {
    if (!owner) return null;
    const commands = new Map((listed ?? []).map((command) => [command.id, command]));
    const open = (kind: OpenKind, id: string, name?: string) => openChip(owner, kind, id, commands.get(id), daemonRun, name);
    const chip = (each: Chip) => (
      <ChipContext value={{ onOpen: open, commands }}>
        <ComposerChip chip={each} />
      </ChipContext>
    );
    return (word: string, label?: ReactNode): ReactNode => {
      if (/^#\d+$/.test(word)) {
        const hits = prs?.filter((pr) => pr.number === Number(word.slice(1))) ?? [];
        return hits.length === 1 ? <PrRef owner={owner} pr={hits[0]!} /> : null;
      }
      const command = listed?.find((each) => each.label === word || each.label === `/${word}`);
      if (command) return chip({ kind: "command", id: command.id, type: command.kind, label: command.label });
      const row = word !== owner && rows?.find((each) => each.id === word);
      if (row) return chip({ kind: "mention", id: row.id, type: row.worker ? "worker" : "chat", label: row.title || "New session" });
      const line = LINE.exec(word)?.[1]?.split(":")[1];
      const hit = found[word.replace(LINE, "")];
      if (hit?.folder && !hit.outside) return chip({ kind: "mention", id: hit.path, type: "folder", label: hit.path });
      if (hit) return <FileRef word={label ?? word} open={() => openHit(owner, hit, line)} />;
      return null;
    };
  }, [owner, rows, prs, listed, found]);
  return <RefsContext value={value}>{children}</RefsContext>;
}

/** A word `remarkRefs` marked, a whole inline code or a link's target (`label` its words): its chip when the session knows it, else `plain`. */
export function RefWord({ word, label, plain }: { word: string; label?: ReactNode; plain: ReactNode }) {
  return useContext(RefsContext)?.(word, label) ?? plain;
}

/** A file the answer names: a blue link with a file icon, opening it in a preview tab [D113]. */
export function FileRef({ word, open }: { word: ReactNode; open: () => void }) {
  return (
    <button type="button" onClick={open} className="inline cursor-pointer rounded-xs text-chat-link focus-visible:focus-ring">
      <File className="me-0.5 inline-block size-icon-sm align-icon" />
      {word}
    </button>
  );
}

/** A PR the session knows, as its card row: the state's icon and colour, the number, opening its tab [D251]. */
function PrRef({ owner, pr }: { owner: string; pr: Pr }) {
  const state = pr.state === "open" && pr.draft ? "draft" : pr.state;
  const { Icon, tint } = PR_LOOK[state];
  const ref = pr.url && pastedRef(pr.url);
  const link = (
    <button type="button" data-slot="composer-chip" title={ref ? undefined : `${pr.title} · ${STATE_WORDS[state]}`} onClick={() => openPr(owner, pr)} className="inline cursor-pointer rounded-xs text-link focus-visible:focus-ring">
      <Icon className={`mr-0.5 inline-block size-icon-sm align-icon ${tint}`} />#{pr.number}
    </button>
  );
  return ref ? <PrHoverCard refName={ref}>{link}</PrHoverCard> : link;
}
