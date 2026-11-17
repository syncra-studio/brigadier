import { useId } from "react";

import { Link, Plus } from "../icons";
import { BOX, BOX_INPUT, FieldLabel, folderFromUrl, GitHubRepos, SaveTo } from "../projects/clone";
import type { Source } from "../projects/store";

/*
 * The Projects step's Clone and New tabs, in Add project's fields [D616]: what's typed and where it goes are
 * the step's, which clones or creates it with its footer's button.
 */

type Where = { source: Source; parent: string; busy: boolean; onParent: (parent: string) => void; onError: (error: string) => void };

/** A repository by `owner/name` or URL, typed or picked from your GitHub repositories, and where it goes. */
export function CloneTab({ url, onUrl, ...where }: Where & { url: string; onUrl: (url: string) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-5.5">
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor={id} label="Repository" />
        <div className={BOX}>
          <Link />
          <input
            id={id}
            value={url}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            disabled={where.busy}
            placeholder="owner/repo or https://github.com/owner/repo.git"
            onChange={(event) => onUrl(event.target.value)}
            className={BOX_INPUT}
          />
        </div>
      </div>
      <SaveTo parent={where.parent} name={folderFromUrl(url)} aside="Named after the repository" disabled={where.busy} source={where.source} onParent={where.onParent} onError={where.onError} />
      <div className="flex flex-col gap-2">
        <FieldLabel label="Your GitHub repositories" aside="Type to search" />
        <GitHubRepos source={where.source} filter={/[:@]/.test(url) ? "" : url} running={where.busy ? url : null} chosen={url} onPick={onUrl} />
      </div>
    </div>
  );
}

/** A new repository: its name, and where it goes; git starts in it. */
export function NewTab({ name, onName, ...where }: Where & { name: string; onName: (name: string) => void }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-5.5">
      <div className="flex flex-col gap-2">
        <FieldLabel htmlFor={id} label="Name" />
        <div className={BOX}>
          <Plus />
          <input
            id={id}
            value={name}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            maxLength={200}
            disabled={where.busy}
            placeholder="my-project"
            onChange={(event) => onName(event.target.value)}
            className={BOX_INPUT}
          />
        </div>
      </div>
      <SaveTo parent={where.parent} name={name.trim()} disabled={where.busy} source={where.source} onParent={where.onParent} onError={where.onError} />
    </div>
  );
}
