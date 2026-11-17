import { type ReactNode, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { copyWithToast, CopyButton } from "../components/copy-button";
import { ErrorLine } from "../components/error-line";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { Radio, RadioGroup } from "../components/radio";
import { RowText, SettingsCard } from "../components/settings-card";
import { Switch } from "../components/switch";
import { ChevronRight, Copy, DotsHorizontal, Folder, Spinner, Trash } from "../icons";
import { errorText } from "../onboarding/api";
import { SettingsPage, SettingsSection } from "./parts";
import { InstallDialog } from "./plugins-dialogs";
import { AgentTile, PluginMark } from "./plugins-marks";
import { type Item, type PluginActions, type Plugins, type Scope, STATUS } from "./plugins";

/** A device sign-in's one-time code and the page it's entered on (GitHub's). */
export type Device = { code: string; page: string };
/** How the gallery opens a sign-in: waiting on the browser, or failed with these words. */
export type SignInStart = "waiting" | Device | { error: string } | undefined;

const KIND_LABEL = { server: "MCP server", skill: "Skill" } as const;

/** The breadcrumb, Plugins › My MCPs › Linear, in the band over the page [D577]; the last part is where you are. */
export function Trail({ parts }: { parts: { label: string; go?: () => void }[] }) {
  return (
    <nav aria-label="Breadcrumb" className="app-no-drag absolute top-3 left-5 z-10 flex items-center gap-2 text-label">
      {parts.map((part, at) => (
        <span key={at} className="flex items-center gap-2">
          {at > 0 && <ChevronRight aria-hidden className="size-icon-sm text-faint-foreground" />}
          {part.go ? (
            <button type="button" onClick={part.go} className="cursor-pointer text-quiet-foreground hover:text-foreground focus-visible:focus-ring">
              {part.label}
            </button>
          ) : (
            <span aria-current="page">{part.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

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
 * One item's page, the same for every state [D574, D579]: its header with … (copy, Remove), its switch, and Sign in
 * (spinning while the browser's open) or Sign out for a server Brigadier signs in to; where it's on; what it
 * includes; its information.
 */
export function DetailsPage({
  value,
  item,
  marks,
  actions,
  signing,
  trail,
  onScope,
  onSwitch,
  onRemove,
}: {
  value: Plugins;
  item: Item;
  marks: Record<string, string | null>;
  actions: PluginActions;
  signing: SignInStart;
  trail: { label: string; go?: () => void }[];
  onScope: (scope: Scope) => void;
  onSwitch: (on: boolean) => void;
  onRemove: () => void;
}) {
  const some = "projects" in item.scope ? item.scope.projects : null;
  const toggle = (id: string, on: boolean) => onScope({ projects: on ? [...some!, id] : some!.filter((each) => each !== id) });
  const first = item.kind === "skill" ? "Folder" : /^[a-z]+:\/\//.test(item.detail) ? "Address" : "Command";
  const [signIn, setSignIn] = useState<boolean>(signing !== undefined);
  const [error, setError] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const signedIn = item.signed_in === true;
  const signOut = () => {
    setLeaving(true);
    setError(null);
    actions
      .signOut(item.key)
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setLeaving(false));
  };
  const info: [string, ReactNode][] = [];
  if (item.sign_in) info.push(["Sign-in", item.sign_in === "brigadier" ? "Once in Brigadier, for every agent" : "Signed in by each agent"]);
  if (item.agents.length) info.push(["Works with", <WorksWith agents={item.agents} marks={marks} />]);
  info.push([
    first,
    <span className="flex min-w-0 items-center gap-2 font-mono text-xs">
      <span className="break-all">{item.detail}</span>
      <CopyButton text={item.detail} size="icon-xs" className="text-muted-foreground" />
    </span>,
  ]);
  return (
    <>
      <Trail parts={trail} />
      <SettingsPage
        title={item.name}
        description={`${KIND_LABEL[item.kind]} · ${item.description || item.detail.replace(/^https:\/\//, "")}`}
        mark={<PluginMark item={item} large />}
        actions={
          <span className="flex items-center gap-3">
            {item.status === "cant_reach" && <Badge variant={STATUS.cant_reach.variant}>{STATUS.cant_reach.label}</Badge>}
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-md" aria-label="More" />}>
                <DotsHorizontal aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => copyWithToast(item.detail, first.toLowerCase())}>
                  <Copy aria-hidden />
                  Copy {item.kind === "skill" ? "folder path" : first.toLowerCase()}
                </DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={onRemove}>
                  <Trash aria-hidden />
                  Remove {item.name}
                </DropdownMenuItem>
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
        }
      >
        {(item.note || error) && (
          <div className="-mt-5 flex flex-col gap-2">
            {item.note && <p className="text-xs text-quiet-foreground">{item.note}</p>}
            <ErrorLine error={error} />
          </div>
        )}
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
        <SettingsSection title="Includes 1" setting="Includes">
          <SettingsCard>
            <div className="flex items-center gap-3 px-4 py-3">
              <PluginMark item={item} />
              <RowText title={item.name} line={`${KIND_LABEL[item.kind]}${item.description ? ` · ${item.description}` : ""}`} truncate />
            </div>
          </SettingsCard>
        </SettingsSection>
        <Information rows={info} />
      </SettingsPage>
      {signIn && (
        <InstallDialog
          name={item.name}
          mark={<PluginMark item={item} large />}
          line=""
          projects={value.projects}
          install={null}
          signKey={item.key}
          signing={signing}
          actions={actions}
          onClose={() => setSignIn(false)}
        />
      )}
    </>
  );
}
