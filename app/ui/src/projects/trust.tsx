import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { Button } from "../components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../components/dialog";
import { ErrorLine } from "../components/error-line";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { useDaemon } from "../daemon";
import { errorText, store } from "../onboarding/api";
import { shortPath } from "./add-project";
import { type Project, setProject, useProjects } from "./projects";

/*
 * "Trust this folder?" [D166, D167, D201]: asked the first time you enter a project with no answer, a
 * session in it or a new session there. Mounted only past onboarding, so it never asks there; projects
 * added several at once are each asked when entered. Either answer is safe, so it can't be dismissed:
 * "Let agents ask" runs every session there under Ask, "Trust folder" at each session's own level.
 */

/** The project a new session is drafted in on Home; set by whoever drafts one. */
const drafted = store<string | null>(null);
export const enterProject = (id: string | null) => drafted.set(id);
export const useDraftedProject = drafted.use;

/** Mounted once beside the sidebar: `active` is the open session's id, null on Home. */
export function TrustHost({ active }: { active: string | null }) {
  const { rows } = useDaemon();
  const draft = drafted.use();
  const projects = useProjects();
  const id = active === null ? draft : (rows?.find((row) => row.id === active)?.project ?? null);
  const project = projects?.find((each) => each.id === id && !each.pending);
  const open = project !== undefined && project.trusted === null;
  // A refused answer comes back to the same question with Rust's reason.
  const [failed, setFailed] = useState<{ id: string; error: string } | null>(null);
  const answer = (trusted: boolean) => {
    if (!project) return;
    setFailed(null);
    setProject(project, { trusted }, ["--trusted", String(trusted)]).catch((cause) => setFailed({ id: project.id, error: errorText(cause) }));
  };
  return (
    <Dialog open={open} disablePointerDismissal onOpenChange={() => {}}>
      {/* Focus lands on the path, not an answer: Enter never trusts a folder by accident. */}
      <DialogContent frame="max-w-trust gap-0 p-0" showCloseButton={false}>
        {project && <TrustForm project={project} error={failed?.id === project.id ? failed.error : null} onAnswer={answer} />}
      </DialogContent>
    </Dialog>
  );
}

/** The question for one project's folder and its two answers, as the old app laid it out. */
export function TrustForm({ project, error, onAnswer }: { project: Project; error: string | null; onAnswer: (trusted: boolean) => void }) {
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-3 px-6 pt-6">
        <DialogHeader className="gap-1.5">
          <DialogTitle>Trust this folder?</DialogTitle>
          <FolderPath folder={project.folder} />
        </DialogHeader>
        <DialogDescription>
          Agents can edit files and run commands here, asking as your permission level says, and the folder's own settings can run code.
        </DialogDescription>
        <ErrorLine error={error} />
      </div>
      <div className="flex items-center justify-end gap-2 px-6 pt-6 pb-5">
        <Button variant="outline" size="sm" onClick={() => onAnswer(false)}>
          Let agents ask
        </Button>
        <Button size="sm" onClick={() => onAnswer(true)}>
          Trust folder
        </Button>
      </div>
    </div>
  );
}

/** The folder's path split at its last part: where it lives, and the folder's own name. */
function splitFolder(path: string): { parent: string; name: string } {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const cut = trimmed.lastIndexOf("/") + 1;
  return { parent: trimmed.slice(0, cut), name: trimmed.slice(cut) };
}

/**
 * The path as it fits its line (the old app's, issue 308): whole when it fits; else home becomes `~`, then
 * it's cut from the middle, never the ends, keeping the first folder and the parts nearest the name.
 */
function fitFolder(path: string, fits: (text: string) => boolean): { parent: string; name: string } {
  const whole = splitFolder(path);
  if (fits(whole.parent + whole.name)) return whole;
  const { parent, name } = splitFolder(shortPath(path));
  const parts = parent.split("/").filter(Boolean);
  const root = parent.startsWith("~") ? "~/" : "/";
  if (root === "~/") parts.shift();
  const shortened = [root + parts.join("/") + (parts.length > 0 ? "/" : "")];
  for (let tail = parts.length - 2; tail >= 0; tail--) shortened.push([root + parts[0], "…", ...parts.slice(parts.length - tail)].join("/") + "/");
  shortened.push(`${root}…/`);
  return { parent: shortened.find((each) => fits(each + name)) ?? shortened.at(-1)!, name };
}

/** How long "Copied" stays in the path's tip. */
const COPIED_MS = 1500;

/** The path in mono, its name a step brighter; hovered, the whole path above "Click to copy". */
function FolderPath({ folder }: { folder: string }) {
  const line = useRef<HTMLButtonElement>(null);
  const [measured, setMeasured] = useState<{ width: number; font: string } | null>(null);
  const [copied, setCopied] = useState(false);
  useLayoutEffect(() => {
    const element = line.current;
    if (!element) return;
    const measure = () => setMeasured({ width: element.clientWidth, font: getComputedStyle(element).font });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), COPIED_MS);
    return () => clearTimeout(timer);
  }, [copied]);
  const shown = useMemo(() => {
    const context = measured && document.createElement("canvas").getContext("2d");
    if (!measured || !context) return splitFolder(folder);
    context.font = measured.font;
    return fitFolder(folder, (text) => context.measureText(text).width <= measured.width);
  }, [folder, measured]);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={line}
            type="button"
            aria-label={`${folder}, click to copy`}
            className="group flex w-full min-w-0 cursor-default text-start font-mono text-xs outline-none"
            onClick={() => void navigator.clipboard.writeText(folder).then(() => setCopied(true), () => {})}
          />
        }
      >
        <span className="shrink-0 whitespace-pre text-muted-foreground group-hover:text-foreground group-focus-visible:text-foreground">{shown.parent}</span>
        <span className="min-w-0 break-all text-foreground">{shown.name}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="flex max-w-trust flex-col gap-1.5">
        <span className="font-mono text-xs wrap-anywhere">{folder}</span>
        <span className="text-2xs text-muted-foreground">{copied ? "Copied" : "Click to copy"}</span>
      </TooltipContent>
    </Tooltip>
  );
}
