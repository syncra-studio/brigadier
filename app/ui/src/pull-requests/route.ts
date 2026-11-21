import { store } from "../onboarding/api";

/*
 * The Pull Requests page [D159 D194]: `#pull-requests`, and `#pull-requests/<ref>` with a PR open, its
 * ref `host/owner/name#n` as every PR write names it. Pinned, Recents, the display options and each PR's review chat are the
 * app's own, kept across launches.
 */

const PREFIX = "#pull-requests";

/** null off the page; "" on it with no PR open; else the open PR's ref. */
export function prPageOf(hash: string): string | null {
  if (hash === PREFIX) return "";
  return hash.startsWith(`${PREFIX}/`) ? decodeURIComponent(hash.slice(PREFIX.length + 1)) : null;
}

export const prPageHash = (ref = "") => (ref ? `${PREFIX}/${encodeURIComponent(ref)}` : PREFIX);

/** A PR as the page's rows show it: `host @ search`'s row. */
export type PrRow = {
  ref: string;
  number: number;
  title: string;
  url: string;
  state: "open" | "closed" | "merged";
  draft?: boolean;
  author?: string | null;
  createdAtMs?: number | null;
  updatedAtMs?: number | null;
};

/** `owner/name #n` from a ref. */
export function prName(ref: string): string {
  const [repo, n] = ref.split("#");
  return `${repo!.split("/").slice(1).join("/")} #${n}`;
}

/** A PR named by a pasted link or `owner/name#n`, as its ref; null for anything else [D160]. */
export function pastedRef(text: string): string | null {
  const t = text.trim();
  const url = /^(?:https?:\/\/)?([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/.exec(t);
  if (url) return `${url[1]}/${url[2]}/${url[3]}#${url[4]}`;
  const short = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(t);
  return short ? `github.com/${short[1]}/${short[2]}#${short[3]}` : null;
}

function kept<T>(key: string, initial: T) {
  const saved = localStorage.getItem(key);
  const value = store<T>(saved === null ? initial : (JSON.parse(saved) as T));
  const set = value.set;
  value.set = (next) => {
    localStorage.setItem(key, JSON.stringify(next));
    set(next);
  };
  return value;
}

export const pinned = kept<PrRow[]>("pullRequests.pinned", []);
export const recents = kept<PrRow[]>("pullRequests.recents", []);
/** Each PR's review chat, by ref: the session its first message started [D162]. */
export const reviewChats = kept<Record<string, string>>("pullRequests.chats", {});

const RECENTS = 10;

/** Opens a PR on the page, first among Recents; a bare ref (a pasted link) is listed once its row is known. */
export function openPrPage(row: PrRow | string): void {
  const ref = typeof row === "string" ? row : row.ref;
  if (typeof row !== "string") recents.set([row, ...recents.get().filter((each) => each.ref !== ref)].slice(0, RECENTS));
  window.location.hash = prPageHash(ref);
}

export function togglePin(row: PrRow): void {
  const now = pinned.get();
  pinned.set(now.some((each) => each.ref === row.ref) ? now.filter((each) => each.ref !== row.ref) : [...now, row]);
}
