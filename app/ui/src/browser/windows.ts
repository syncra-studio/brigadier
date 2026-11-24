// The windows a tab's page opened for itself (main's guestPopups.ts): each a real window that keeps its opener, worked
// by the tab's agent under an id of its own, `<tab>/w<n>`. A user's takeover of the tab holds its windows too.

export type PageWindow = { id: string; guest: number; url: string; title: string; loading: boolean; generation: number; zoom: number };
/** What main says of one: the tab's guest `from`, and whether it closed. */
export type WindowSeen = Omit<PageWindow, "id"> & { from: number; closed: boolean };

const windows = new Map<string, PageWindow>();

export function windowSeen(tab: string, { from: _from, closed, ...seen }: WindowSeen): void {
  const id = `${tab}/w${seen.guest}`;
  if (closed) windows.delete(id);
  else windows.set(id, { id, ...seen });
}

export const isWindow = (id: string): boolean => id.includes("/");
/** The tab of a page's id: itself, or the tab whose page opened the window. */
export const tabOf = (id: string): string => id.split("/")[0] as string;
export const windowOf = (id: string): PageWindow | undefined => windows.get(id);
export const windowsOf = (tab: string): PageWindow[] => [...windows.values()].filter((each) => tabOf(each.id) === tab);
