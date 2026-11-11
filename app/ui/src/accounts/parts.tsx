import { useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ExclamationMarkCircle, Spinner, Terminal } from "../icons";
import { Reload } from "../icons/review";
import { ConnectCode, stateOf } from "../onboarding/agents";
import { type Agent, errorText } from "../onboarding/api";
import type { SwitchAgent } from "./api";

/*
 * The parts Settings › Providers is built from, the old app's [D2053]: a row's title and line, an agent's mark,
 * Check again, and an install or sign-in's line under its agent. Every word about an agent comes from its adapter [D43].
 */

/** A row's text: its title over its line, each in the Settings rows' type. */
export const ROW_TITLE = "text-label font-medium";
export const ROW_LINE = "text-xs text-quiet-foreground";

/** The overview's copy, for Settings search; the page renders this. */
export const OVERVIEW_ROWS = {
  switch: {
    label: "Switch to another agent automatically",
    description: "When every account of an agent is at its limit, work carries on with another agent. Off, it waits for the limit to reset.",
  },
  switchAccounts: {
    label: "Switch accounts automatically",
    description: "At a usage limit, work moves on to the next signed-in account of the agent with room. Off, you pick each time.",
  },
  notSetUp: "Agents Brigadier can run that aren't installed yet",
} as const;

/** How an agent stands, for its row and its page: the dot's tone and its line. */
export function standing(agent: Agent, accounts: SwitchAgent | undefined): { tone: "ready" | "needs" | "off"; line: string } {
  const state = stateOf(agent);
  if (state === "checking") return { tone: "off", line: "Checking…" };
  if (state === "running") return { tone: "off", line: agent.setup?.action === "install" ? "Installing…" : "Signing in…" };
  if (state === "error") return { tone: "needs", line: agent.error ?? "Couldn't be checked" };
  if (state === "signIn") return { tone: "needs", line: "Not signed in" };
  const signedIn = accounts?.accounts ? accounts.accounts.list.filter((account) => account.check.signed_in === true).length : agent.signed_in ? 1 : 0;
  const count = `${signedIn} ${signedIn === 1 ? "account" : "accounts"}`;
  return { tone: "ready", line: [state === "noModel" ? "No model available" : "Ready", count, agent.version && `v${agent.version}`].filter(Boolean).join(" · ") };
}

/** What an action failed with, by key, and a way to run one that records it. */
export function useFailed() {
  const [failed, setFailed] = useState<Record<string, string>>({});
  const act = async (key: string, work: () => Promise<unknown>) => {
    setFailed(({ [key]: _, ...rest }) => rest);
    try {
      await work();
    } catch (cause) {
      setFailed((all) => ({ ...all, [key]: errorText(cause) }));
    }
  };
  return { failed, act };
}

/** An agent's mark on a soft tile: `lg` beside its page's title; `idle` outlines one not set up, `dim` fades one off. */
export function AgentMark({ agent, size = "md", idle = false, dim = false }: { agent: Agent; size?: "md" | "lg"; idle?: boolean; dim?: boolean }) {
  return (
    <span
      aria-hidden
      className={cx(
        "flex shrink-0 items-center justify-center rounded-nav",
        size === "lg" ? "size-11" : "size-8.5",
        idle ? "border border-divider text-muted-foreground" : "bg-fill text-foreground",
        dim && "opacity-disabled",
      )}
    >
      {agent.mark ? (
        // Its mark, from its adapter (trusted, built in).
        <span className={cx("grid place-items-center svg:size-full", size === "lg" ? "size-5.5" : "size-4.25")} dangerouslySetInnerHTML={{ __html: agent.mark }} />
      ) : (
        <Terminal className={size === "lg" ? "size-5.5" : "size-4.25"} />
      )}
    </span>
  );
}

/** Check again, at the top of the page and of an agent's page. */
export function CheckAgainButton({ busy, label, onClick }: { busy: boolean; label: string; onClick: () => void }) {
  return (
    <Button variant="soft" size="sm" disabled={busy} aria-label={label} onClick={onClick}>
      <Reload aria-hidden className={busy ? "animate-spin motion-reduce:animate-none" : undefined} />
      Check again
    </Button>
  );
}

/** Why an agent's install or sign-in didn't finish, or null. */
export function setupFailure(agent: Agent, failed: string | undefined): string | null {
  const setup = agent.setup;
  if (failed) return failed;
  if (!setup || setup.running || setup.code === 0) return null;
  return setup.action === "install" ? `${agent.label} couldn't be installed. Try again.` : `Signing in to ${agent.label} didn't finish. Try again.`;
}

/**
 * An agent's install or sign-in while it runs (with Cancel), or why it failed (with Try again), as the old
 * Connect line drew it. Nothing while neither.
 */
export function ConnectStatus({
  agent,
  failed,
  onRetry,
  onCancel,
  className,
}: {
  agent: Agent;
  failed: string | undefined;
  onRetry: () => void;
  onCancel: () => void;
  className?: string;
}) {
  const setup = agent.setup;
  const problem = setupFailure(agent, failed);
  const text = problem
    ? problem
    : setup?.running
      ? setup.action === "install"
        ? `Installing ${agent.label}… This takes a minute or two.`
        : `Finish signing in to ${agent.label} in your browser.`
      : null;
  if (!text) return null;
  return (
    <div className={cx("flex min-w-0 flex-col gap-2", className)}>
      <div className="flex min-w-0 items-center gap-2">
        {problem ? (
          <ExclamationMarkCircle className="size-icon-sm shrink-0 text-destructive" />
        ) : (
          <Spinner className="size-icon-sm shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />
        )}
        <span role="status" className="min-w-0 flex-1 text-xs text-balance text-muted-foreground">
          {text}
        </span>
        <Button size="xs" variant="ghost" onClick={problem ? onRetry : onCancel}>
          {problem ? "Try again" : "Cancel"}
        </Button>
      </div>
      {setup?.running && setup.code_page && <ConnectCode agent={agent} page={setup.code_page} />}
    </div>
  );
}
