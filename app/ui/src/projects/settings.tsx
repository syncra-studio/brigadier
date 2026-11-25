import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { CodeEditor } from "../components/code-editor";
import { copyWithToast } from "../components/copy-button";
import { cx } from "../components/cx";
import { Dialog, DialogContent, DialogTitle } from "../components/dialog";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Input } from "../components/input";
import { Select } from "../components/select";
import { Switch } from "../components/switch";
import { showToast } from "../components/toast";
import { ProfileDisc } from "../browser/profile-mark";
import { useDefaultProfile, useProfiles } from "../browser/profiles";
import { useDaemon } from "../daemon";
import { Copy, Folder, FolderOpen, Plus, Trash } from "../icons";
import { Avatar } from "../landing/pr-parts";
import { errorText, run } from "../onboarding/api";
import { shortPath } from "./add-project";
import { IconPicker } from "./icon-picker";
import { type Project, setProject, useProjects } from "./projects";
import { openRemoveProject, plural } from "./remove";
import { closeProject, daemonSource, type FolderCheck, useProjectSettings } from "./store";

/*
 * A project's settings, a dialog over the page in front [D176 D780 D782]: everything set for one project in one list, no Plugins (Settings › Plugins, D185),
 * no search or Open on GitHub [D259]. Each row saves as it changes [D30], Rust's record holding it (nothing written into the repo, D211); a refusal shows its reason
 * under its row. Remove project is last, apart.
 */

/** Where its data comes from: the daemon, or the gallery's Fake. */
export type SettingsSource = {
  pick(at?: string): Promise<string | null>;
  check(path: string): Promise<FolderCheck>;
  /** `projects set <id> …args`, with `change` shown meanwhile; throws Rust's reason. */
  save(project: Project, change: Partial<Project>, args: string[]): Promise<void>;
  /** `projects accounts <id>`: asks GitHub again; what it finds lands in the project's record [D631]. */
  accounts(id: string): Promise<unknown>;
  /** A folder of repositories' repositories, by path from its top [D494]. */
  repos(folder: string): Promise<string[]>;
};

export const daemonSettings: SettingsSource = {
  pick: daemonSource.pick,
  check: daemonSource.check,
  save: setProject,
  accounts: (id) => run(["projects", "accounts", id]),
  repos: async (folder) => ((await run(["projects", "inspect", folder])).check?.repos ?? []) as string[],
};

/** One setting, as the dialog's rows: its name over one plain line, its control at the end, or under it when `wide`. */
function Row({ label, line, error, wide = false, children }: { label: string; line: ReactNode; error?: string | null; wide?: boolean; children: ReactNode }) {
  return (
    <li className="border-b border-divider">
      <div className={cx("flex min-h-12 gap-x-6 gap-y-2.5 px-2 py-2.5 text-sm", wide ? "flex-col" : "items-center")}>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="font-medium text-foreground">{label}</span>
          <span className="text-xs text-muted-foreground">{line}</span>
          <ErrorLine error={error} />
        </div>
        <div className={cx("flex min-w-0 items-center gap-2", wide ? "w-full" : "w-80 shrink-0 justify-end")}>{children}</div>
      </div>
    </li>
  );
}

/** A text that saves when you leave it or press Enter; Escape puts the saved one back. `onBack`: it's the saved one again. */
function SavedInput({ value, onSave, onBack, ...props }: { value: string; onSave: (value: string) => void; onBack: () => void; placeholder?: string; "aria-label": string; className?: string }) {
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);
  return (
    <Input
      {...props}
      value={typed}
      spellCheck={false}
      onChange={(event) => setTyped(event.target.value)}
      onBlur={() => (typed === value ? onBack() : onSave(typed))}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        escape(event, typed !== value, () => {
          setTyped(value);
          onBack();
        });
      }}
    />
  );
}

/** Esc puts a changed field's saved text back; the dialog closes on the next one. */
function escape(event: KeyboardEvent, changed: boolean, back: () => void) {
  if (event.key !== "Escape" || event.nativeEvent.isComposing || !changed) return;
  event.stopPropagation();
  back();
}

/** Mounted once beside the sidebar; opened by `openProject` from anywhere. */
export function ProjectSettingsHost() {
  const { open, id } = useProjectSettings();
  const projects = useProjects();
  const project = projects?.find((each) => each.id === id && !each.pending);
  // Going to another page leaves it, as ⌘, and ⌘K's picks do.
  useEffect(() => {
    const leave = () => closeProject();
    addEventListener("hashchange", leave);
    return () => removeEventListener("hashchange", leave);
  }, []);
  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeProject()}>
      <DialogContent frame="project-dialog max-w-wide-dialog gap-0 p-0">
        <DialogTitle className="shrink-0 truncate ps-6 pe-12 pt-6 pb-5 leading-tight">{project ? `${project.name} settings` : "Project settings"}</DialogTitle>
        {project ? (
          <ProjectSettings key={id} project={project} source={daemonSettings} />
        ) : (
          projects && <EmptyState variant="centered" icon={Folder} title="This project isn’t available" detail="Brigadier has no project by this name. Pick another in the sidebar." className="m-auto py-16" />
        )}
      </DialogContent>
    </Dialog>
  );
}

const Login = ({ login }: { login: string }) => (
  <span className="flex min-w-0 items-center gap-2">
    <Avatar login={login} size="size-4" />
    <span className="truncate">@{login}</span>
  </span>
);

const Profile = ({ name, hue }: { name: string; hue: number }) => (
  <span className="flex min-w-0 items-center gap-2">
    <ProfileDisc profile={{ name, hue }} size="sm" />
    <span className="truncate">{name}</span>
  </span>
);

export function ProjectSettings({ project, source }: { project: Project; source: SettingsSource }) {
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [checking, setChecking] = useState(true);
  const [repos, setRepos] = useState<string[] | null>(null);
  const [files, setFiles] = useState(project.include);
  const [setup, setSetup] = useState(project.setup);
  useEffect(() => setFiles(project.include), [project.include.join("\n")]);
  useEffect(() => setSetup(project.setup), [project.setup]);
  // Rust refuses a new folder while the project has sessions (D234 P11): don't lead there.
  const { daemon, rows: all } = useDaemon();
  const sessions = all?.filter((row) => row.project === project.id).length ?? 0;
  const folderKind = project.kind === "folder";
  // The record draws at once; GitHub is asked again behind it, for a new folder and on reconnecting too.
  useEffect(() => {
    let live = true;
    setChecking(true);
    setRepos(null);
    setErrors((now) => ({ ...now, repos: null }));
    const failed = (field: string) => (cause: unknown) => live && setErrors((now) => ({ ...now, [field]: errorText(cause) }));
    void source.accounts(project.id).then(
      () => live && setChecking(false),
      () => live && setChecking(false),
    );
    if (folderKind) void source.repos(project.folder).then((list) => live && setRepos(list), failed("repos"));
    return () => {
      live = false;
    };
  }, [project.id, project.folder, folderKind, daemon]);

  // Clicking outside both saves a field and closes the dialog: what was refused is then said in a toast.
  const refused = useRef<Record<string, string>>({});
  const here = useRef(true);
  const say = (why: string) => showToast(`Couldn't save ${project.name}'s settings: ${why}`, { tone: "error" });
  useEffect(() => {
    here.current = true;
    return () => {
      here.current = false;
      Object.values(refused.current).forEach(say);
    };
  }, []);
  const refuse = (field: string, why: string) => {
    if (!here.current) return say(why);
    refused.current[field] = why;
    setErrors((now) => ({ ...now, [field]: why }));
  };
  const clear = (field: string) => {
    delete refused.current[field];
    setErrors((now) => ({ ...now, [field]: null }));
  };
  /** Saves one field at once; Rust's refusal shows under its row and the record stays as it was. */
  const save = (field: string, change: Partial<Project>, args: string[]) => {
    clear(field);
    source.save(project, change, args).catch((cause) => refuse(field, errorText(cause)));
  };
  const saveFiles = (next: string[]) => {
    setFiles(next);
    const include = next.map((each) => each.trim()).filter(Boolean);
    if (include.join("\n") !== project.include.join("\n")) save("include", { include }, ["--include", include.join("\n")]);
  };
  const changeFolder = async () => {
    setErrors((now) => ({ ...now, folder: null }));
    try {
      const picked = await source.pick(project.folder);
      if (!picked) return;
      const check = await source.check(picked);
      // A new folder is asked about trust again [D166], its account found again.
      if (check.kind === "repo" || check.kind === "folder") save("folder", { folder: check.kind === "repo" ? check.repo : picked, trusted: null, github_account: null, github: null }, ["--folder", check.kind === "repo" ? check.repo : picked]);
      else setErrors((now) => ({ ...now, folder: check.kind === "invalid" ? check.reason : `${picked} is not in a git repository` }));
    } catch (cause) {
      setErrors((now) => ({ ...now, folder: errorText(cause) }));
    }
  };
  const profiles = useProfiles();
  const fallback = useDefaultProfile();
  const github = project.github;
  const account = project.github_account ?? "";
  const logins = github?.logins ?? [];
  // A folder's several repositories are seen together; one is in a single repository's words.
  const several = github?.of && github.of.length > 1 ? `all ${github.of.length} repositories` : null;
  const on = github?.host ? ` on ${github.host}` : "";
  const sees = (known: boolean | null) => (known === null ? (checking ? "Checking…" : undefined) : `${known ? "Can" : "Can't"} see ${several ? several + on : "this repository"}`);
  const used = `${several ? `Pull requests and sessions in ${several}` : "Its pull requests and sessions"}${on} use it`;

  const showGithub = github?.github ?? Boolean(account);
  // If its GitHub facts arrive after opening Settings, add the row below the existing controls.
  const [githubAtTop] = useState(showGithub);
  const githubRow = showGithub && (
    <Row label="GitHub account" line={github?.ssh ? `${used}; pushes over SSH use your SSH key` : used} error={errors.github_account}>
      <Select
        label="GitHub account"
        value={account}
        disabled={!account && logins.length === 0}
        align="end"
        className="w-full"
        placeholder={checking && logins.some((each) => each.sees === null) ? "Checking…" : "Choose an account"}
        onChange={(login) => save("github_account", { github_account: login }, ["--github-account", login])}
        options={[
          ...logins.map(({ login, sees: known }) => ({ value: login, label: <Login login={login} />, hint: sees(known) })),
          // A pick gh has since signed out of stays shown, so it can be seen and changed.
          ...(account && !logins.some((each) => each.login === account) ? [{ value: account, label: <Login login={account} />, hint: github ? "Not signed in to gh" : undefined }] : []),
        ]}
      />
    </Row>
  );

  return (
    <div className="scroll-gutter min-h-0 flex-1 overflow-y-auto border-t border-divider ps-6 pe-3.5 pb-6">
      <ul aria-label="General">
        <Row label="Name" line={project.icon ? "What the sidebar calls it; click its icon to change it" : "What the sidebar calls it; its icon is the folder's logo, else these initials — click it to pick another"} error={errors.name ?? errors.icon}>
          {/* An image shows once Rust has copied it in; a colour or emoji at once [D30]. */}
          <IconPicker id={project.id} name={project.name} icon={project.icon} onChange={(icon) => save("icon", icon.startsWith("image:") ? {} : { icon: icon || null }, ["--icon", icon])} />
          <SavedInput aria-label="Name" value={project.name} onSave={(name) => (name.trim() ? save("name", { name: name.trim() }, ["--name", name.trim()]) : refuse("name", "Name can't be empty."))} onBack={() => clear("name")} />
        </Row>
        <Row label="Folder" line={sessions > 0 ? `Where it is on this Mac; it has ${plural(sessions, "session", "sessions")}, so it can't move` : "Where it is on this Mac; a new folder is asked about trust again"} error={errors.folder}>
          <span className="min-w-0 flex-1 truncate text-end font-mono text-xs text-foreground">{shortPath(project.folder)}</span>
          <TooltipIconButton tooltip="Reveal in Finder" size="icon-sm" onClick={() => void run(["projects", "reveal", project.id]).catch((cause) => showToast(`Couldn't reveal ${project.name}: ${errorText(cause)}`, { tone: "error" }))}>
            <FolderOpen />
          </TooltipIconButton>
          <TooltipIconButton tooltip="Copy path" size="icon-sm" onClick={() => copyWithToast(project.folder, "path")}>
            <Copy />
          </TooltipIconButton>
          <Button variant="outline" size="sm" disabled={sessions > 0} onClick={() => void changeFolder()}>
            Change
          </Button>
        </Row>
        {folderKind && (
        <Row label="Repositories" line="The repositories in this folder; a session works on its own copies of the ones it needs" error={errors.repos}>
          <span className="min-w-0 truncate text-end text-xs text-muted-foreground" title={repos?.join(", ")}>
            {repos === null ? (errors.repos ? "" : "Reading…") : repos.length === 0 ? "None yet" : `${plural(repos.length, "repository", "repositories")} · ${repos.slice(0, 3).join(", ")}${repos.length > 3 ? ` + ${repos.length - 3}` : ""}`}
          </span>
        </Row>
        )}
        {githubAtTop && githubRow}
        <Row label="Browser profile" line="Its sessions' browser tabs open signed in as this profile; a tab can still switch" error={errors.browser_profile}>
          <Select
            label="Browser profile"
            // One that's gone is the default, as Rust resolves it [D769].
            value={profiles.some((each) => each.id === project.browser_profile) ? project.browser_profile! : fallback.id}
            align="end"
            className="w-full"
            onChange={(id) => save("browser_profile", { browser_profile: id }, ["--browser-profile", id])}
            options={profiles.map((each) => ({ value: each.id, label: <Profile {...each} /> }))}
          />
        </Row>
        <Row label="Trust this folder" line="Agents work here, asking only as your permission level says; off, every session here asks first" error={errors.trusted}>
          <Switch aria-label="Trust this folder" checked={project.trusted === true} onCheckedChange={(on) => save("trusted", { trusted: on }, ["--trusted", String(on)])} />
        </Row>
        <Row label="Branch prefix" line="Starts each new session's branch name; leave it empty for none" error={errors.branch_prefix}>
          <SavedInput aria-label="Branch prefix" className="font-mono" placeholder="No prefix" value={project.branch_prefix ?? "brigadier/"} onSave={(prefix) => save("branch_prefix", { branch_prefix: prefix }, ["--branch-prefix", prefix])} onBack={() => clear("branch_prefix")} />
        </Row>
        <Row wide label="Secret files" line="Git-ignored files, such as .env.local, copied into every new session's worktree and never shown" error={errors.include}>
          <div className="flex w-full flex-col gap-1.5">
            {files.map((file, index) => (
              <div key={index} className="flex items-center gap-1">
                <Input
                  value={file}
                  placeholder=".env.local"
                  spellCheck={false}
                  aria-label={`Secret file ${index + 1}`}
                  className="font-mono"
                  onChange={(event) => setFiles(files.map((each, at) => (at === index ? event.target.value : each)))}
                  onBlur={() => saveFiles(files)}
                  onKeyDown={(event) => escape(event, files.join("\n") !== project.include.join("\n"), () => setFiles(project.include))}
                />
                <TooltipIconButton tooltip={`Remove ${file || "this file"}`} size="icon-md" onClick={() => saveFiles(files.filter((_, at) => at !== index))}>
                  <Trash />
                </TooltipIconButton>
              </div>
            ))}
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setFiles([...files, ""])}>
              <Plus />
              Add file
            </Button>
          </div>
        </Row>
        <Row wide label="Setup script" line="Runs in each new worktree before its first turn, only while the folder is trusted; saved when you click away" error={errors.setup}>
          <div className="w-full" onBlur={() => setup !== project.setup && save("setup", { setup }, ["--setup", setup])} onKeyDown={(event) => escape(event, setup !== project.setup, () => setSetup(project.setup))}>
            <CodeEditor value={setup} onChange={setSetup} language="bash" label="Setup script" placeholder="pnpm install" className="h-29 rounded-control bg-fill" />
          </div>
        </Row>
        {!githubAtTop && githubRow}
      </ul>
      {/* Apart, last: nothing above it can lose anything [D782]. */}
      <section className="mt-10 rounded-control border border-destructive-border p-1">
        <ul aria-label="Remove project">
          <li className="flex min-h-12 items-center gap-6 px-2 py-2.5 text-sm">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium text-foreground">Remove project</span>
              <span className="text-xs text-muted-foreground">Takes it and its sessions out of Brigadier; the folder{folderKind ? " and its repositories stay" : " stays"}, with branches that hold unmerged work asked about first</span>
            </div>
            <Button variant="soft-destructive" size="sm" onClick={() => void openRemoveProject(project.id).then(() => closeProject(project.id))}>
              <Trash />
              Remove project…
            </Button>
          </li>
        </ul>
      </section>
    </div>
  );
}
