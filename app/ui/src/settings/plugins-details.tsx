import { type ReactNode, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { copyWithToast, CopyButton } from "../components/copy-button";
import { ErrorLine } from "../components/error-line";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { Radio, RadioGroup } from "../components/radio";
import { RowText, SettingsCard } from "../components/settings-card";
import { Switch } from "../components/switch";
import { Copy, DotsHorizontal, Eye, Folder, Globe, Spinner, Trash } from "../icons";
import { errorText } from "../onboarding/api";
import { SettingsPage, SettingsSection } from "./parts";
import { InstallDialog } from "./plugins-dialogs";
import { AgentTile, PluginMark } from "./plugins-marks";
import { type Entry, type Item, type Kind, type PluginActions, type Plugins, type Scope, STATUS } from "./plugins";

/** A device sign-in's one-time code and the page it's entered on (GitHub's). */
export type Device = { code: string; page: string };

const KIND_LABEL = { server: "MCP server", skill: "Skill" } as const;

/** Information's two columns: what, then its value. */
export function Information({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <SettingsSection title="Information" setting="Information">
      <div className="flex flex-col gap-2.5 text-label">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center">
            <span className="w-40 shrink-0 text-quiet-foreground">{label}</span>
            <span className="min-w-0 flex-1">{value}</span>
          </div>
        ))}
      </div>
    </SettingsSection>
  );
}

/** Every agent that gets it, by mark and name: on an item's page, all of them [D579]. */
export function WorksWith({ agents, marks }: { agents: string[]; marks: Record<string, string | null> }) {
  return (
    <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
      {agents.map((agent) => (
        <span key={agent} className="flex items-center gap-1.5">
          <AgentTile agent={agent} mark={marks[agent]} />
          {agent}
        </span>
      ))}
    </span>
  );
}

/**
 * One item's page, the same for every state [D574, D579]: a catalog entry not yet installed has Install; an installed
 * one its … (copy, Remove), its switch, and Sign in (spinning while the browser's open) or Sign out for a server
 * Brigadier signs in to, and where it's on. Then what it includes, and its information.
 */
export function DetailsPage({
  value,
  item,
  entry,
  marks,
  actions,
  onInstall,
  onScope,
  onSwitch,
  onRemove,
  onView,
}: {
  value: Plugins;
  /** The library's; none for a catalog entry not installed. */
  item?: Item;
  entry?: Entry;
  marks: Record<string, string | null>;
  actions: PluginActions;
  onInstall: () => void;
  onScope: (scope: Scope) => void;
  onSwitch: (on: boolean) => void;
  onRemove: () => void;
  /** View [D582]: `key` an item or `skillset:<id>`, `at` the skill shown first. */
  onView: (key: string, kind: Kind, at?: string) => void;
}) {
  const kind = item?.kind ?? entry!.kind;
  const name = entry?.name ?? item!.name;
  const detail = item?.detail ?? entry?.url ?? "";
  const mark = { kind, name, detail, logo: entry?.id ?? item?.catalog };
  const some = item && "projects" in item.scope ? item.scope.projects : null;
  const toggle = (id: string, on: boolean) => onScope({ projects: on ? [...some!, id] : some!.filter((each) => each !== id) });
  const first = kind === "skill" ? "Folder" : /^[a-z]+:\/\//.test(detail) ? "Address" : "Command";
  const [signIn, setSignIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const signedIn = item?.signed_in === true;
  const signOut = () => {
    setLeaving(true);
    setError(null);
    actions
      .signOut(item!.key)
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setLeaving(false));
  };
  const link = (label: string, url: string) => (
    <Button variant="ghost" size="icon-xs" aria-label={label} title={url} onClick={() => window.brigadier?.openLink(url)}>
      <Globe aria-hidden />
    </Button>
  );
  const info: [string, ReactNode][] = [];
  if (entry) info.push(["Category", entry.category], ["Developer", entry.maker]);
  if (item?.sign_in) info.push(["Sign-in", item.sign_in === "brigadier" ? "Once in Brigadier, for every agent" : "Signed in by each agent"]);
  if (entry?.website) info.push(["Website", link("Open website", entry.website)]);
  if (entry?.privacy) info.push(["Privacy Policy", link("Open privacy policy", entry.privacy)]);
  const agents = item ? item.agents : Object.keys(marks);
  if (agents.length) info.push(["Works with", <WorksWith agents={agents} marks={marks} />]);
  if (detail)
    info.push([
      first,
      <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
        <span className="break-all">{detail}</span>
        <CopyButton text={detail} size="icon-xs" className="text-muted-foreground" />
      </span>,
    ]);
  // What it brings: itself, and a service's skills [D572].
  // Once installed, a row opens View: the item itself, or its service's skills with that one first.
  const includes = [
    { name, line: [KIND_LABEL[kind], item?.description || entry?.line].filter(Boolean).join(" · "), mark, view: item && (() => onView(item.with ? `skillset:${item.with}` : item.key, kind, item.name)) },
    ...(kind === "server" ? (entry?.skills ?? []) : []).map((skill) => ({
      name: skill.name,
      line: `Skill · ${skill.line}`,
      mark: { kind: "skill", name: skill.name, detail: "" },
      view: item && value.items.some((each) => each.with === entry!.id) ? () => onView(`skillset:${entry!.id}`, "skill", skill.skill) : undefined,
    })),
  ];
  return (
    <>
      <SettingsPage
        title={name}
        description={entry ? `By ${entry.maker} · ${entry.line}` : `${KIND_LABEL[kind]} · ${item!.description || detail.replace(/^https:\/\//, "")}`}
        mark={<PluginMark item={mark} large />}
        actions={
          !item ? (
            <Button size="sm" onClick={onInstall}>
              Install
            </Button>
          ) : (
          <span className="flex items-center gap-3">
            {item.status === "cant_reach" && <Badge variant={STATUS.cant_reach.variant}>{STATUS.cant_reach.label}</Badge>}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-md" aria-label="More" />}>
                <DotsHorizontal aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onView(item.with || item.set ? `skillset:${item.with ?? item.set}` : item.key, item.kind, item.name)}>
                  <Eye aria-hidden />
                  View
                </DropdownMenuItem>
                {entry?.website && (
                  <DropdownMenuItem onClick={() => window.brigadier?.openLink(entry.website!)}>
                    <Globe aria-hidden />
                    Open website
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => copyWithToast(item.detail, first.toLowerCase())}>
                  <Copy aria-hidden />
                  Copy {item.kind === "skill" ? "folder path" : first.toLowerCase()}
                </DropdownMenuItem>
                {/* A server found on this machine follows the agent's settings: it's switched off, not removed [D721]. */}
                {(item.kind === "skill" || !item.from) && (
                  <DropdownMenuItem variant="destructive" onClick={onRemove}>
                    <Trash aria-hidden />
                    Remove
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            {/* The same switch as its card's in the list [D443]. */}
            <Switch aria-label={item.name} checked={item.on} onCheckedChange={onSwitch} />
            {item.sign_in === "brigadier" &&
              (signedIn ? (
                <Button variant="ghost" size="sm" disabled={leaving} onClick={signOut}>
                  Sign out
                </Button>
              ) : (
                <Button size="sm" disabled={signIn} onClick={() => setSignIn(true)}>
                  {signIn && <Spinner aria-hidden className="animate-spin motion-reduce:animate-none" />}
                  Sign in
                </Button>
              ))}
          </span>
          )
        }
      >
        {entry && <p className="text-label">{entry.about}</p>}
        {(item?.note || error) && (
          <div className="-mt-5 flex flex-col gap-2">
            {item?.note && <p className="text-xs text-quiet-foreground">{item.note}</p>}
            <ErrorLine error={error} />
          </div>
        )}
        {item && (
        <SettingsSection title="Projects" description="Where it's on. New sessions pick up changes." setting="Projects">
          <RadioGroup
            aria-label="Where it's on"
            value={some ? "some" : "all"}
            onValueChange={(next) => (next === "all" ? onScope({ all: true }) : value.projects.length > 0 && onScope({ projects: value.projects.map((project) => project.id) }))}
          >
            <SettingsCard>
              <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
                <Radio value="all" className="mt-0.5" />
                <RowText title="All projects" line="On in every project, and in new ones you add." />
              </label>
              {/* From All projects, it starts on in each project: nothing changes until one is turned off. */}
              <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
                <Radio value="some" disabled={value.projects.length === 0} className="mt-0.5" />
                <RowText title="Only some projects" line="On only in the projects you pick." />
              </label>
            </SettingsCard>
          </RadioGroup>
          {some && value.projects.length > 0 && (
            <SettingsCard>
              {value.projects.map((project) => {
                const on = some.includes(project.id);
                return (
                  <div key={project.id} data-slot="project-switch" className="flex items-center gap-3 px-4 py-3">
                    <Folder aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
                    <RowText title={project.name} />
                    {/* It stays on somewhere: the last project on can't be turned off. */}
                    <Switch aria-label={project.name} checked={on} disabled={on && some.length === 1} onCheckedChange={(next) => toggle(project.id, next)} />
                  </div>
                );
              })}
            </SettingsCard>
          )}
        </SettingsSection>
        )}
        <SettingsSection title={`Includes ${includes.length}`} setting="Includes">
          <SettingsCard>
            {includes.map((each) =>
              each.view ? (
                <button key={each.name} type="button" aria-label={`View ${each.name}`} onClick={each.view} className="flex cursor-pointer items-center gap-3 px-4 py-3 text-start hover:bg-fill-subtle focus-visible:focus-ring">
                  <PluginMark item={each.mark} />
                  <RowText title={each.name} line={each.line} truncate />
                </button>
              ) : (
                <div key={each.name} className="flex items-center gap-3 px-4 py-3">
                  <PluginMark item={each.mark} />
                  <RowText title={each.name} line={each.line} truncate />
                </div>
              ),
            )}
          </SettingsCard>
        </SettingsSection>
        <Information rows={info} />
      </SettingsPage>
      {signIn && item && (
        <InstallDialog
          name={item.name}
          mark={<PluginMark item={mark} large />}
          line=""
          projects={value.projects}
          install={null}
          signKey={item.key}
          actions={actions}
          onClose={() => setSignIn(false)}
        />
      )}
    </>
  );
}
