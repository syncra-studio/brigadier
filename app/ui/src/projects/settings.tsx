import { type ReactNode, useEffect, useState } from "react";

import { Button } from "../components/button";
import { CodeEditor } from "../components/code-editor";
import { copyWithToast } from "../components/copy-button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Input } from "../components/input";
import { Select } from "../components/select";
import { Switch } from "../components/switch";
import { showToast } from "../components/toast";
import { ProfileDisc } from "../browser/profile-mark";
import { useDefaultProfile, useProfiles } from "../browser/profiles";
import { useDaemon } from "../daemon";
import { Copy, FolderOpen, Plus, Trash } from "../icons";
import { Avatar } from "../landing/pr-parts";
import { errorText, run } from "../onboarding/api";
import { ProjectBadge } from "../sidebar/row";
import { shortPath } from "./add-project";
import { type Project, setProject } from "./projects";
import { openRemoveProject, plural } from "./remove";
import { daemonSource, type FolderCheck } from "./store";

/*
 * A project's page, its settings [D176 D780 D782]: everything set for one project in one list, no Plugins (Settings › Plugins, D185),
 * no search or Open on GitHub [D259]. Each row saves as it changes [D30], Rust's record holding it (nothing written into the repo, D211); a refusal shows its reason
 * under its row. Remove project is last, apart.
 */

/** Where the tab's data comes from: the daemon, or the gallery's Fake. */
export type SettingsSource = {
  pick(at?: string): Promise<string | null>;
  check(path: string): Promise<FolderCheck>;
  /** `projects set <id> …args`, with `change` shown meanwhile; throws Rust's reason. */
  save(project: Project, change: Partial<Project>, args: string[]): Promise<void>;
  /** `projects accounts <id>`: `local` reads no network, so its `sees` and `auto` are null [D631]. */
  accounts(id: string, local: boolean): Promise<GithubAccounts>;
  /** A folder of repositories' repositories, by path from its top [D494]. */
  repos(folder: string): Promise<string[]>;
};

export const daemonSettings: SettingsSource = {
  pick: daemonSource.pick,
  check: daemonSource.check,
  save: setProject,
  accounts: (id, local) => run(["projects", "accounts", id, ...(local ? ["--local"] : [])]) as Promise<GithubAccounts>,
  repos: async (folder) => ((await run(["projects", "inspect", folder])).check?.repos ?? []) as string[],
};

/**
 * The project's repository on GitHub, as Rust reads it [D631]: each account gh keeps for its server, whether it can see
 * the repository, and the one Automatic uses (the first that can). Not on GitHub: no row.
 */
export type GithubAccounts = { github: boolean; ssh?: boolean; repo?: string; auto: string | null; logins: { login: string; sees: boolean | null }[] };

/** One setting, as the page's rows: its name over one plain line, its control at the end, or under it when `wide`. */
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

/** A text that saves when you leave it or press Enter; Escape puts the saved one back. */
function SavedInput({ value, onSave, ...props }: { value: string; onSave: (value: string) => void; placeholder?: string; "aria-label": string; className?: string }) {
  const [typed, setTyped] = useState(value);
  useEffect(() => setTyped(value), [value]);
  return (
    <Input
      {...props}
      value={typed}
      spellCheck={false}
      onChange={(event) => setTyped(event.target.value)}
      onBlur={() => typed !== value && onSave(typed)}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") setTyped(value);
      }}
    />
  );
}

const Login = ({ login, before = "" }: { login: string; before?: string }) => (
  <span className="flex min-w-0 items-center gap-2">
    <Avatar login={login} size="size-4" />
    <span className="truncate">
      {before}@{login}
    </span>
  </span>
);

const Profile = ({ name, hue, before = "" }: { name: string; hue: number; before?: string }) => (
  <span className="flex min-w-0 items-center gap-2">
    <ProfileDisc profile={{ name, hue }} size="sm" />
    <span className="truncate">
      {before}
      {name}
    </span>
  </span>
);

export function ProjectSettings({ project, tone = 0, source }: { project: Project; tone?: number; source: SettingsSource }) {
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [github, setGithub] = useState<GithubAccounts | null>(null);
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
  // The account row draws from the local read at once; the probed one fills in which accounts can see the repository.
  // Read again for a new folder, and on reconnecting after a failed read.
  useEffect(() => {
    let live = true;
    setGithub(null);
    setRepos(null);
    setErrors((now) => ({ ...now, repos: null }));
    const failed = (field: string) => (cause: unknown) => live && setErrors((now) => ({ ...now, [field]: errorText(cause) }));
    void source.accounts(project.id, true).then((reply) => live && setGithub((now) => now ?? reply), () => {});
    void source
      .accounts(project.id, false)
      .then((reply) => live && setGithub(reply), () => {})
      .finally(() => live && setChecking(false));
    if (folderKind) void source.repos(project.folder).then((list) => live && setRepos(list), failed("repos"));
    return () => {
      live = false;
    };
  }, [project.id, project.folder, folderKind, daemon]);

  /** Saves one field at once; Rust's refusal shows under its row and the record stays as it was. */
  const save = (field: string, change: Partial<Project>, args: string[]) => {
    setErrors((now) => ({ ...now, [field]: null }));
    source.save(project, change, args).catch((cause) => setErrors((now) => ({ ...now, [field]: errorText(cause) })));
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
      // A new folder is asked about trust again [D166].
      if (check.kind === "repo" || check.kind === "folder") save("folder", { folder: check.kind === "repo" ? check.repo : picked, trusted: null }, ["--folder", check.kind === "repo" ? check.repo : picked]);
      else setErrors((now) => ({ ...now, folder: check.kind === "invalid" ? check.reason : `${picked} is not in a git repository` }));
    } catch (cause) {
      setErrors((now) => ({ ...now, folder: errorText(cause) }));
    }
  };
  const profiles = useProfiles();
  const fallback = useDefaultProfile();
  const account = project.github_account ?? "";
  const sees = (known: boolean | null) => (known === null ? (checking ? "Checking…" : undefined) : known ? "Can see this repository" : "Can't see this repository");

  // Drawn once the account read lands, so the GitHub account row doesn't push the page down [D257].
  if (!github && checking) return null;
  return (
    <div className="scroll-gutter min-h-0 flex-1 overflow-y-auto px-5 py-6">
      <ul aria-label="General">
        <Row label="Name" line="What the sidebar and this page call it; its icon is the folder's logo, else these initials" error={errors.name}>
          <ProjectBadge id={project.id} name={project.name} tone={tone} />
          <SavedInput aria-label="Name" value={project.name} onSave={(name) => (name.trim() ? save("name", { name: name.trim() }, ["--name", name.trim()]) : setErrors((now) => ({ ...now, name: "Name can't be empty." })))} />
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
        {github?.github && (
        <Row label="GitHub account" line={github.ssh && account ? `Its pull requests and sessions use it; pushes over SSH use your SSH key` : "Its pull requests and sessions use it"} error={errors.github_account}>
          <Select
            label="GitHub account"
            value={account}
            align="end"
            className="w-full"
            onChange={(login) => save("github_account", { github_account: login || null }, ["--github-account", login])}
            options={[
              {
                value: "",
                label: "Automatic",
                shown: github.auto ? <Login login={github.auto} before="Automatic · " /> : "Automatic",
                hint: github.auto ? `@${github.auto}, the account that can see ${github.repo}` : checking ? "Checking…" : `None of your accounts can see ${github.repo}`,
              },
              ...github.logins.map(({ login, sees: known }) => ({ value: login, label: <Login login={login} />, hint: sees(known) })),
              // A pick gh has since signed out of stays shown, so it can be seen and changed.
              ...(account && !github.logins.some((each) => each.login === account) ? [{ value: account, label: <Login login={account} />, hint: "Not signed in to gh" }] : []),
            ]}
          />
        </Row>
        )}
        <Row label="Browser profile" line="Its sessions' browser tabs open signed in as this profile; a tab can still switch" error={errors.browser_profile}>
          <Select
            label="Browser profile"
            // A deleted profile is Automatic, as Rust resolves it [D769].
            value={profiles.some((each) => each.id === project.browser_profile) ? project.browser_profile! : ""}
            align="end"
            className="w-full"
            onChange={(id) => save("browser_profile", { browser_profile: id || null }, ["--browser-profile", id])}
            options={[
              { value: "", label: "Automatic", shown: <Profile {...fallback} before="Automatic · " />, hint: `${fallback.name}, the default profile` },
              ...profiles.map((each) => ({ value: each.id, label: <Profile {...each} /> })),
            ]}
          />
        </Row>
        <Row label="Trust this folder" line="Agents work here, asking only as your permission level says; off, every session here asks first" error={errors.trusted}>
          <Switch aria-label="Trust this folder" checked={project.trusted === true} onCheckedChange={(on) => save("trusted", { trusted: on }, ["--trusted", String(on)])} />
        </Row>
        <Row label="Branch prefix" line="Starts each new session's branch name; leave it empty for none" error={errors.branch_prefix}>
          <SavedInput aria-label="Branch prefix" className="font-mono" placeholder="No prefix" value={project.branch_prefix ?? "brigadier/"} onSave={(prefix) => save("branch_prefix", { branch_prefix: prefix }, ["--branch-prefix", prefix])} />
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
          <div className="w-full" onBlur={() => setup !== project.setup && save("setup", { setup }, ["--setup", setup])}>
            <CodeEditor value={setup} onChange={setSetup} language="bash" label="Setup script" placeholder="pnpm install" className="h-29 rounded-control bg-fill" />
          </div>
        </Row>
      </ul>
      {/* Apart, last: nothing above it can lose anything [D782]. */}
      <section className="mt-10 rounded-control border border-destructive-border p-1">
        <ul aria-label="Remove project">
          <li className="flex min-h-12 items-center gap-6 px-2 py-2.5 text-sm">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium text-foreground">Remove project</span>
              <span className="text-xs text-muted-foreground">Takes it and its sessions out of Brigadier; the folder{folderKind ? " and its repositories stay" : " stays"}, with branches that hold unmerged work asked about first</span>
            </div>
            <Button variant="soft-destructive" size="sm" onClick={() => openRemoveProject(project.id)}>
              <Trash />
              Remove project…
            </Button>
          </li>
        </ul>
      </section>
    </div>
  );
}
