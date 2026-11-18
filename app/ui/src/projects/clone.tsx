import { cx } from "../components/cx";

/** `owner/name` is a GitHub repository; anything else is taken as typed (the old app's). */
const SHORTHAND = /^[\w.-]+\/[\w.-]+$/;
export const cloneUrl = (typed: string) => {
  const url = typed.trim();
  return SHORTHAND.test(url) ? `https://github.com/${url.replace(/\.git$/, "")}.git` : url;
};
/** The folder a clone of `url` goes in: its last path part, without `.git`. */
export const folderFromUrl = (url: string) => (url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "").replace(/\.git$/, "");

/** Why a new repository's name can't be its folder's, or null. */
export const folderProblem = (folder: string) =>
  !folder || folder === "." || folder === ".." || folder.includes("/") ? (folder ? `"${folder}" can't be a folder name.` : "Name the repository.") : null;

/** A 42-high capsule for a field, in the Input's look: its icon, then its content. */
export const BOX = cx(
  "flex h-10.5 items-center gap-2.5 rounded-capsule border border-transparent bg-fill ps-3.5 pe-1.5 transition-colors",
  "focus-within:bg-background focus-within:focus-ring has-aria-invalid:border-invalid has-disabled:opacity-disabled",
  "svg:size-icon-sm svg:shrink-0 svg-uncoloured:text-muted-foreground",
);
export const BOX_INPUT = "h-full min-w-0 flex-1 cursor-text bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground";
