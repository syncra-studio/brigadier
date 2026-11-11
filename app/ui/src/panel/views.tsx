import type { ComponentType } from "react";

import { FilesView } from "../files/views";
import { Branch, Folders } from "../icons";
import { openFile, useTabs } from "../shell/tab-store";
import { SourceView } from "./source/view";
import type { PanelView } from "./types";

/*
 * The right panel's views, one per tab: its icon and what it draws for a session or chat. Each view's own step
 * swaps its line here; the panel's frame never changes for them.
 */

/** Files lights up the file whose tab is in front; a click opens it in the preview tab, a double click keeps it. */
function Files({ owner }: { owner: string }) {
  const { tabs, active } = useTabs(owner);
  const front = tabs.find((tab) => tab.id === active && tab.kind === "file")?.target ?? null;
  return <FilesView owner={owner} shown={front} onOpen={(path, keep) => openFile(owner, path, { preview: !keep })} />;
}

export const VIEWS: Record<PanelView, { Icon: ComponentType; View: ComponentType<{ owner: string }> }> = {
  files: { Icon: Folders, View: Files },
  source: { Icon: Branch, View: SourceView },
};
