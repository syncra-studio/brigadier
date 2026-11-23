import { type RefObject, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { OpenKind } from "../components/composer/chip";
import { openWorker } from "../workers/live";
import type { ComposerFieldHandle } from "../components/composer/field";
import { type Commands, type Mention, PlusMenu, type SlashCommand } from "../components/composer/menus";
import { TOOL_COMMANDS } from "../components/composer/tools";
import { viewImage } from "../components/image-viewer";
import { showToast } from "../components/toast";
import { ask } from "../daemon";
import { isPasteLabel, PASTE_LABEL } from "../shell/attachment-tab";
import { openAttachment, openFile, openTab, selectTab } from "../shell/tab-store";
import type { Runner } from "./composer";
import { openSettings } from "../settings/shell";
import { HOME_DRAFT } from "./draft";
import { urlOf } from "./files";

type Listed = { name: string; description?: string; kind: SlashCommand["kind"]; path?: string | null; instant: boolean };

/**
 * A composer's `/` menu, its + menu and what a chip opens, for `owner` (a session's id, or Home's draft): the agent's
 * own commands from Rust, kept per agent and project, plus `extra` (Brigadier's /new); an instant one runs at once
 * through the agent's own call [D164, D315, D2009, D2011]. Asked again when `fresh` changes (a turn starts or ends).
 * Home's `backend`: undefined until its project and model are known, the menu loading meanwhile; null, no agent to ask [D178].
 */
export function useComposerCommands({ owner, run, field, backend, project, extra = [], fresh, onFiles }: { owner: string; run: Runner; field: RefObject<ComposerFieldHandle | null>; backend?: string | null; project?: string | null; extra?: SlashCommand[]; fresh?: unknown; onFiles: (files: File[]) => void }) {
  // Kept with what it was asked for: another agent's or project's list reads as loading, never as this one's [D178].
  const [kept, setKept] = useState<{ key: string; list: SlashCommand[] } | null>(null);
  const [chats, setChats] = useState<Mention[]>([]);
  const home = owner === HOME_DRAFT;
  const key = `${owner} ${backend} ${project}`;
  const listed = kept?.key === key ? kept.list : null;
  useEffect(() => {
    if (home && backend === undefined) return;
    if (home && !backend) return setKept({ key, list: [] });
    let live = true;
    void run(["commands", owner, ...(home ? ["--backend", backend!, ...(project ? ["--project", project] : [])] : [])]).then((reply) => {
      if (!live) return;
      const list: Listed[] = reply.ok ? (reply.commands ?? []) : [];
      setKept({ key, list: list.map((each) => ({ id: `${each.kind}:${each.name}`, kind: each.kind, label: `/${each.name}`, description: each.description || undefined, source: each.path ?? undefined, instant: each.instant })) });
    });
    ask({ op: "mention", owner, q: "", ...(project ? { project } : {}) }, (reply) => {
      if (live && reply.ok) setChats(reply.groups.flatMap((group: { items: Mention[] }) => group.items.filter((item) => item.type === "chat")));
    });
    return () => {
      live = false;
    };
  }, [owner, backend, project, fresh]);

  useEffect(() => {
    if (!listed) return;
    listedOf.set(owner, listed);
    for (const heard of hearing) heard();
  }, [owner, listed]);

  // The same array until the list changes: a new one each render re-ran the `/` menu, whose update re-rendered Home, and so on. `extra` is [] or [/new].
  // Brigadier's tools first, so an agent's own command of the same name is the one typing it makes.
  const all = useMemo(() => listed && [...TOOL_COMMANDS, ...listed, ...extra], [listed, extra.length]);
  const commands: Commands = {
    commands: all,
    onRun: (command) => {
      // Home has no session to run it in yet: the old app's hint (its instant ones are /compact) [D2098].
      if (home) return void showToast("Send a message before compacting.");
      void run(["command", owner, command.label.slice(1)]).then((reply) => {
        if (!reply.ok) showToast(String(reply.error ?? `Couldn't run ${command.label}`), { tone: "error" });
      });
    },
  };

  const onOpen = (kind: OpenKind, id: string, name?: string) => openChip(owner, kind, id, listed?.find((each) => each.id === id), run, name);

  const plus = <PlusMenu onFiles={onFiles} field={field} commands={commands} chats={chats} />;
  return { commands, onOpen, plus };
}

/** Each session's `/` list as its composer last read it, for the chips its answers draw [D251]. */
const listedOf = new Map<string, SlashCommand[]>();
const hearing = new Set<() => void>();
const hear = (heard: () => void) => {
  hearing.add(heard);
  return () => void hearing.delete(heard);
};
export const useListedCommands = (owner: string | undefined) => useSyncExternalStore(hear, () => (owner ? listedOf.get(owner) : undefined));

/**
 * One plain click on a chip, in the composer or a sent message: in a new tab, the chat as its session, a worker in
 * its panel, an image in the viewer, a paste in its tab [D146, D151, D2022 #19, D2107]. `command`: a command chip's entry in the `/` list;
 * `name`: a paste's chip's words, its tab's title when it's a PR's ("Pull request #n") [D696].
 */
export function openChip(owner: string, kind: OpenKind, id: string, command?: SlashCommand, run?: Runner, name?: string) {
  const home = owner === HOME_DRAFT;
  if (kind === "chat") return void (location.hash = `#thread/${id}`);
  if (kind === "tab") return selectTab(owner, id);
  if (kind === "note") return openTab(owner, "note", id);
  if (kind === "plugin") return openSettings("plugins");
  if (kind === "worker") return openWorker(owner, id);
  if (kind === "image") return viewImage([{ name: "Image", url: urlOf(owner, id) }], 0);
  // Editable in its own tab, as the old app's composer paste [D2098].
  if (kind === "paste") return openAttachment(owner, id, name && isPasteLabel(name) ? name : PASTE_LABEL);
  if (home) return;
  if (kind === "file") return openFile(owner, id, { preview: false });
  if (kind === "folder") {
    return ask({ op: "run", args: ["source", owner, "reveal", id] }, (reply) => {
      if (!reply.ok) showToast(`Couldn't reveal ${id}: ${String(reply.error)}`, { tone: "error" });
    });
  }
  const path = command?.source;
  // Outside the checkout it shows in Finder, as the old app's file links [D2098].
  if (path?.startsWith("/") && run) {
    return void run(["commands", owner, "reveal", command!.label.slice(1)]).then((reply) => {
      if (!reply.ok) showToast(String(reply.error ?? `Couldn't reveal ${path}`), { tone: "error" });
    });
  }
  if (path) openFile(owner, path, { preview: false });
}
