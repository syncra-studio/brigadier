import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { cx } from "../components/cx";
import { useDaemon } from "../daemon";
import { ArrowUpRight, Check, Spinner, Warning } from "../icons";
import { BrandMark } from "../settings/plugins-marks";
import { CARD_BUTTON, DeviceCode, type Run, runFailure } from "./agents";
import { errorText, run } from "./api";
import { StepFooter, StepHeader } from "./parts";

/** How often the forges are read again while a sign-in runs. */
const RECHECK_MS = 2000;

/**
 * GitHub or GitLab as Rust reads them through their own CLIs (gh, glab) [D616]: whether the CLI is here, every login it's
 * signed in as (the active one first, read from its own config) [D624, D625], its docs, and its sign-in run (a device code to enter on its page).
 */
type Forge = {
  name: "github" | "gitlab";
  label: string;
  cli: boolean;
  logins: string[];
  docs: string;
  setup: Run | null;
};

/** One forge's card: the agents' card, plain: its mark, its name, how it stands and Connect. */
function ForgeCard({ forge, starting, failed, online, onConnect, onCancel }: {
  forge: Forge;
  starting: boolean;
  failed: string | undefined;
  online: boolean;
  onConnect: () => void;
  onCancel: () => void;
}) {
  const waiting = starting || Boolean(forge.setup?.running);
  const problem = failed ?? runFailure(forge.setup, forge.label);
  return (
    <li className={cx("flex min-h-36 min-w-0 flex-col gap-4 rounded-settings border border-border bg-card p-5", !online && "opacity-disabled")}>
      <BrandMark brand={forge.name} className="size-8" />
      <div className="mt-auto flex min-w-0 items-end gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <p className="flex min-w-0 items-center gap-1.5 text-lg font-medium">
            <span className="truncate">{forge.label}</span>
            <a href={forge.docs} target="_blank" rel="noreferrer" aria-label={`Open ${forge.label}'s CLI docs`} className="shrink-0 opacity-50 hover:opacity-100">
              <ArrowUpRight className="size-icon-md" />
            </a>
          </p>
          {!waiting &&
            forge.logins.map((login) => (
              <p key={login} className="flex min-w-0 items-center gap-1.5 text-xs">
                <Check className="size-icon-sm shrink-0 text-success" />
                <span className="truncate">Connected as @{login}</span>
              </p>
            ))}
          {problem && !waiting ? (
            <p role="alert" title={problem} className="flex min-w-0 items-center gap-1.5 text-xs">
              <Warning className="size-icon-sm shrink-0 text-destructive" />
              <span className="truncate">{problem}</span>
            </p>
          ) : (
            (waiting || !forge.logins.length) && (
              <p className="truncate text-xs text-muted-foreground">
                {waiting ? "Complete sign-in in your browser" : forge.cli ? "Not connected" : `Needs its CLI (${forge.name === "github" ? "gh" : "glab"})`}
              </p>
            )
          )}
        </div>
        {waiting ? (
          <Button variant={null} size={null} aria-label={`Cancel connecting ${forge.label}`} disabled={starting} onClick={onCancel} className={cx(CARD_BUTTON, "group")}>
            <span className="grid">
              <span className="col-start-1 row-start-1 inline-flex items-center justify-center gap-1.75 group-enabled:group-hover:invisible">
                <Spinner className="size-3.25 animate-spin" />
                Connecting…
              </span>
              <span aria-hidden className="invisible col-start-1 row-start-1 group-enabled:group-hover:visible">
                Cancel
              </span>
            </span>
          </Button>
        ) : (
          forge.cli && (
            // gh keeps several accounts: another sign-in adds one [D625].
            <Button variant={null} size={null} className={CARD_BUTTON} disabled={!online} onClick={onConnect}>
              {forge.logins.length > 0 ? "Add account" : `Connect ${forge.label}`}
            </Button>
          )
        )}
      </div>
      {forge.setup?.running && forge.setup.device_code && forge.setup.code_page && <DeviceCode page={forge.setup.code_page} code={forge.setup.device_code} />}
    </li>
  );
}

/** The step's line: what connecting gives, and that it can wait. */
const GIT_LINE = "Push changes and open pull or merge requests from your sessions. Skip it if you don't use them.";

/**
 * Connect GitHub or GitLab (optional) [D616]: each through its own CLI's sign-in, run by Rust;
 * Skip for now goes on without.
 */
export function GitStep({ onBack, onContinue }: { onBack: () => void; onContinue: () => void }) {
  const online = Boolean(useDaemon().daemon);
  const [forges, setForges] = useState<Forge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const [failed, setFailed] = useState<Record<string, string>>({});
  // A sign-in that ended well goes, as an agent's does; one that failed stays to say why.
  const read = () =>
    run(["forges"]).then(
      (reply) => {
        const list = reply.forges as Forge[];
        setForges(list);
        for (const forge of list) if (forge.setup && !forge.setup.running && forge.setup.code === 0) void run(["forges", forge.name, "close"]).catch(() => {});
      },
      (cause) => setError(errorText(cause)),
    );

  useEffect(() => {
    if (online) void read();
  }, [online]);
  const signingIn = forges?.some((forge) => forge.setup?.running);
  useEffect(() => {
    if (!signingIn || !online) return;
    const timer = window.setInterval(() => void read(), RECHECK_MS);
    return () => clearInterval(timer);
  }, [signingIn, online]);

  const act = async (forge: Forge, what: "sign-in" | "close") => {
    setFailed(({ [forge.name]: _, ...rest }) => rest);
    setStarting(forge.name);
    await run(["forges", forge.name, what]).catch((cause) => setFailed((all) => ({ ...all, [forge.name]: errorText(cause) })));
    setStarting(null);
    await read();
  };

  const connected = forges?.filter((forge) => forge.logins.length > 0) ?? [];
  return (
    <div className="onboarding-step flex min-h-0 flex-1 flex-col">
      <StepHeader title="Connect GitHub or GitLab" description={GIT_LINE} />
      <div className="mt-12 min-h-0 flex-1 overflow-y-auto px-6 pb-6">
        <div className="mx-auto flex w-full max-w-onboarding flex-col gap-3">
          {!online && <p className="text-sm text-muted-foreground">Daemon not reachable · reconnecting…</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <ul className="onboarding-agent-grid">
            {forges?.map((forge) => (
              <ForgeCard
                key={forge.name}
                forge={forge}
                online={online}
                starting={starting === forge.name}
                failed={failed[forge.name]}
                onConnect={() => void act(forge, "sign-in")}
                onCancel={() => void act(forge, "close")}
              />
            ))}
          </ul>
        </div>
      </div>
      <StepFooter
        onBack={onBack}
        count={connected.length > 0 ? `${connected.map((forge) => forge.label).join(" and ")} connected` : undefined}
        primary={{
          label: connected.length > 0 ? "Continue" : "Skip for now",
          onClick: () => {
            // Going on without it stops a sign-in still waiting.
            for (const forge of forges ?? []) if (forge.setup?.running) void run(["forges", forge.name, "close"]).catch(() => {});
            onContinue();
          },
        }}
      />
    </div>
  );
}
