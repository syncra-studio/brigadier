import { type FormEvent, type ReactNode, useId, useState } from "react";

import { Button } from "../components/button";
import { CodeEditor } from "../components/code-editor";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { Switch } from "../components/switch";
import { Plus, Trash } from "../icons";
import { useDaemon } from "../daemon";
import { showToast } from "../components/toast";
import { errorText, store } from "../onboarding/api";
import { shortPath } from "./add-project";
import { type Project, setProject, useProjects } from "./projects";
import { plural, RemoveProjectHost } from "./remove";
import { daemonSource, type FolderCheck } from "./store";

/*
 * Project settings, the old app's dialog [D171, D178, D202]: Name, Folder, Trust, the ignored files
 * copied into each new worktree, and the setup script. All kept on Brigadier's record, nothing written
 * into the repo [D211]. Trust applies at once; Save closes at once with the change shown, and a refusal opens it
 * again on what was typed, the refused field marked [D30, D1257, D1260].
 */

/** Where the dialog's data comes from: the daemon, or the gallery's Fake. */
export type SettingsSource = {
  pick(at?: string): Promise<string | null>;
  check(path: string): Promise<FolderCheck>;
  /** `projects set <id> …args`, with `change` shown meanwhile; throws Rust's reason. */
  save(project: Project, change: Partial<Project>, args: string[]): Promise<void>;
};

export const daemonSettings: SettingsSource = {
  pick: daemonSource.pick,
  check: daemonSource.check,
  save: setProject,
};

/** A save Rust refused: what was typed, and why. */
export type Refused = { change: Partial<Project>; error: string };

/** As wide as Add project, its sibling, laid out as the app's other dialogs [D1257]. */
export const SETTINGS_FRAME = "project-dialog max-w-add-project gap-4 p-5";

const opened = store<{ id: string; refused?: Refused } | null>(null);
let refusals = 0;
/** Opens Project settings for a project, from its menu. */
export const openProjectSettings = (id: string) => opened.set({ id });

/** Mounted once beside the sidebar, with Remove project…. */
export function ProjectSettingsHost() {
  const open = opened.use();
  const project = useProjects()?.find((each) => each.id === open?.id && !each.pending);
  return (
    <>
    <Dialog open={project !== undefined} onOpenChange={(next) => !next && opened.set(null)}>
      <DialogContent frame={SETTINGS_FRAME}>
        {project && (
          <ProjectSettings
            // A refusal that comes while it's open again shows too.
            key={`${project.id}:${open?.refused ? refusals : 0}`}
            project={project}
            source={daemonSettings}
            refused={open?.refused}
            onClose={() => opened.set(null)}
            // Opened again on what was typed, unless another project's is open by now.
            onRefused={(refused) => {
              if (opened.get() !== null && opened.get()?.id !== project.id) return void showToast(refused.error, { tone: "error" });
              refusals += 1;
              opened.set({ id: project.id, refused });
            }}
          />
        )}
      </DialogContent>
    </Dialog>
    {/* Remove project… mounts here too, so main.tsx is untouched (PROPOSED). */}
    <RemoveProjectHost />
    </>
  );
}

/** A labelled part of the form, its aside beside the label. */
function Field({ label, aside, htmlFor, children }: { label: string; aside?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <label htmlFor={htmlFor} className="shrink-0 text-label font-medium text-foreground">
          {label}
        </label>
        {aside && <span className="text-xs text-muted-foreground">{aside}</span>}
      </div>
      {children}
    </div>
  );
}

export function ProjectSettings({
  project,
  source,
  refused,
  onClose,
  onRefused,
}: {
  project: Project;
  source: SettingsSource;
  /** The last save, refused: shown again as typed, its error on its field. */
  refused?: Refused;
  onClose: () => void;
  onRefused?: (refused: Refused) => void;
}) {
  const id = useId();
  const typed = refused?.change ?? {};
  // Rust's prefix refusal is the only one naming the prefix: it marks that field.
  const prefixRefused = refused && typed.branch_prefix !== undefined && /prefix/i.test(refused.error) ? refused.error : null;
  const [name, setName] = useState(typed.name ?? project.name);
  const [folder, setFolder] = useState(typed.folder ?? project.folder);
  const [folderError, setFolderError] = useState<string | null>(null);
  // Rust refuses a new folder while the project has sessions (D234 P11): don't lead there.
  const sessions = useDaemon().rows?.filter((row) => row.project === project.id).length ?? 0;
  const [files, setFiles] = useState(typed.include ?? project.include);
  const [setup, setSetup] = useState(typed.setup ?? project.setup);
  const [prefix, setPrefix] = useState(typed.branch_prefix ?? project.branch_prefix ?? "brigadier/");
  const [error, setError] = useState<string | null>(refused && !prefixRefused ? refused.error : null);
  const [prefixError, setPrefixError] = useState<string | null>(prefixRefused);

  const change = async () => {
    setFolderError(null);
    try {
      const picked = await source.pick(folder);
      if (!picked) return;
      const check = await source.check(picked);
      if (check.kind === "repo") setFolder(check.repo);
      else setFolderError(check.kind === "invalid" ? check.reason : `${picked} is not in a git repository`);
    } catch (cause) {
      setFolderError(errorText(cause));
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return setError("Name can't be empty.");
    const include = files.map((each) => each.trim()).filter(Boolean);
    const changed: Partial<Project> = {};
    if (name.trim() !== project.name) changed.name = name.trim();
    // A new folder is asked about again [D166].
    if (folder !== project.folder) Object.assign(changed, { folder, trusted: null });
    if (include.join("\n") !== project.include.join("\n")) changed.include = include;
    if (setup !== project.setup) changed.setup = setup;
    if (prefix !== (project.branch_prefix ?? "brigadier/")) changed.branch_prefix = prefix;
    const args = [
      ...(changed.name === undefined ? [] : ["--name", changed.name]),
      ...(changed.folder === undefined ? [] : ["--folder", changed.folder]),
      ...(changed.include === undefined ? [] : ["--include", changed.include.join("\n")]),
      ...(changed.setup === undefined ? [] : ["--setup", changed.setup]),
      ...(changed.branch_prefix === undefined ? [] : ["--branch-prefix", changed.branch_prefix ?? ""]),
    ];
    onClose();
    if (args.length) source.save(project, changed, args).catch((cause) => onRefused?.({ change: changed, error: errorText(cause) }));
  };

  return (
    <form onSubmit={submit} className="flex min-h-0 min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Project settings</DialogTitle>
      </DialogHeader>
      <div className="scroll-gutter -mx-5 flex min-h-0 flex-col gap-5.5 overflow-y-auto ps-5 pe-2.5 py-1">
        <Field label="Name" htmlFor={`${id}-name`}>
          <Input id={`${id}-name`} value={name} autoFocus maxLength={80} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Folder">
          <div className="flex h-control-md items-center gap-2 rounded-capsule bg-fill ps-3.5 pe-1">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{shortPath(folder)}</span>
            <Button variant="ghost" size="sm" disabled={sessions > 0} onClick={() => void change()}>
              Change
            </Button>
          </div>
          {sessions > 0 && <p className="text-xs text-muted-foreground">This project has {plural(sessions, "session", "sessions")}, so its folder can't change.</p>}
          {folder !== project.folder && <p className="text-xs text-muted-foreground">A new folder is asked about trust again.</p>}
          <ErrorLine error={folderError} />
        </Field>
        {folder === project.folder && <TrustRow project={project} source={source} />}
        <Field label="Branch prefix" aside="Starts new session branch names; leave empty for no prefix" htmlFor={`${id}-prefix`}>
          <Input
            id={`${id}-prefix`}
            value={prefix}
            aria-invalid={prefixError !== null}
            onChange={(event) => {
              setPrefix(event.target.value);
              setPrefixError(null);
            }}
          />
          <ErrorLine error={prefixError} />
        </Field>
        <PathRows files={files} onFiles={setFiles} />
        <Field label="Setup script" aside="Runs in each new worktree before its first turn, only while the folder is trusted" htmlFor={`${id}-setup`}>
          <CodeEditor id={`${id}-setup`} value={setup} onChange={setSetup} language="bash" label="Setup script" placeholder="pnpm install" className="h-29 shrink-0 rounded-control bg-fill" />
        </Field>
        <ErrorLine error={error} />
      </div>
      <DialogFooter data-confirm className="shrink-0">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">Save</Button>
      </DialogFooter>
    </form>
  );
}

/** Whether the project's folder is trusted, applied at once; unanswered shows off [D166]. */
function TrustRow({ project, source }: { project: Project; source: SettingsSource }) {
  const id = useId();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-4">
        <div className="flex min-w-0 flex-1 flex-col gap-0.75">
          <label htmlFor={id} className="text-label font-medium text-foreground">
            Trust this folder
          </label>
          <p className="text-xs text-muted-foreground">Agents work here, asking as your permission level says.</p>
        </div>
        <Switch
          id={id}
          checked={project.trusted === true}
          onCheckedChange={(on) => {
            setError(null);
            source.save(project, { trusted: on }, ["--trusted", String(on)]).catch((cause) => setError(errorText(cause)));
          }}
        />
      </div>
      <ErrorLine error={error} />
    </div>
  );
}

/** The old app's: a path a row, typed, with Add file [D178]. */
function PathRows({ files, onFiles }: { files: string[]; onFiles: (files: string[]) => void }) {
  // Only a row just added takes focus, not the last one on open.
  const [added, setAdded] = useState(false);
  return (
    <Field label="Secret files" aside="Git-ignored files copied into every worktree, never shown">
      {files.length > 0 && (
        <ul className="flex flex-col gap-1.5" aria-label="Secret files">
          {files.map((file, index) => (
            <li key={index} className="flex items-center gap-1">
              <Input
                value={file}
                autoFocus={added && index === files.length - 1}
                placeholder=".env.local"
                spellCheck={false}
                aria-label={`Secret file ${index + 1}`}
                className="font-mono"
                onChange={(event) => onFiles(files.map((each, at) => (at === index ? event.target.value : each)))}
              />
              <Button variant="ghost" size="icon-md" aria-label={`Remove ${file || "this file"}`} onClick={() => onFiles(files.filter((_, at) => at !== index))}>
                <Trash />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="self-start"
        onClick={() => {
          setAdded(true);
          onFiles([...files, ""]);
        }}
      >
        <Plus />
        Add file
      </Button>
    </Field>
  );
}
