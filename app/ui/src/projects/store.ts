import { showToast } from "../components/toast";
import { errorText, store } from "../onboarding/api";

/** A repository found on this Mac, or a folder the user chose; `project_id` once it is a project. */
export type Repo = { path: string; name: string; project_id: string | null; plain?: boolean };

/** What a chosen folder is, as Rust checked it [D165]. */
export type FolderCheck =
  | { kind: "repo"; repo: string; name: string; project_id: string | null }
  | { kind: "plain"; path: string; name: string }
  | { kind: "missing"; path: string }
  | { kind: "invalid"; reason: string };

/** One of your GitHub repositories, by `owner/name` [D202]. */
export type GitHubRepo = { name: string; description: string | null; private: boolean };
/** Your GitHub repositories through the gh CLI, or why there are none to show. */
export type GitHub = { repos: GitHubRepo[] } | { gh: "missing" | "signed-out" };

/**
 * Where Add project's data comes from: the daemon, or the gallery's Fake. Each add, clone and new
 * repository resolves to the project's id once Rust has it, or throws its reason [D30].
 */
export type Source = {
  find(): Promise<Repo[]>;
  check(path: string): Promise<FolderCheck>;
  /**
   * Adds the repository at `path`. With `init`, git starts there first: "here" in an existing folder
   * in no repository, "new" in a folder it makes (or an empty one).
   */
  add(path: string, init?: "here" | "new"): Promise<string>;
  /** Clones a URL, or with `github` an `owner/name` through gh's own sign-in, into `dest`. */
  clone(from: string, dest: string, github?: boolean): Promise<string>;
  github(): Promise<GitHub>;
  /** The native folder picker, starting at `at`. */
  pick(at?: string): Promise<string | null>;
};

/** Where clones and new repositories go unless changed; made when missing [D168]. */
export const DEFAULT_PARENT = "~/code/";

/** The dialog: open, with the folder it starts on ("" for none). Each opening starts over. */
const dialog = store({ open: false, path: "", opening: 0 });
export const useAddProject = dialog.use;

/** Opens Add project: from the sidebar's +, the empty page, the View menu [D165]. */
export function openAddProject(path = ""): void {
  dialog.set({ open: true, path, opening: dialog.get().opening + 1 });
}

export function closeAddProject(): void {
  dialog.set({ ...dialog.get(), open: false });
}

// shortcut: nothing shows a project until stream C's sidebar (1c) sets this; it expands the project and drafts a session in it.
let show: (id: string) => void = () => {};
export const showProject = (id: string) => show(id);
export const setShowProject = (next: (id: string) => void) => (show = next);

/**
 * Folders picked with ⌘O: each repository is added at once, a project already added shows, and a
 * folder in no repository opens Add project on it, which says what adding it does (the old app's).
 */
export async function openFolders(source: Source, paths: readonly string[]): Promise<void> {
  let shown: string | null = null;
  const added: string[] = [];
  try {
    for (const path of paths) {
      const check = await source.check(path);
      if (check.kind === "invalid") {
        showToast(check.reason, { tone: "error" });
        continue;
      }
      if (check.kind !== "repo") {
        openAddProject(path);
        break;
      }
      shown = check.project_id ?? (await source.add(check.repo));
      if (!check.project_id) added.push(check.name);
    }
  } catch (cause) {
    showToast(errorText(cause), { tone: "error" });
  }
  if (shown) showProject(shown);
  if (added.length === 1) showToast(`Added ${added[0]}`);
  else if (added.length > 1) showToast(`Added ${added.length} projects`);
}
