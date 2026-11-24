import { type ReactNode, useEffect, useId, useRef, useState } from "react";

import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { ConfirmDialog } from "../components/confirm-dialog";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { Radio, RadioGroup } from "../components/radio";
import { Segmented } from "../components/segmented";
import { RowText, SettingsCard } from "../components/settings-card";
import { DotsHorizontal, Folder, Plus, Spinner, X } from "../icons";
import { DeviceCode } from "../onboarding/agents";
import { errorText } from "../onboarding/api";
import { BrigadierMark } from "../onboarding/mark";
import type { Item, PluginActions, Scope } from "./plugins";
import { type App, type AppPick, OwnApp } from "./plugins-app";
import type { Device, SignInStart } from "./plugins-details";
import { PluginMark } from "./plugins-marks";

/** What Add sends Rust: a skill's folder, a server at an address, or a command this computer runs [D2046]; on where picked [D727]. */
export type Draft =
  | { kind: "skill"; folder: string }
  | { kind: "skill"; source: string; skill: string }
  | { kind: "server"; name: string; url: string; headers?: Record<string, string> }
  | { kind: "server"; name: string; command: string; args: string[]; env: Record<string, string> };

const KIND_LABEL = { server: "MCP server", skill: "Skill" } as const;

/** The Plugins dialogs' shell, the old app's: the project dialog's width, a title with its close, a line. */
function PluginDialog({ onClose, title, description, slot, children }: { onClose: () => void; title: string; description: ReactNode; slot: string; children: ReactNode }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-dialog={slot} showCloseButton={false} frame="project-dialog max-w-project-dialog gap-6 overflow-y-auto p-6">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <DialogTitle className="min-w-0 flex-1">{title}</DialogTitle>
            <DialogClose render={<Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label="Close" />}>
              <X />
            </DialogClose>
          </div>
          <DialogDescription>{description}</DialogDescription>
        </div>
        {children}
      </DialogContent>
    </Dialog>
  );
}

/** One env value or header: its name, and its value hidden as it's typed. Values go to Brigadier's Keychain item, names to the library. */
type ValueRow = { id: number; name: string; value: string };
/** The Add form as filled so far; the gallery opens it filled. */
export type AddForm = { kind: "skill" | "server"; remote: boolean; name: string; url: string; command: string; values: ValueRow[]; folder: string | null; from?: { source: string; skill: string } };
type Step = "form" | "install";
/** Where the gallery and search open Add: filled in, on the install step where nothing is left to fill [D726]; `mark` a result's own address and icon. */
export type AddFirst = { form: Partial<AddForm>; step?: Step; mark?: { detail: string; icon?: string | null } };

const EMPTY: AddForm = { kind: "server", remote: false, name: "", url: "", command: "", values: [], folder: null };

/** The Add form's draft: a local command's words split on spaces. */
function draftOf(form: AddForm): Draft {
  if (form.kind === "skill") return form.from ? { kind: "skill", ...form.from } : { kind: "skill", folder: form.folder ?? "" };
  const values = Object.fromEntries(form.values.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value]));
  if (form.remote) return { kind: "server", name: form.name.trim(), url: form.url.trim(), ...(Object.keys(values).length ? { headers: values } : {}) };
  // shortcut: no quoting, so an argument can't hold a space; upgrade when someone needs one.
  const [command = "", ...args] = form.command.trim().split(/\s+/);
  const env = values;
  return { kind: "server", name: form.name.trim(), command, args, env };
}

/**
 * Add: a skill's folder, or an MCP server by its command (or, with `remote`, its address); then Browse's own install
 * dialog, where it's on [D571 D726], which installs it on there [D727]. A local command is shown there, as it runs at
 * each session's start. `onAdd` answers the key to sign in to, or null.
 */
export function AddDialog({
  remote,
  projects,
  pickFolder,
  onAdd,
  actions,
  onClose,
  first,
}: {
  remote: boolean;
  projects: { id: string; name: string }[];
  pickFolder: () => Promise<string | null>;
  onAdd: (draft: Draft & { on: true; scope: Scope }) => Promise<string | null>;
  actions: Pick<PluginActions, "signIn" | "cancel">;
  onClose: () => void;
  first?: AddFirst;
}) {
  const id = useId();
  const [form, setForm] = useState<AddForm>({ ...EMPTY, ...first?.form });
  const [step, setStep] = useState<Step>(first?.step ?? "form");
  const [error, setError] = useState<string | null>(null);
  const edit = (change: Partial<AddForm>) => setForm((now) => ({ ...now, ...change }));
  const local = form.kind === "server" && !form.remote;
  const ready = form.kind === "skill" ? Boolean(form.folder) : Boolean(form.name.trim() && (form.remote ? form.url.trim() : form.command.trim()));
  const choose = () => pickFolder().then((folder) => folder && edit({ folder }), (cause: unknown) => setError(errorText(cause)));
  const shownName = form.kind === "skill" ? (form.from?.skill ?? form.folder?.split("/").filter(Boolean).pop() ?? "skill") : form.name.trim();

  if (step === "install") {
    const draft = draftOf(form);
    const names = Object.keys("env" in draft ? draft.env : {});
    const line = local
      ? `Your agents start ${form.command.trim()} on this computer, with your permissions, in the projects you pick.${names.length ? ` With ${names.join(", ")} set; their values stay in Brigadier's Keychain item.` : ""}`
      : "Every agent gets it, in the projects you pick.";
    // Its maker's mark only from its own address, command or package: anyone can name a server "linear" [D437].
    const mark = first?.mark ?? { detail: form.kind === "skill" ? "" : form.remote ? form.url : form.command };
    return (
      <InstallDialog
        name={shownName}
        mark={<PluginMark item={{ kind: form.kind, name: "", ...mark }} exact large />}
        line={line}
        projects={projects}
        install={(scope) => onAdd({ ...draft, on: true, scope })}
        actions={actions}
        onClose={onClose}
      />
    );
  }

  return (
    <PluginDialog slot="add" onClose={onClose} title="Add to your library" description="Every agent can use it, in all your projects or only some.">
      <div className="flex flex-col gap-4">
        <Segmented
          label="Kind"
          value={form.kind}
          options={[
            { value: "skill", label: KIND_LABEL.skill },
            { value: "server", label: KIND_LABEL.server },
          ]}
          onChange={(kind) => edit({ kind })}
        />
        {form.kind === "skill" ? (
          <div className="flex items-center gap-3">
            <span className="min-w-0 flex-1 truncate font-mono text-xs text-quiet-foreground">{form.folder ?? "A folder with a SKILL.md in it"}</span>
            <Button variant="soft" size="sm" onClick={() => void choose()}>
              Choose folder…
            </Button>
          </div>
        ) : (
          <>
            {remote && (
              <Segmented
                label="Where it runs"
                value={form.remote ? "remote" : "local"}
                options={[
                  { value: "local", label: "On this computer" },
                  { value: "remote", label: "At an address" },
                ]}
                onChange={(where) => edit({ remote: where === "remote" })}
              />
            )}
            <Field id={`${id}-name`} label="Name">
              <Input id={`${id}-name`} value={form.name} placeholder="linear" onChange={(event) => edit({ name: event.target.value })} className="h-8 font-mono text-xs" />
            </Field>
            {form.remote ? (
              <Field id={`${id}-url`} label="Address">
                <Input id={`${id}-url`} value={form.url} placeholder="https://mcp.example.com/mcp" onChange={(event) => edit({ url: event.target.value })} className="h-8 font-mono text-xs" />
              </Field>
            ) : (
              <Field id={`${id}-command`} label="Command">
                <Input id={`${id}-command`} value={form.command} placeholder="npx -y @example/mcp-server" onChange={(event) => edit({ command: event.target.value })} className="h-8 font-mono text-xs" />
              </Field>
            )}
            <ValueRows label={form.remote ? "Headers" : "Environment"} rows={form.values} onChange={(values) => edit({ values })} />
          </>
        )}
        <ErrorLine error={error} />
      </div>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!ready} onClick={() => setStep("install")}>
          Next
        </Button>
      </div>
    </PluginDialog>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-3">
      <label htmlFor={id} className="w-24 shrink-0 text-label text-quiet-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

/** A server's headers (at an address) or environment (a command), the old app's: name = value rows, each value hidden as it's typed. */
function ValueRows({ label, rows, onChange }: { label: "Headers" | "Environment"; rows: ValueRow[]; onChange: (rows: ValueRow[]) => void }) {
  const one = label === "Headers" ? "header" : "value";
  const set = (row: ValueRow, change: Partial<ValueRow>) => onChange(rows.map((each) => (each.id === row.id ? { ...each, ...change } : each)));
  return (
    <div className="flex items-start gap-3">
      <span className="w-24 shrink-0 pt-1.5 text-label text-quiet-foreground">{label}</span>
      <div role="group" aria-label={label} className="flex min-w-0 flex-1 flex-col gap-2">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center gap-2">
            <div className="w-36 shrink-0">
              <Input aria-label={`${label} name`} value={row.name} placeholder="Name" onChange={(event) => set(row, { name: event.target.value })} className="h-8 font-mono text-xs" />
            </div>
            <span aria-hidden className="text-xs text-faint-foreground">
              =
            </span>
            <div className="min-w-0 flex-1">
              <Input type="password" aria-label={`${row.name.trim() || "New"} value`} value={row.value} placeholder="Value" onChange={(event) => set(row, { value: event.target.value })} className="h-8 font-mono text-xs" />
            </div>
            <Button variant="ghost" size="icon-sm" className="text-muted-foreground" aria-label={`Remove ${row.name.trim() || one}`} onClick={() => onChange(rows.filter((each) => each.id !== row.id))}>
              <X />
            </Button>
          </div>
        ))}
        <Button variant="link-blue" size="inline" className="self-start" onClick={() => onChange([...rows, { id: Math.max(-1, ...rows.map((row) => row.id)) + 1, name: "", value: "" }])}>
          <Plus />
          Add a {one}
        </Button>
        <p className="text-xs text-faint-foreground">Values stay in Brigadier's Keychain item; the library keeps only their names.</p>
      </div>
    </div>
  );
}

/** What Remove does: a skill's folders of the user's own stay, where the agent's own CLI may still find it, though the `/` menu and `brigadier skill` don't. */
function removeLine(item: Item): string {
  if (item.kind === "server") return "Removes it from Brigadier's library. Sessions already running keep it until they end.";
  const folders = item.folders ?? [];
  return [
    item.from
      ? "It leaves Brigadier's list, the / menu and brigadier skill, and Brigadier stops giving it to new sessions. Agents already running keep it until they end."
      : "It leaves Brigadier's list, the / menu and brigadier skill, its copy is deleted, and Brigadier stops giving it to new sessions.",
    folders.length > 0 && `Your own ${folders.length === 1 ? "folder stays" : "folders stay"}: ${folders.join(", ")}. An agent's own CLI may still find the skill there.`,
    "Add it again to bring it back.",
  ]
    .filter(Boolean)
    .join(" ");
}

/** Removing one library item: one choice, the old app's (proposed). */
export function RemoveDialog({ item, onRemove, onClose }: { item: Item; onRemove: () => void; onClose: () => void }) {
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={`Remove ${item.name}?`}
      description={removeLine(item)}
      confirm="Remove"
      destructive
      onConfirm={onRemove}
    />
  );
}

/**
 * Install, a dialog [D571]: Brigadier's mark and its, where it's on (all projects or the ones picked: nothing
 * is on without a pick), Install; then, for a server Brigadier signs in to, the browser's sign-in with Cancel, and
 * Try again if it didn't finish. `install` null opens on the sign-in, an installed one's Sign in; `signing` the gallery's.
 */
export function InstallDialog({
  name,
  mark,
  line,
  projects,
  install,
  app,
  signKey,
  signing,
  actions,
  onClose,
}: {
  name: string;
  mark: ReactNode;
  line: string;
  projects: { id: string; name: string }[];
  /** Installs it where picked, with `app`'s Client ID, or null for its agent's own plugin; answers the key to sign in to, or null when it needs none. */
  install: ((scope: Scope, clientId: string | null) => Promise<string | null>) | null;
  app?: App;
  signKey?: string;
  signing?: SignInStart;
  actions: Pick<PluginActions, "signIn" | "cancel">;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"choose" | "installing" | "waiting" | "failed">(
    install ? "choose" : typeof signing === "object" && "error" in signing ? "failed" : "waiting",
  );
  const [some, setSome] = useState<string[] | null>(null);
  const [pick, setPick] = useState<AppPick>({ agent: Boolean(app?.agent), clientId: "" });
  const [device, setDevice] = useState<Device | null>(typeof signing === "object" && "code" in signing ? signing : null);
  const [error, setError] = useState<string | null>(typeof signing === "object" && "error" in signing ? signing.error : null);
  const key = useRef(signKey ?? null);
  const generation = useRef(0);
  const signIn = () => {
    const current = ++generation.current;
    setStep("waiting");
    setDevice(null);
    setError(null);
    actions.signIn(key.current!, (shown) => generation.current === current && setDevice(shown)).then(
      () => generation.current === current && onClose(),
      (cause: unknown) => {
        if (generation.current !== current) return;
        setStep("failed");
        setError(errorText(cause));
      },
    );
  };
  // Opened on the sign-in: it starts at once, unless the gallery opens it mid-way.
  useEffect(() => {
    if (!install && signing === undefined) signIn();
    return () => {
      generation.current++;
    };
  }, []);
  const close = () => {
    generation.current++;
    // Closing while it waits cancels it; its own promise settles as cancelled, not as an error.
    if (step === "waiting") {
      void actions.cancel(key.current!).catch(() => {});
    }
    onClose();
  };
  const go = () => {
    const current = ++generation.current;
    setStep("installing");
    setError(null);
    install!(some ? { projects: some } : { all: true }, pick.agent ? null : pick.clientId.trim()).then(
      (next) => {
        if (generation.current !== current) return;
        key.current = next;
        if (next) signIn();
        else onClose();
      },
      (cause: unknown) => {
        if (generation.current !== current) return;
        setStep("choose");
        setError(errorText(cause));
      },
    );
  };
  const choosing = step === "choose" || step === "installing";
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent data-dialog="install" showCloseButton={false} frame="project-dialog max-w-install-dialog gap-5 overflow-y-auto p-6">
        <DialogClose render={<Button variant="ghost" size="icon-sm" className="absolute top-4 right-4 text-muted-foreground" aria-label="Close" />}>
          <X aria-hidden />
        </DialogClose>
        <div className="flex items-center justify-center gap-3 pt-2">
          <span className="flex size-14 items-center justify-center rounded-surface bg-background">
            <BrigadierMark pixels={32} className="size-8" />
          </span>
          <DotsHorizontal aria-hidden className="size-5 text-faint-foreground" />
          {mark}
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <DialogTitle>{choosing ? `Install ${name}` : `Sign in to ${name}`}</DialogTitle>
          <DialogDescription>{choosing ? line : step === "waiting" ? `Finish signing in to ${name} in your browser.` : "The sign-in didn't finish."}</DialogDescription>
        </div>
        {choosing && app && <OwnApp name={name} app={app} value={pick} onChange={setPick} />}
        {choosing && (
          <RadioGroup aria-label="Where it's on" value={some ? "some" : "all"} onValueChange={(next) => setSome(next === "some" ? projects.map((project) => project.id) : null)}>
            <SettingsCard>
              <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
                <Radio value="all" className="mt-0.5" />
                <RowText title="All projects" line="On in every project, and in new ones you add." />
              </label>
              <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
                <Radio value="some" disabled={projects.length === 0} className="mt-0.5" />
                <RowText title="Only some projects" line="On only in the projects you pick." />
              </label>
              {some &&
                projects.map((project) => (
                  <label key={project.id} className="flex cursor-pointer items-center gap-3 py-2.5 ps-11 pe-4">
                    <Checkbox checked={some.includes(project.id)} onCheckedChange={(on) => setSome(on ? [...some, project.id] : some.filter((id) => id !== project.id))} />
                    <Folder aria-hidden className="size-icon-md text-quiet-foreground" />
                    <span className="text-label">{project.name}</span>
                  </label>
                ))}
            </SettingsCard>
          </RadioGroup>
        )}
        {step === "waiting" && (
          <div className="flex flex-col items-center gap-3">
            <div className="flex items-center justify-center gap-2 text-label text-quiet-foreground">
              <Spinner aria-hidden className="size-icon-sm animate-spin motion-reduce:animate-none" />
              Waiting for browser…
            </div>
            {device && <DeviceCode page={device.page} code={device.code} />}
          </div>
        )}
        <ErrorLine error={error} className="text-center" />
        <div className="flex justify-end gap-2">
          {choosing && (
            <Button className="w-full" disabled={step === "installing" || some?.length === 0 || (app && !pick.agent && !pick.clientId.trim())} onClick={go}>
              {step === "installing" && <Spinner aria-hidden className="animate-spin motion-reduce:animate-none" />}
              Install
            </Button>
          )}
          {step === "waiting" && (
            <Button variant="soft" className="w-full" onClick={close}>
              Cancel
            </Button>
          )}
          {step === "failed" && (
            <>
              <Button variant="soft" className="flex-1" onClick={close}>
                Close
              </Button>
              <Button className="flex-1" onClick={signIn}>
                Try again
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
