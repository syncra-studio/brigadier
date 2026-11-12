import { useState } from "react";

import { Badge } from "../components/badge";
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

/** What an agent switched off means, on its page's line. */
const OFF_NOTE = "Off: its models are hidden from the model picker, and it gets no work";

/**
 * How an agent stands, as the old app's row and page said it: the dot's tone and its line. The row counts its
 * accounts and gives its version; the page names its maker, which Rust knows only for an agent with kept-apart accounts.
 */
export function standing(agent: Agent, accounts: SwitchAgent | undefined, page = false): { tone: "ready" | "needs" | "off"; line: string } {
  const state = stateOf(agent);
  const signedIn = accounts?.accounts ? accounts.accounts.list.filter((account) => account.check.signed_in === true).length : agent.signed_in ? 1 : 0;
  // An agent with no account signed in (free or local models) has none to count.
  const count = signedIn > 0 && `${signedIn} ${signedIn === 1 ? "account" : "accounts"}`;
  if (agent.enabled === false) return { tone: "off", line: page ? OFF_NOTE : ["Off", count].filter(Boolean).join(" · ") };
  if (state === "checking") return { tone: "off", line: "Checking…" };
  if (state === "running") return { tone: "off", line: { install: "Installing…", update: "Updating…", "sign-in": "Signing in…" }[agent.setup!.action] };
  if (state === "error") return { tone: "needs", line: agent.error ?? "Couldn't be checked" };
  if (state === "install") return { tone: "needs", line: "Not installed" };
  if (state === "signIn") return { tone: "needs", line: "Not signed in" };
  if (state === "noModel") return { tone: "ready", line: page ? "No model available" : ["No model available", count, versionText(agent)].filter(Boolean).join(" · ") };
  return { tone: "ready", line: page ? ["Ready", accounts?.accounts?.vendor].filter(Boolean).join(" · ") : ["Ready", count, versionText(agent)].filter(Boolean).join(" · ") };
}

/** An agent's version number, whatever words its CLI puts around it ("codex-cli 0.9", "opencode v2.2"). */
export function versionText(agent: Agent): string | null {
  const number = agent.version?.match(/\d+(\.\d+)+\S*/)?.[0];
  return number ? `v${number}` : agent.version || null;
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
        idle ? "border border-divider text-muted-foreground" : "bg-fill text-strip-foreground",
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

/** A plan as the old app wrote it: "max" is "Max". */
export const planName = (plan: string) => `${plan.charAt(0).toUpperCase()}${plan.slice(1)}`;

/** An agent's plan ("Max"), beside its name; `large` beside an agent page's title. */
export function PlanChip({ plan, large = false }: { plan: string; large?: boolean }) {
  return (
    <Badge variant="secondary" className={cx("shrink-0", !large && "text-2xs font-normal")}>
      {planName(plan)}
    </Badge>
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
  // The CLI's own last line, else ours; an update's as the old app said it.
  if (setup.reason) return setup.reason;
  if (setup.action === "update") return setup.code === null ? "The update was stopped." : `The update stopped with code ${setup.code}.`;
  return setup.action === "install" ? `${agent.label} couldn't be installed. Try again.` : `Signing in to ${agent.label} didn't finish. Try again.`;
}

/**
 * An agent's install, update or sign-in while it runs (with Cancel), or why it failed (with Try again), as the old
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
        : setup.action === "update"
          ? `Updating ${agent.label}…`
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

/*
 * Account emails stay out of sight, the old app's: the first three letters of who, the rest dots, the domain's ending
 * kept (`ste•••••@•••••.com`). A row on an agent's page reveals its own on request.
 */
const DOTS = "•••••";
const EMAIL = /[^\s@;,()<>"']+\x40[^\s@;,()<>"']+\.[A-Za-z]{2,}/g;

export const hasEmail = (text: string) => text.match(EMAIL) !== null;

/** `text` with every email in it masked. */
export function maskEmails(text: string): string {
  return text.replace(EMAIL, (email) => {
    const at = email.lastIndexOf("@");
    const domain = email.slice(at + 1);
    return `${email.slice(0, Math.min(3, at))}${DOTS}@${DOTS}${domain.slice(domain.lastIndexOf("."))}`;
  });
}
