import { type ReactNode, useEffect, useState } from "react";

import { Button } from "../components/button";
import { CodeEditor } from "../components/code-editor";
import { copyWithToast } from "../components/copy-button";
import { cx } from "../components/cx";
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
import { ArrowUpRight, Copy, FolderOpen, Plus, Trash } from "../icons";
import { Avatar } from "../landing/pr-parts";
import { errorText, run } from "../onboarding/api";
import { openSettings } from "../settings/shell";
import type { Item, Plugins, Scope } from "../settings/plugins";
import { PluginMark } from "../settings/plugins-marks";
import { ProjectBadge } from "../sidebar/row";
import { shortPath } from "./add-project";
import { Group, TabBar } from "./page";
import { type Project, setProject } from "./projects";
import { openRemoveProject, plural } from "./remove";
import { daemonSource, type FolderCheck } from "./store";

/*
 * A project's page's Settings tab [D780, D782]: everything set for one project, as the page's other tabs list their
 * rows: a search and a chip per section, one section shown at a time, a search finding in all [D784 D785]. Each row
 * saves as it changes [D30], Rust's record holding it (nothing written into the repo, D211); a refusal shows its reason
 * under its row. Remove project is last in General, apart.
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
  /** The Plugins library, and a change to where one is on [D2043]. */
  plugins(): Promise<Plugins>;
  setScope(key: string, scope: Scope): Promise<Plugins>;
};

export const daemonSettings: SettingsSource = {
  pick: daemonSource.pick,
  check: daemonSource.check,
  save: setProject,
  accounts: (id, local) => run(["projects", "accounts", id, ...(local ? ["--local"] : [])]) as Promise<GithubAccounts>,
  repos: async (folder) => ((await run(["projects", "inspect", folder])).check?.repos ?? []) as string[],
  plugins: () => run(["plugins"]) as Promise<Plugins>,
  setScope: (key, scope) => run(["plugins", "set", key, JSON.stringify({ scope })]) as Promise<Plugins>,
};

/**
 * The project's repository on GitHub, as Rust reads it [D631]: each account gh keeps for its server, whether it can see
 * the repository, and the one Automatic uses (the first that can). Not on GitHub: no row.
 */
export type GithubAccounts = { github: boolean; ssh?: boolean; repo?: string; auto: string | null; logins: { login: string; sees: boolean | null }[] };

const GROUPS = [
  { value: "general", label: "General" },
  { value: "sessions", label: "New sessions" },
  { value: "accounts", label: "Accounts" },
  { value: "plugins", label: "Plugins" },
] as const;
type GroupKey = (typeof GROUPS)[number]["value"];

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

/** Whether a library item is on in this project: on everywhere, or here by name. */
const onHere = (item: Item, id: string) => item.on && ("all" in item.scope || item.scope.projects.includes(id));

export function ProjectSettings({ project, tone = 0, source }: { project: Project; tone?: number; source: SettingsSource }) {
  const [group, setGroup] = useState<GroupKey>("general");
  const [text, setText] = useState("");
  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [github, setGithub] = useState<GithubAccounts | null>(null);
  const [checking, setChecking] = useState(true);
  const [repos, setRepos] = useState<string[] | null>(null);
  const [plugins, setPlugins] = useState<Plugins | null>(null);
  const [files, setFiles] = useState(project.include);
  const [setup, setSetup] = useState(project.setup);
  useEffect(() => setFiles(project.include), [project.include.join("\n")]);
  useEffect(() => setSetup(project.setup), [project.setup]);
  // Rust refuses a new folder while the project has sessions (D234 P11): don't lead there.
  const sessions = useDaemon().rows?.filter((row) => row.project === project.id).length ?? 0;
  const folderKind = project.kind === "folder";
  // The account row draws from the local read at once; the probed one fills in which accounts can see the repository.
  useEffect(() => {
    let live = true;
    void source.accounts(project.id, true).then((reply) => live && setGithub((now) => now ?? reply), () => {});
    void source
      .accounts(project.id, false)
      .then((reply) => live && setGithub(reply), () => {})
      .finally(() => live && setChecking(false));
    if (folderKind) void source.repos(project.folder).then((list) => live && setRepos(list), () => {});
    void source.plugins().then((page) => live && setPlugins(page), () => {});
    return () => {
      live = false;
    };
  }, [project.id]);

  /** Saves one field at once; Rust's refusal shows under its row and the record stays as it was. */
  const save = (field: string, change: Partial<Project>, args: string[]) => {
    setErrors((now) => ({ ...now, [field]: null }));
    source.save(project, change, args).catch((cause) => setErrors((now) => ({ ...now, [field]: errorText(cause) })));
  };
  const saveFiles = (next: string[]) => {
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
  // On here or not: from everywhere, it stays on in every other project.
  const scopeHere = (item: Item, on: boolean) => {
    const others = plugins!.projects.map((each) => each.id).filter((each) => each !== project.id);
    const now = "all" in item.scope ? [...others, project.id] : item.scope.projects;
    const scope: Scope = on ? { projects: [...now.filter((each) => each !== project.id), project.id] } : { projects: now.filter((each) => each !== project.id) };
    setPlugins({ ...plugins!, items: plugins!.items.map((each) => (each.key === item.key ? { ...each, scope } : each)) });
    setErrors((was) => ({ ...was, [item.key]: null }));
    source.setScope(item.key, scope).then(setPlugins, (cause) => {
      setPlugins({ ...plugins! });
      setErrors((was) => ({ ...was, [item.key]: errorText(cause) }));
    });
  };

  const profiles = useProfiles();
  const fallback = useDefaultProfile();
  const account = project.github_account ?? "";
  const sees = (known: boolean | null) => (known === null ? (checking ? "Checking…" : undefined) : known ? "Can see this repository" : "Can't see this repository");
  const library = plugins?.items.filter((item) => item.on) ?? [];

  // Each group's rows: [key, label, words searched, row].
  const rows: Record<GroupKey, [string, string, ReactNode][]> = {
    general: [
      [
        "name",
        "Name",
        <Row label="Name" line="What the sidebar and this page call it; its icon is the folder's logo, else these initials" error={errors.name}>
          <ProjectBadge id={project.id} name={project.name} tone={tone} />
          <SavedInput aria-label="Name" value={project.name} onSave={(name) => (name.trim() ? save("name", { name: name.trim() }, ["--name", name.trim()]) : setErrors((now) => ({ ...now, name: "Name can't be empty." })))} />
        </Row>,
      ],
      [
        "folder",
        "Folder",
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
        </Row>,
      ],
      ...(folderKind
        ? [
            [
              "repositories",
              "Repositories",
              <Row label="Repositories" line="The repositories in this folder; a session works on its own copies of the ones it needs">
                <span className="min-w-0 truncate text-end text-xs text-muted-foreground" title={repos?.join(", ")}>
                  {repos === null ? "Reading…" : repos.length === 0 ? "None yet" : `${plural(repos.length, "repository", "repositories")} · ${repos.slice(0, 3).join(", ")}${repos.length > 3 ? ` + ${repos.length - 3}` : ""}`}
                </span>
              </Row>,
            ] as [string, string, ReactNode],
          ]
        : []),
    ],
    sessions: [
      [
        "trust",
        "Trust this folder",
        <Row label="Trust this folder" line="Agents work here, asking only as your permission level says; off, every session here asks first" error={errors.trusted}>
          <Switch aria-label="Trust this folder" checked={project.trusted === true} onCheckedChange={(on) => save("trusted", { trusted: on }, ["--trusted", String(on)])} />
        </Row>,
      ],
      [
        "prefix",
        "Branch prefix",
        <Row label="Branch prefix" line="Starts each new session's branch name; leave it empty for none" error={errors.branch_prefix}>
          <SavedInput aria-label="Branch prefix" className="font-mono" placeholder="No prefix" value={project.branch_prefix ?? "brigadier/"} onSave={(prefix) => save("branch_prefix", { branch_prefix: prefix }, ["--branch-prefix", prefix])} />
        </Row>,
      ],
      [
        "secret files",
        "Secret files",
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
        </Row>,
      ],
      [
        "setup script",
        "Setup script",
        <Row wide label="Setup script" line="Runs in each new worktree before its first turn, only while the folder is trusted; saved when you click away" error={errors.setup}>
          <div className="w-full" onBlur={() => setup !== project.setup && save("setup", { setup }, ["--setup", setup])}>
            <CodeEditor value={setup} onChange={setSetup} language="bash" label="Setup script" placeholder="pnpm install" className="h-29 rounded-control bg-fill" />
          </div>
        </Row>,
      ],
    ],
    accounts: [
      ...(github?.github
        ? [
            [
              "github account",
              "GitHub account",
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
              </Row>,
            ] as [string, string, ReactNode],
          ]
        : []),
      [
        "browser profile",
        "Browser profile",
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
        </Row>,
      ],
    ],
    plugins: library.map((item): [string, string, ReactNode] => [
      item.key,
      `${item.name} ${item.description}`,
      <li key={item.key} className="border-b border-divider">
        <div className="flex min-h-14 items-center gap-3 px-2 py-2.5 text-sm">
          <PluginMark item={{ ...item, logo: item.catalog }} />
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="truncate font-medium text-foreground">
              {item.name} <span className="font-normal text-muted-foreground">· {item.kind === "skill" ? "Skill" : "MCP server"}</span>
            </span>
            <span className="truncate text-xs text-muted-foreground">{item.description || item.detail}</span>
            <ErrorLine error={errors[item.key]} />
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{"all" in item.scope ? "In every project" : onHere(item, project.id) ? "Only some projects" : ""}</span>
          <Switch aria-label={`${item.name} in ${project.name}`} checked={onHere(item, project.id)} onCheckedChange={(on) => scopeHere(item, on)} />
        </div>
      </li>,
    ]),
  };

  const words = text.trim().toLowerCase();
  // One section at a time; a search finds across them all, grouped by section [D784 D785].
  const pick = (key: GroupKey) => (words ? rows[key].filter(([, searched]) => searched.toLowerCase().includes(words)) : group === key ? rows[key] : []);
  const count = (key: GroupKey) => rows[key].length;
  const danger = words ? "remove project".includes(words) : group === "general";
  const shown = GROUPS.map((each) => each.value).filter((key) => pick(key).length > 0 || (!words && key === group));
  return (
    <>
      <TabBar search="Search settings…" text={text} onText={setText} label="Settings" chips={GROUPS.map((each) => ({ ...each, count: each.value === "plugins" ? count("plugins") : undefined }))} value={group} onValue={setGroup} />
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        {shown.map((key) => (
          <Group key={key} label={GROUPS.find((each) => each.value === key)!.label}>
            {pick(key).map(([id, , row]) => (
              <Keyed key={id}>{row}</Keyed>
            ))}
            {key === "plugins" && (
              <li className="flex min-h-12 items-center gap-3 px-2 text-xs text-muted-foreground">
                {plugins !== null && library.length === 0 && <span>No MCP servers or skills yet.</span>}
                <Button variant="ghost" size="sm" className="ms-auto" onClick={() => openSettings("plugins")}>
                  Add or manage in Settings › Plugins
                  <ArrowUpRight />
                </Button>
              </li>
            )}
          </Group>
        ))}
        {shown.length === 0 && !danger && <EmptyState variant="centered" title="No matching settings" detail="Try other words." className="pt-24" />}
        {danger && (
          // Apart, last: nothing above it can lose anything [D782].
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
        )}
      </div>
    </>
  );
}

/** A row in a keyed list. */
const Keyed = ({ children }: { children: ReactNode }) => <>{children}</>;
