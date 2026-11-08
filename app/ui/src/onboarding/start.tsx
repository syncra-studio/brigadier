import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button } from "../components/button";
import { Input } from "../components/input";
import { Select } from "../components/select";
import { useDaemon } from "../daemon";
import { Spinner } from "../icons";
import { addPicked, type Agent, checkAll, errorText, run, useAgents, useProfile } from "./api";

const baseName = (path: string) => path.split("/").filter(Boolean).at(-1) ?? path;

/**
 * Start a session (proposed, until wave 1's composer replaces it): an agent with a model, one of
 * the profile's projects and a first message. The models are asked for in the chosen project, as
 * a session there would see them, and asked again when the agent or project changes [D45].
 */
export function StartForm() {
  const { daemon } = useDaemon();
  const projects = useProfile().value?.projects ?? [];
  const { list, checking } = useAgents();
  const usable = (list ?? []).filter((agent) => agent.models?.length);
  const [agent, setAgent] = useState("");
  const [project, setProject] = useState("");
  const [models, setModels] = useState<NonNullable<Agent["models"]> | "loading" | { error: string }>("loading");
  const [model, setModel] = useState("");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const asked = useRef(0);
  const [again, setAgain] = useState(0);

  useEffect(() => {
    if (daemon && list === undefined) void checkAll(true);
  }, [daemon, list]);
  const chosenAgent = usable.some((each) => each.name === agent) ? agent : (usable[0]?.name ?? "");
  const chosenProject = projects.includes(project) ? project : (projects[0] ?? "");

  // The last list Rust kept lands at once, then a fresh check over it; only an agent never checked
  // in this project waits for the models [D30, D45].
  useEffect(() => {
    if (!daemon || !chosenAgent || !chosenProject) return;
    const mine = ++asked.current;
    const args = ["agents", chosenAgent, "--cwd", chosenProject];
    let fresh = false;
    const land = (last: boolean) => (reply: Record<string, any>) => {
      if (mine !== asked.current || fresh) return;
      const found: Agent | undefined = reply.agents[0];
      // A check already running answers busy: ask again shortly rather than show no models.
      if (found?.busy) return void (last && setTimeout(() => mine === asked.current && setAgain((n) => n + 1), 1000));
      fresh = last;
      setModels(found?.error ? { error: found.error } : (found?.models ?? []));
    };
    run([...args, "--cached"]).then(land(false), () => {});
    run(args).then(land(true), (cause) => mine === asked.current && setModels({ error: errorText(cause) }));
  }, [daemon, chosenAgent, chosenProject, again]);

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
      await run(["start", id, "--backend", chosenAgent, "--cwd", chosenProject, "--model", chosenModel, "--text", text.trim()]);
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
        : projects.length === 0
          ? "Add a project first."
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
        <Select label="Project" value={chosenProject} disabled={!projects.length} options={projects.map((path) => ({ value: path, label: baseName(path), hint: path }))} onChange={setProject} align="start" />
      </div>
      <div className="flex items-center gap-2">
        <Input placeholder="What should it do?" value={text} disabled={pending} onChange={(event) => setText(event.target.value)} />
        <Button type="submit" disabled={!daemon || !text.trim() || !chosenModel || pending}>
          {pending && <Spinner className="animate-spin" />}
          {pending ? "Starting…" : "Start"}
        </Button>
      </div>
      {projects.length === 0 && window.brigadier && (
        <Button size="sm" variant="outline" className="self-start" disabled={!daemon} onClick={() => addPicked().catch((cause) => setError(errorText(cause)))}>
          Add folder…
        </Button>
      )}
      {(error ?? note) && <p className={`text-sm ${error || (typeof models === "object" && "error" in models && note === models.error) ? "text-destructive" : "text-muted-foreground"}`}>{error ?? note}</p>}
    </form>
  );
}
