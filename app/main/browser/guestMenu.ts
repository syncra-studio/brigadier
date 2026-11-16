// A page's right-click menu. The OS draws it, so no pane or window edge can clip it. What it offers follows
// the thing clicked, as in a normal browser: Back, Forward and Reload only on the page itself. Inspect comes
// with section 9.
import { BrowserWindow, clipboard, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";

type Item = { id: string; label: string; enabled?: boolean; run: () => void };

type OpenAsTab = (from: WebContents, url: string) => void;

function sections(contents: WebContents, params: ContextMenuParams, openAsTab: OpenAsTab): Item[][] {
  const { editFlags, isEditable, linkURL, mediaType, selectionText, srcURL, x, y } = params;
  const found: Item[][] = [];
  if (linkURL) {
    found.push([
      ...(/^https?:/.test(linkURL) ? [{ id: "open-link", label: "Open Link in New Tab", run: () => openAsTab(contents, linkURL) }] : []),
      { id: "copy-link", label: "Copy Link Address", run: () => clipboard.writeText(linkURL) },
    ]);
  }
  if (mediaType === "image" && srcURL) {
    found.push([
      // shortcut: Electron's own save dialog until the downloads section (browserDownloads' askWhereToSave) lands.
      { id: "save-image", label: "Save Image As…", run: () => contents.downloadURL(srcURL) },
      { id: "copy-image", label: "Copy Image", run: () => contents.copyImageAt(x, y) },
    ]);
  }
  if (isEditable) {
    found.push([
      { id: "cut", label: "Cut", enabled: editFlags.canCut, run: () => contents.cut() },
      { id: "copy", label: "Copy", enabled: editFlags.canCopy, run: () => contents.copy() },
      { id: "paste", label: "Paste", enabled: editFlags.canPaste, run: () => contents.paste() },
    ]);
  } else if (selectionText.trim()) {
    found.push([{ id: "copy", label: "Copy", run: () => contents.copy() }]);
  }
  // A Mac right-click selects the word under it, so text alone mustn't take these away.
  if (linkURL || isEditable || (mediaType === "image" && srcURL)) return found;
  const history = contents.navigationHistory;
  return [...found, [
    { id: "back", label: "Back", enabled: history.canGoBack(), run: () => history.goBack() },
    { id: "forward", label: "Forward", enabled: history.canGoForward(), run: () => history.goForward() },
    { id: "reload", label: "Reload", run: () => contents.reload() },
  ]];
}

export function installGuestMenu(contents: WebContents, openAsTab: OpenAsTab): void {
  contents.on("context-menu", (_event, params) => {
    const template: MenuItemConstructorOptions[] = sections(contents, params, openAsTab).flatMap((section, index) => [
      ...(index > 0 ? [{ type: "separator" as const }] : []),
      ...section.map(({ id, label, enabled, run }) => ({ id, label, enabled: enabled ?? true, click: run })),
    ]);
    const window = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents);
    if (window) Menu.buildFromTemplate(template).popup({ window });
  });
}
