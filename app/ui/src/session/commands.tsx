import { type RefObject, useEffect, useState } from "react";

import type { OpenKind } from "../components/composer/chip";
import type { ComposerFieldHandle } from "../components/composer/field";
import { type Commands, type Mention, PlusMenu, type SlashCommand } from "../components/composer/menus";
import { viewImage } from "../components/image-viewer";
import { showToast } from "../components/toast";
import { ask } from "../daemon";
import { openFile } from "../shell/tab-store";
import type { Runner } from "./composer";
import { HOME_DRAFT } from "./draft";

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
      // Home has no session to run an instant one in.
      setListed(list.filter((each) => !(home && each.instant)).map((each) => ({ id: `${each.kind}:${each.name}`, kind: each.kind, label: `/${each.name}`, description: each.description || undefined, source: each.path ?? undefined, instant: each.instant })));
    });
    ask({ op: "mention", owner, q: "", ...(project ? { project } : {}) }, (reply) => {
      if (live && reply.ok) setChats(reply.groups.flatMap((group: { items: Mention[] }) => group.items.filter((item) => item.type === "chat")));
    });
    return () => {
      live = false;
    };
  }, [owner, backend, project, fresh]);

  const commands: Commands = {
    commands: listed && [...listed, ...extra],
    onRun: (command) => {
      void run(["command", owner, command.label.slice(1)]).then((reply) => {
        if (!reply.ok) showToast(String(reply.error ?? `Couldn't run ${command.label}`), { tone: "error" });
      });
    },
  };

  /** One plain click on a chip: in a new tab, the chat as its session, an image in the viewer [D146, D151, D2022 #19]. */
  const onOpen = (kind: OpenKind, id: string) => {
    if (kind === "chat") return void (location.hash = `#thread/${id}`);
    if (kind === "image") return viewImage([{ name: "Image", url: `/attachment/${home ? "home" : owner}/${id}` }], 0);
    if (kind === "paste") return window.brigadier?.openAttachment(`/attachment/${home ? "home" : owner}/${id}`);
    if (home) return;
    if (kind === "file") return openFile(owner, id, { preview: false });
    if (kind === "folder") {
      return ask({ op: "run", args: ["source", owner, "reveal", id] }, (reply) => {
        if (!reply.ok) showToast(`Couldn't reveal ${id}: ${String(reply.error)}`, { tone: "error" });
      });
    }
    const path = listed?.find((each) => each.id === id)?.source;
    if (path) openFile(owner, path, { preview: false });
  };

  const plus = <PlusMenu onFiles={onFiles} field={field} commands={commands} chats={chats} />;
  return { commands, onOpen, plus };
}
