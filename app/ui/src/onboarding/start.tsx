import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { Input } from "../components/input";
import { Select } from "../components/select";
import { useDaemon } from "../daemon";
import { Spinner } from "../icons";
import { addProject, useProjects } from "../projects/projects";
import { openAddProject } from "../projects/store";
import { enterProject, useDraftedProject } from "../projects/trust";
import { type Agent, checkAll, errorText, run, useAgents } from "./api";

/**
 * Start a session (proposed, until wave 1's composer replaces it): an agent with a model, one of
 * the projects and a first message. The models are asked for in the chosen project, as
 * a session there would see them, and asked again when the agent or project changes [D45].
 */
/** The native folder picker, then the picked folder's repository as a project. */
async function addPicked(): Promise<void> {
  const picked = await window.brigadier?.pickFolder();
  if (picked) await addProject(picked);
}

export function StartForm() {
  const { daemon } = useDaemon();
  const loaded = useProjects();
  // One still being added has no record to start in yet.
  const projects = (loaded ?? []).filter((each) => !each.pending);
  const { list, checking } = useAgents();
  const usable = (list ?? []).filter((agent) => agent.models?.length);
  const [agent, setAgent] = useState("");
  // The project drafted in is the one Trust this folder? asks about [D167].
  const project = useDraftedProject();
  const [models, setModels] = useState<NonNullable<Agent["models"]> | "loading" | { error: string }>("loading");
  const [model, setModel] = useState("");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);

  useEffect(() => {
    if (daemon && list === undefined) void checkAll(true);
  }, [daemon, list]);
  const chosenAgent = usable.some((each) => each.name === agent) ? agent : (usable[0]?.name ?? "");
  const chosen = projects.find((each) => each.id === project) ?? projects[0];
  const chosenProject = chosen?.id ?? "";
  useEffect(() => {
    if (chosenProject && chosenProject !== project) enterProject(chosenProject);
  }, [chosenProject, project]);
  const folder = chosen?.folder ?? "";

  // The last list Rust kept lands at once, then a fresh check over it; only an agent never checked
  // in this project waits for the models [D30, D45].
  useEffect(() => {
    if (!daemon || !chosenAgent || !folder) return;
    const mine = ++asked.current;
    const args = ["agents", chosenAgent, "--cwd", folder];
    let fresh = false;
    const land = (last: boolean) => (reply: Record<string, any>) => {
      if (mine !== asked.current || fresh) return;
      const found: Agent | undefined = reply.agents[0];
      // A cache-only reply may have just the static card; keep waiting for its first check.
      if (found?.path === undefined) return;
      fresh = last;
      setModels(found?.error ? { error: found.error } : (found?.models ?? []));
    };
    run([...args, "--cached"]).then(land(false), () => {});
    run(args).then(land(true), (cause) => mine === asked.current && setModels({ error: errorText(cause) }));
  }, [daemon, chosenAgent, folder]);

  // Local models first: they need no account and cost nothing [D45].
  const shownModels = Array.isArray(models) ? models.toSorted((a, b) => Number(b.local) - Number(a.local)) : [];
  // The chosen model stays while the new list still has it.
  const chosenModel = shownModels.some((each) => each.id === model) ? model : (shownModels[0]?.id ?? "");

  const start = async (event: FormEvent) => {
    event.preventDefault();
    if (!text.trim() || !chosenModel || pending) return;
    setPending(true);
    setError(null);
    const id = `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    try {
      await run(["start", id, "--backend", chosenAgent, "--project", chosenProject, "--model", chosenModel, "--text", text.trim()]);
      window.location.hash = `#thread/${encodeURIComponent(id)}`;
    } catch (cause) {
      setError(errorText(cause));
      setPending(false);
    }
  };

  const note =
    list === undefined || (usable.length === 0 && checking.has("*"))
      ? "Checking the agents…"
      : usable.length === 0
        ? "No agent is connected yet."
        : loaded === undefined
          ? "Loading the projects…"
          : loaded.length === 0
            ? <><Button variant="link-blue" size={null} onClick={() => openAddProject()}>Add a project</Button> first.</>
          : models === "loading"
            ? "Finding the models…"
            : !Array.isArray(models)
              ? models.error
              : models.length === 0
                ? "This agent has no model to use in this project."
                : null;

  return (
    <form onSubmit={(event) => void start(event)} className="flex w-full max-w-reading flex-col gap-2 px-4">
      <h2 className="text-sm font-medium">Start a session</h2>
      <div className="flex flex-wrap items-center gap-2">
        <Select label="Agent" value={chosenAgent} disabled={!usable.length} options={usable.map((each) => ({ value: each.name, label: each.label }))} onChange={setAgent} align="start" />
        <Select label="Model" value={chosenModel} disabled={!shownModels.length} options={shownModels.map((each) => ({ value: each.id, label: each.id, hint: each.local ? "On this computer" : undefined }))} onChange={setModel} align="start" />
        <Select label="Project" value={chosenProject} disabled={!projects.length} options={projects.map((each) => ({ value: each.id, label: each.name, hint: each.folder }))} onChange={enterProject} align="start" />
      </div>
      <div className="flex items-center gap-2">
        <Input placeholder="What should it do?" value={text} disabled={pending} onChange={(event) => setText(event.target.value)} />
        <Button type="submit" disabled={!daemon || !text.trim() || !chosenModel || pending}>
          {pending && <Spinner className="animate-spin" />}
          {pending ? "Starting…" : "Start"}
        </Button>
      </div>
      {loaded?.length === 0 && window.brigadier && (
        <Button size="sm" variant="outline" className="self-start" disabled={!daemon} onClick={() => void addPicked().catch((cause) => setError(errorText(cause)))}>
          Add folder…
        </Button>
      )}
      {(error ?? note) && <p className={`text-sm ${error || (typeof models === "object" && "error" in models && note === models.error) ? "text-destructive" : "text-muted-foreground"}`}>{error ?? note}</p>}
    </form>
  );
}
