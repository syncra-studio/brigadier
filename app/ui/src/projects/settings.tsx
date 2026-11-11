import { type FormEvent, type ReactNode, useId, useState } from "react";

import { Button } from "../components/button";
import { CodeEditor } from "../components/code-editor";
import { Dialog, DialogContent, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { Switch } from "../components/switch";
import { Plus, Trash } from "../icons";
import { useDaemon } from "../daemon";
import { errorText, run, store } from "../onboarding/api";
import { shortPath } from "./add-project";
import { type Project, setProject, useProjects } from "./projects";
import { plural, RemoveProjectHost } from "./remove";
import { daemonSource, type FolderCheck } from "./store";

/*
 * Project settings, the old app's dialog [D171, D178, D202]: Name, Folder, Trust, the ignored files
 * copied into each new worktree, and the setup script. All kept on Brigadier's record, nothing written
 * into the repo [D211]. Trust applies at once; the rest on Save, shown at once and kept by Rust [D30].
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

const opened = store<string | null>(null);
/** Opens Project settings for a project, from its menu. */
export const openProjectSettings = (id: string) => opened.set(id);

/** Mounted once beside the sidebar, with Remove project…. */
export function ProjectSettingsHost() {
  const id = opened.use();
  const project = useProjects()?.find((each) => each.id === id && !each.pending);
  return (
    <>
    <Dialog open={project !== undefined} onOpenChange={(open) => !open && opened.set(null)}>
      <DialogContent frame="project-dialog max-w-project-dialog gap-7 p-6">
        {project && <ProjectSettings key={project.id} project={project} source={daemonSettings} onClose={() => opened.set(null)} />}
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
  onClose,
}: {
  project: Project;
  source: SettingsSource;
  onClose: () => void;
}) {
  const id = useId();
  const [name, setName] = useState(project.name);
  const [folder, setFolder] = useState(project.folder);
  const [folderError, setFolderError] = useState<string | null>(null);
  // Rust refuses a new folder while the project has sessions (D234 P11): don't lead there.
  const sessions = useDaemon().rows?.filter((row) => row.project === project.id).length ?? 0;
  const [files, setFiles] = useState(project.include);
  const [setup, setSetup] = useState(project.setup);
  const [prefix, setPrefix] = useState(project.branch_prefix ?? "brigadier/");
  const [error, setError] = useState<string | null>(null);
  const [prefixError, setPrefixError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

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

  const submit = async (event: FormEvent) => {
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
    if (!args.length) return onClose();
    setBusy(true);
    setError(null);
    setPrefixError(null);
    try {
      await source.save(project, changed, args);
      onClose();
    } catch (cause) {
      const text = errorText(cause);
      // Rust's prefix refusal is the only one naming the prefix: it shows under its field.
      if (changed.branch_prefix !== undefined && /prefix/i.test(text)) setPrefixError(text);
      else setError(text);
      setBusy(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} className="flex min-h-0 min-w-0 flex-col gap-7">
      <DialogTitle>Project settings</DialogTitle>
      <div className="scroll-gutter -mx-6 flex min-h-0 flex-col gap-5.5 overflow-y-auto ps-6 pe-3.5 py-1">
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
          <Input id={`${id}-prefix`} value={prefix} onChange={(event) => setPrefix(event.target.value)} />
          <ErrorLine error={prefixError} />
        </Field>
        <PathRows files={files} onFiles={setFiles} />
        <Field label="Setup script" aside="Runs in each new worktree before its first turn, only while the folder is trusted" htmlFor={`${id}-setup`}>
          <CodeEditor id={`${id}-setup`} value={setup} onChange={setSetup} language="bash" label="Setup script" placeholder="pnpm install" className="h-29 shrink-0 rounded-control bg-fill" />
        </Field>
        <ErrorLine error={error} />
      </div>
      <div className="flex shrink-0 justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
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
