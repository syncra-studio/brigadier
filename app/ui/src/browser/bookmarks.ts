import { run, store } from "../onboarding/api";

/*
 * Bookmarks of the built-in browser, by profile. Rust keeps them (`brigadier browser - bookmarks`), and imports land
 * there.
 */

export type Bookmark = {
  id: number;
  url: string;
  title: string;
  /** Folders from the top down, such as `["Bookmarks bar", "Work"]`. */
  folders: string[];
  addedMs: number;
};

export type BookmarkEdit = { url: string; title: string; folders: string[] };

export type BookmarkFolder = { key: string; label: string; bookmarks: Bookmark[] };

export const FOLDER_SEPARATOR = " › ";

const bookmarks = (profile: string, args: string[]) => run(["browser", "-", "bookmarks", ...args, "--profile", profile]);

/** Goes up with every change, so a star that shows looks again. */
const changes = store(0);
export const useBookmarkChanges = changes.use;
const changed = <T>(done: T): T => {
  changes.set(changes.get() + 1);
  return done;
};

export async function browserBookmarks(profile: string): Promise<Bookmark[]> {
  return (await bookmarks(profile, ["list"])).bookmarks as Bookmark[];
}

export async function addBookmark(profile: string, bookmark: BookmarkEdit): Promise<Bookmark> {
  return changed((await bookmarks(profile, ["add", JSON.stringify(bookmark)])).bookmark as Bookmark);
}

export async function updateBookmark(profile: string, id: number, bookmark: BookmarkEdit): Promise<void> {
  changed(await bookmarks(profile, ["update", String(id), JSON.stringify(bookmark)]));
}

export async function removeBookmark(profile: string, id: number): Promise<void> {
  changed(await bookmarks(profile, ["remove", String(id)]));
}

/** Whether `url` is bookmarked in `profile`: the toolbar's star. */
export async function isBookmarked(profile: string, url: string): Promise<boolean> {
  return (await browserBookmarks(profile)).some((bookmark) => bookmark.url === url);
}

/** Bookmarks the page, in no folder, unless it is bookmarked already. */
export async function bookmarkPage(profile: string, url: string, title: string): Promise<void> {
  if (!(await isBookmarked(profile, url))) await addBookmark(profile, { url, title, folders: [] });
}

/** Removes every bookmark of the page, in whatever folder. */
export async function unbookmarkPage(profile: string, url: string): Promise<void> {
  const found = (await browserBookmarks(profile)).filter((bookmark) => bookmark.url === url);
  // One at a time: each is a read and a write of the same file.
  for (const bookmark of found) await removeBookmark(profile, bookmark.id);
}

/** A folder's path as one line. A bookmark in no folder sits in "Bookmarks". */
export function folderLabel(folders: readonly string[]): string {
  return folders.join(FOLDER_SEPARATOR) || "Bookmarks";
}

/** The bookmarks whose title, address or folder holds every word of `query`, by folder, A to Z. */
export function bookmarkFolders(bookmarks: readonly Bookmark[], query: string): BookmarkFolder[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const folders = new Map<string, BookmarkFolder>();
  for (const bookmark of bookmarks) {
    const label = folderLabel(bookmark.folders);
    const text = `${bookmark.title} ${bookmark.url} ${label}`.toLowerCase();
    if (!words.every((word) => text.includes(word))) continue;
    const folder = folders.get(label);
    if (folder) folder.bookmarks.push(bookmark);
    else folders.set(label, { key: label, label, bookmarks: [bookmark] });
  }
  return [...folders.values()]
    .toSorted((a, b) => a.label.localeCompare(b.label))
    .map((folder) => ({
      ...folder,
      bookmarks: folder.bookmarks.toSorted((a, b) => (a.title || a.url).localeCompare(b.title || b.url)),
    }));
}

/** What the user typed as a bookmark's address: the built-in browser opens http and https only. */
export function bookmarkAddress(typed: string): string | null {
  const text = typed.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host ? url.href : null;
  } catch {
    return null;
  }
}
