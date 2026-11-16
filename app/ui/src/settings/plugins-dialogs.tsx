import { type ReactNode, useId, useState } from "react";

import { Button } from "../components/button";
import { Checkbox } from "../components/checkbox";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { Segmented } from "../components/segmented";
import { Plus, Spinner, X } from "../icons";
import { errorText } from "../onboarding/api";
import type { Own } from "./plugins";
import { PluginMark } from "./plugins-marks";

/** What Add sends Rust: a skill's folder, a server at an address, or a command this computer runs [D2046]. */
export type Draft =
  | { kind: "skill"; folder: string }
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
export type AddForm = { kind: "skill" | "server"; remote: boolean; name: string; url: string; command: string; values: ValueRow[]; folder: string | null };
type Step = "form" | "confirm" | "adding" | "added";
/** Where the gallery opens Add. */
export type AddFirst = { form: Partial<AddForm>; step?: Step };

const EMPTY: AddForm = { kind: "server", remote: false, name: "", url: "", command: "", values: [], folder: null };

/** The Add form's draft: a local command's words split on spaces. */
function draftOf(form: AddForm): Draft {
  if (form.kind === "skill") return { kind: "skill", folder: form.folder ?? "" };
  const values = Object.fromEntries(form.values.filter((row) => row.name.trim()).map((row) => [row.name.trim(), row.value]));
  if (form.remote) return { kind: "server", name: form.name.trim(), url: form.url.trim(), ...(Object.keys(values).length ? { headers: values } : {}) };
  // shortcut: no quoting, so an argument can't hold a space; upgrade when someone needs one.
  const [command = "", ...args] = form.command.trim().split(/\s+/);
  const env = values;
  return { kind: "server", name: form.name.trim(), command, args, env };
}

/**
 * Add: a skill's folder, or an MCP server by its command (or, with `remote`, its address); a local command is shown
 * and confirmed once before it's added, as it runs at each session's start. New items start off [D2046].
 */
export function AddDialog({
  remote,
  pickFolder,
  onAdd,
  onClose,
  first,
}: {
  remote: boolean;
  pickFolder: () => Promise<string | null>;
  onAdd: (draft: Draft) => Promise<unknown>;
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
  const add = (from: Step) => {
    setStep("adding");
    setError(null);
    onAdd(draftOf(form)).then(
      () => setStep("added"),
      (cause: unknown) => {
        setStep(from);
        setError(errorText(cause));
      },
    );
  };
  const choose = () => pickFolder().then((folder) => folder && edit({ folder }), (cause: unknown) => setError(errorText(cause)));
  const shownName = form.kind === "skill" ? (form.folder?.split("/").filter(Boolean).pop() ?? "skill") : form.name.trim();

  if (step === "adding" || step === "added") {
    return (
      <PluginDialog slot="adding" onClose={onClose} title={`Adding ${shownName}`} description="Saved in Brigadier's library for your next sessions.">
        {step === "adding" ? (
          <div className="flex items-center gap-3 text-label text-quiet-foreground">
            <Spinner aria-label="Adding" className="size-icon-sm animate-spin motion-reduce:animate-none" />
            Adding it to your library…
          </div>
        ) : (
          <p className="text-label text-quiet-foreground">Added to your library. It's off until you switch it on, for all projects or only some.</p>
        )}
        <div className="flex justify-end gap-2">
          {step === "added" ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <Button variant="ghost" onClick={onClose}>
              Hide
            </Button>
          )}
        </div>
      </PluginDialog>
    );
  }

  if (step === "confirm") {
    const draft = draftOf(form);
    const names = Object.keys("env" in draft ? draft.env : {});
    return (
      <PluginDialog slot="add-confirm" onClose={onClose} title={`Add ${shownName}?`} description="Your agents start this command on this computer, with your permissions, whenever a session that has it is on starts.">
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-3 rounded-control bg-fill-subtle px-4 py-3">
            <PluginMark item={{ kind: "server", name: form.name, detail: form.command }} />
            <span className="min-w-0 flex-1 font-mono text-xs break-all">{form.command.trim()}</span>
          </div>
          {names.length > 0 && <p className="text-xs text-quiet-foreground">With {names.join(", ")} set. Their values stay in Brigadier's Keychain item.</p>}
        </div>
        <ErrorLine error={error} />
        <div className="flex items-center gap-2">
          <Button variant="ghost" onClick={() => setStep("form")}>
            Back
          </Button>
          <span className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => add("confirm")}>Add</Button>
        </div>
      </PluginDialog>
    );
  }

  return (
    <PluginDialog slot="add" onClose={onClose} title="Add to your library" description="Every agent can use it, once you switch it on for all your projects or only some.">
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
        <Button disabled={!ready} onClick={() => (local ? setStep("confirm") : add("form"))}>
          {local ? "Next" : "Add"}
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

/** What Refresh found in the agents' own settings since it last looked: tick what to copy into the library. */
export function RefreshDialog({ found, onApply, onClose }: { found: Own[]; onApply: (keys: string[]) => void; onClose: () => void }) {
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set());
  const id = useId();
  return (
    <PluginDialog slot="refresh" onClose={onClose} title="Changes found" description="Skills and MCP servers your agents have in their own settings that weren't there before.">
      <section aria-label={`New (${found.length})`} className="flex min-w-0 flex-col gap-2">
        <h3 className="text-label font-medium">New ({found.length})</h3>
        <p className="text-xs text-quiet-foreground">Tick what to add to your library. Each starts off, and their own copies stay as they are.</p>
        <div className="flex min-w-0 flex-col gap-1.5">
          {found.map((own) => (
            <label key={own.key} htmlFor={`${id}-${own.key}`} className="flex cursor-pointer items-center gap-3 rounded-control bg-fill-subtle px-3 py-2">
              <Checkbox
                id={`${id}-${own.key}`}
                aria-label={`Add ${own.name}`}
                checked={ticked.has(own.key)}
                onCheckedChange={(on) => setTicked((now) => (on ? new Set([...now, own.key]) : new Set([...now].filter((key) => key !== own.key))))}
              />
              <PluginMark item={own} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-label font-medium">{own.name}</span>
                <span className="truncate text-xs text-quiet-foreground">
                  {KIND_LABEL[own.kind]} in {[...own.agents, ...(own.project ? [own.project] : [])].join(" · ")}
                </span>
                <span className="truncate font-mono text-xs text-quiet-foreground">{own.detail.replace(/^https:\/\//, "")}</span>
              </span>
            </label>
          ))}
        </div>
      </section>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Not now
        </Button>
        <Button disabled={ticked.size === 0} onClick={() => onApply([...ticked])}>
          Add to library
        </Button>
      </div>
    </PluginDialog>
  );
}
