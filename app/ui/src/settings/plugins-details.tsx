import { useRef, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { CopyButton } from "../components/copy-button";
import { ErrorLine } from "../components/error-line";
import { Radio, RadioGroup } from "../components/radio";
import { RowText, SettingsCard } from "../components/settings-card";
import { Switch } from "../components/switch";
import { Folder, Spinner } from "../icons";
import { DeviceCode } from "../onboarding/agents";
import { errorText } from "../onboarding/api";
import { SettingsPage, SettingsSection } from "./parts";
import { AgentTile, PluginMark } from "./plugins-marks";
import { type Item, type PluginActions, type Plugins, type Scope, STATUS } from "./plugins";

/** How the gallery opens a sign-in: waiting on the browser, or failed with these words. */
/** A device sign-in's one-time code and the page it's entered on (GitHub's). */
export type Device = { code: string; page: string };
export type SignInStart = "waiting" | Device | { error: string } | undefined;

const KIND_LABEL = { server: "MCP server", skill: "Skill" } as const;

/** One item: its switch, its sign-in, where it's on, how it runs, and Remove. */
export function DetailsPage({
  value,
  item,
  marks,
  actions,
  signing,
  onScope,
  onSwitch,
  onRemove,
}: {
  value: Plugins;
  item: Item;
  marks: Record<string, string | null>;
  actions: PluginActions;
  signing: SignInStart;
  onScope: (scope: Scope) => void;
  onSwitch: (on: boolean) => void;
  onRemove: () => void;
}) {
  const some = "projects" in item.scope ? item.scope.projects : null;
  const toggle = (id: string, on: boolean) => onScope({ projects: on ? [...some!, id] : some!.filter((each) => each !== id) });
  const first = item.kind === "skill" ? "Folder" : /^[a-z]+:\/\//.test(item.detail) ? "Address" : "Command";
  return (
    <SettingsPage
      title={item.name}
      description={`${KIND_LABEL[item.kind]} · ${item.description || item.detail.replace(/^https:\/\//, "")}`}
      mark={<PluginMark item={item} large />}
      back={{ label: "Plugins", href: "#settings/plugins" }}
      // The same switch as its card's in the list [D443].
      actions={<Switch aria-label={item.name} checked={item.on} onCheckedChange={onSwitch} />}
    >
      {(item.note || item.agents.length > 0) && (
        <div className="flex flex-col gap-2">
          {item.note && <p className="text-xs text-quiet-foreground">{item.note}</p>}
          {item.agents.length > 0 && (
            <div aria-label="Agents" className="flex flex-wrap items-center gap-1.5">
              {item.agents.map((agent) => (
                <AgentTile key={agent} agent={agent} mark={marks[agent]} />
              ))}
            </div>
          )}
        </div>
      )}
      {item.sign_in === "brigadier" && <SignIn key={item.key} item={item} actions={actions} start={signing} />}
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
      <SettingsSection title="Advanced" setting="Advanced">
        <SettingsCard>
          <div className="flex items-center gap-6 px-4 py-3">
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-label font-medium">{first}</span>
              <span className="font-mono text-xs break-all text-quiet-foreground">{item.detail}</span>
            </span>
            <CopyButton text={item.detail} size="icon-xs" className="text-muted-foreground" />
          </div>
        </SettingsCard>
      </SettingsSection>
      <div data-slot="remove-row" className="flex items-center gap-4">
        <Button variant="soft-destructive" size="sm" onClick={onRemove}>
          Remove {item.name}
        </Button>
        <span className="text-xs text-faint-foreground">Removes it from Brigadier's library. New sessions pick up changes.</span>
      </div>
    </SettingsPage>
  );
}

/** What its standing means, beside its chip. */
const LINE = {
  signed_in: "Brigadier holds the sign-in and keeps it fresh for every session.",
  needs_sign_in: "Sign in once and every session, on every agent, uses it.",
  cant_reach: "Can't reach it. Brigadier keeps trying.",
} as const;

/** A server Brigadier signs in to, as one row [D444]: its standing as the list's chip, what that means, and Sign in (Waiting for browser… with Cancel while it runs), Sign out, and what failed. */
function SignIn({ item, actions, start }: { item: Item; actions: PluginActions; start: SignInStart }) {
  const [waiting, setWaiting] = useState(start === "waiting" || (typeof start === "object" && "code" in start));
  const [device, setDevice] = useState<Device | null>(typeof start === "object" && "code" in start ? start : null);
  const [error, setError] = useState<string | null>(typeof start === "object" && "error" in start ? start.error : null);
  const generation = useRef(0);
  const run = (work: (current: number) => Promise<unknown>, wait: boolean) => {
    const current = ++generation.current;
    setWaiting(wait);
    setDevice(null);
    setError(null);
    work(current)
      .catch((cause: unknown) => generation.current === current && setError(errorText(cause)))
      .finally(() => generation.current === current && (setWaiting(false), setDevice(null)));
  };
  // Signed in while off or unreachable too: Brigadier still holds and refreshes the grant.
  const signedIn = item.signed_in === true;
  const standing = item.status === "cant_reach" ? "cant_reach" : signedIn ? "signed_in" : "needs_sign_in";
  // Signing in doesn't reach a server that's down; it's offered there only while there's no sign-in.
  const offer = item.status !== "cant_reach" || item.signed_in === false;
  const signIn = () => run((current) => actions.signIn(item.key, (shown) => generation.current === current && setDevice(shown)), true);
  return (
    <SettingsCard data-slot="sign-in-status">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3.5">
        <span className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
          <Badge role="status" variant={STATUS[standing].variant}>
            {STATUS[standing].label}
          </Badge>
          <span className="text-xs text-quiet-foreground">{waiting ? "Finish signing in in your browser." : LINE[standing]}</span>
        </span>
        {waiting ? (
          <>
            <span className="flex items-center gap-2 text-label text-quiet-foreground">
              <Spinner aria-hidden className="size-icon-sm animate-spin motion-reduce:animate-none" />
              Waiting for browser…
            </span>
            <Button
              variant="soft"
              size="sm"
              onClick={() => {
                // The sign-in's own promise settles as cancelled; its words aren't an error.
                generation.current++;
                setWaiting(false);
                setDevice(null);
                void actions.cancel(item.key).catch((cause: unknown) => setError(errorText(cause)));
              }}
            >
              Cancel
            </Button>
          </>
        ) : signedIn ? (
          <>
            {offer && (
              <Button variant="ghost" size="sm" onClick={signIn}>
                Sign in again
              </Button>
            )}
            <Button variant="soft" size="sm" onClick={() => run(() => actions.signOut(item.key), false)}>
              Sign out
            </Button>
          </>
        ) : (
          offer && (
            <Button size="sm" onClick={signIn}>
              Sign in
            </Button>
          )
        )}
      </div>
      {((waiting && device) || error) && (
        <div className="flex flex-col gap-2 px-4 py-3">
          {waiting && device && <DeviceCode page={device.page} code={device.code} />}
          <ErrorLine error={error} />
        </div>
      )}
    </SettingsCard>
  );
}
