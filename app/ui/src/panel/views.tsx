import type { ComponentType } from "react";

import { EmptyState } from "../components/empty-state";
import { Branch, Folders, Search } from "../icons";
import { SourceView } from "./source/view";
import type { PanelView } from "./types";

/*
 * The right panel's views, one per tab: its icon and what it draws for a session or chat. Each view's own step
 * swaps its line here (Files 2.5, Search 2.7); the panel's frame never changes for them.
 */

const NotYet = (title: string, icon: ComponentType<{ className?: string }>) =>
  function NotConnected() {
    return <EmptyState variant="centered" icon={icon} title={title} detail="Not connected yet" className="m-auto" />;
  };

export const VIEWS: Record<PanelView, { Icon: ComponentType; View: ComponentType<{ owner: string }> }> = {
  // shortcut: Files and Search open nothing yet; when the file tab kind lands (w17), they become
  // ({ owner }) => <FilesView owner={owner} onOpen={(path, keep) => openFile(owner, path, { preview: !keep })} />
  // and the same for SearchView, with the match's line.
  files: { Icon: Folders, View: NotYet("Files", Folders) },
  search: { Icon: Search, View: NotYet("Search", Search) },
  source: { Icon: Branch, View: SourceView },
};
