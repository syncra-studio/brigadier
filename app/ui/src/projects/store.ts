import { showToast } from "../components/toast";
import { connected } from "../daemon";
import { errorText, run, store } from "../onboarding/api";
import { addProject, newProjectId } from "./projects";

/** What a chosen folder is, as Rust checked it [D165]. */
export type FolderCheck =
  | { kind: "repo"; repo: string; name: string; project_id: string | null }
  | { kind: "plain"; path: string; name: string }
  // A folder holding repositories, added as it is [D494].
  | { kind: "folder"; path: string; name: string; repos: string[]; project_id: string | null }
  | { kind: "missing"; path: string }
  | { kind: "invalid"; reason: string };

/** One of your GitHub repositories, by `owner/name` [D202], and the signed-in account that sees it [D625]. */
export type GitHubRepo = { name: string; description: string | null; private: boolean; account?: string };
/** Your GitHub repositories through the gh CLI, or why there are none to show. */
export type GitHub = { repos: GitHubRepo[] } | { gh: "missing" | "signed-out" };
/** The name and email git commits as: `set` in its config, else suggested (onboarding's name, GitHub's private email). */
export type GitIdentity = { set: boolean; name: string; email: string };

/**
 * Where Add project's data comes from: the daemon. Each add, clone and new
 * repository goes under an id made here and resolves once Rust has the project, or throws its
 * reason; "disconnected" while the daemon is away, the add then settling by id [D30].
 */
export type Source = {
  /** The repositories the agents' own history ran in, and the folder most projects are in, for the Projects tabs [D45, D627]. */
  history(): Promise<{ found: string[]; parent: string }>;
  check(path: string): Promise<FolderCheck>;
  /**
   * Adds the repository at `path`. With `init`, git starts there first: "here" in an existing folder
   * in no repository, "new" in a folder it makes (or an empty one).
   */
  add(id: string, path: string, init?: "here" | "new"): Promise<unknown>;
  /** Clones a URL, or with `github` an `owner/name` through gh's own sign-in (`account`'s, else gh's active one), into `dest`. */
  clone(id: string, from: string, dest: string, github?: boolean, account?: string): Promise<unknown>;
  github(): Promise<GitHub>;
  /** Git's identity; with a name and email, they're set for every repository first. */
  identity(name?: string, email?: string): Promise<GitIdentity>;
  /** The native folder picker, starting at `at`. */
  pick(at?: string): Promise<string | null>;
};

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

/** Project settings: open, on which project; its own id stays while it closes. */
const settings = store({ open: false, id: "" });
export const useProjectSettings = settings.use;

/** Opens a project's settings over the page in front. */
export const openProject = (id: string) => settings.set({ open: true, id });
/** Closes them; with `id`, only that project's. */
export const closeProject = (id = settings.get().id) => id === settings.get().id && settings.set({ ...settings.get(), open: false });

// The sidebar reveals added projects; search expands one without changing the chosen grouping [D289].
let show: (id: string, group: boolean) => void = () => {};
export const showProject = (id: string, group = true) => show(id, group);
export const setShowProject = (next: (id: string, group: boolean) => void) => (show = next);

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
      if (check.project_id) {
        shown = check.project_id;
        continue;
      }
      shown = newProjectId();
      await source.add(shown, check.repo);
      added.push(check.name);
    }
  } catch (cause) {
    showToast(errorText(cause), { tone: "error" });
  }
  if (shown) showProject(shown);
  if (added.length === 1) showToast(`Added ${added[0]}`);
  else if (added.length > 1) showToast(`Added ${added.length} projects`);
}

/** Add project on the daemon: the commands in `crates/cli/src/setup.rs`, each add through `addProject` [D30]. */
export const daemonSource: Source = {
  history: async () => (await run(["projects"])) as { found: string[]; parent: string },
  check: async (path) => (await run(["projects", "inspect", path])).check as FolderCheck,
  add: (id, path, init) => addProject(path, init ? ["init", path, ...(init === "here" ? ["--here"] : [])] : ["add", path], id),
  clone: (id, from, dest, github, account) =>
    addProject(dest, ["clone", from, "--to", dest, ...(github ? ["--github"] : []), ...(account ? ["--account", account] : [])], id),
  github: async () => (await run(["projects", "github"])).github as GitHub,
  identity: async (name, email) => (await run(["projects", "identity", ...(name === undefined ? [] : ["--name", name, "--email", email ?? ""])])) as GitIdentity,
  pick: async (at) => ((await window.brigadier?.pickFolders({ at })) ?? [])[0] ?? null,
};

/** The app menu's View › Add project… and File › Open Folder… (⌘O) [D165]; called once by the app. */
export const listenToMenu = () =>
  window.brigadier?.onMenu((command, paths) => (command === "add-project" ? openAddProject() : command === "open-folders" && void connected().then(() => openFolders(daemonSource, paths ?? []))));
