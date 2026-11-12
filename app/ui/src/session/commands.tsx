import { type RefObject, useEffect, useMemo, useState } from "react";

import type { OpenKind } from "../components/composer/chip";
import type { ComposerFieldHandle } from "../components/composer/field";
import { type Commands, type Mention, PlusMenu, type SlashCommand } from "../components/composer/menus";
import { viewImage } from "../components/image-viewer";
import { showToast } from "../components/toast";
import { ask } from "../daemon";
import { PASTE_LABEL } from "../shell/attachment-tab";
import { openAttachment, openFile } from "../shell/tab-store";
import type { Runner } from "./composer";
import { HOME_DRAFT } from "./draft";
import { urlOf } from "./files";

type Listed = { name: string; description?: string; kind: SlashCommand["kind"]; path?: string | null; instant: boolean };

/**
 * A composer's `/` menu, its + menu and what a chip opens, for `owner` (a session's id, or Home's draft): the agent's
 * own commands from Rust, kept per agent and project, plus `extra` (Brigadier's /new); an instant one runs at once
 * through the agent's own call [D164, D315, D2009, D2011]. Asked again when `fresh` changes (a turn starts or ends).
 */
export function useComposerCommands({ owner, run, field, backend, project, extra = [], fresh, onFiles }: { owner: string; run: Runner; field: RefObject<ComposerFieldHandle | null>; backend?: string; project?: string | null; extra?: SlashCommand[]; fresh?: unknown; onFiles: (files: File[]) => void }) {
  const [listed, setListed] = useState<SlashCommand[] | null>(null);
  const [chats, setChats] = useState<Mention[]>([]);
  const home = owner === HOME_DRAFT;
  useEffect(() => {
    if (home && !backend) return setListed([]);
    let live = true;
    void run(["commands", owner, ...(home ? ["--backend", backend!, ...(project ? ["--project", project] : [])] : [])]).then((reply) => {
      if (!live) return;
      const list: Listed[] = reply.ok ? (reply.commands ?? []) : [];
      setListed(list.map((each) => ({ id: `${each.kind}:${each.name}`, kind: each.kind, label: `/${each.name}`, description: each.description || undefined, source: each.path ?? undefined, instant: each.instant })));
    });
    ask({ op: "mention", owner, q: "", ...(project ? { project } : {}) }, (reply) => {
      if (live && reply.ok) setChats(reply.groups.flatMap((group: { items: Mention[] }) => group.items.filter((item) => item.type === "chat")));
    });
    return () => {
      live = false;
    };
  }, [owner, backend, project, fresh]);

  // The same array until the list changes: a new one each render re-ran the `/` menu, whose update re-rendered Home, and so on. `extra` is [] or [/new].
  const all = useMemo(() => listed && [...listed, ...extra], [listed, extra.length]);
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

  const onOpen = (kind: OpenKind, id: string) => openChip(owner, kind, id, listed?.find((each) => each.id === id), run);

  const plus = <PlusMenu onFiles={onFiles} field={field} commands={commands} chats={chats} />;
  return { commands, onOpen, plus };
}

/**
 * One plain click on a chip, in the composer or a sent message: in a new tab, the chat as its session, an image in
 * the viewer, a paste in its tab [D146, D151, D2022 #19, D2107]. `command`: a command chip's entry in the `/` list.
 */
export function openChip(owner: string, kind: OpenKind, id: string, command?: SlashCommand, run?: Runner) {
  const home = owner === HOME_DRAFT;
  if (kind === "chat") return void (location.hash = `#thread/${id}`);
  if (kind === "image") return viewImage([{ name: "Image", url: urlOf(owner, id) }], 0);
  // Editable in its own tab, as the old app's composer paste [D2098].
  if (kind === "paste") return openAttachment(owner, id, PASTE_LABEL);
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
