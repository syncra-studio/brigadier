import { useContext, useState } from "react";

import { SessionOfThread } from "../accounts/limit";
import type { ModelGroup } from "../components/composer/model-picker";
import { ForkMenu, type ForkOffer } from "../components/thread/fork-menu";
import { ForkedFrom } from "../components/thread/forked-from";
import { ask, useDaemon } from "../daemon";
import { startFork } from "../home/start";
import { errorText, run } from "../onboarding/api";
import type { Item } from "../thread/item";
import { asGroups } from "./model";

/*
 * Fork, wired for a new worktree, the same folder [D1070] and a chat's own fork [D1063]: the menu reads Rust's one
 * check as it opens; a pick opens the new session at once, pending, and runs `fork` behind it (home/start.ts), the
 * menu's fingerprint going with it so Rust refuses if the answer changed meanwhile (proposed). Another agent [D1081]:
 * the switch picker's list, read as the menu opens; it goes where the one destination rule says (proposed).
 */

/** The fork icon under answer `at` (its turn's message id) in the open session. */
export function ForkAction({ at }: { at: string }) {
  const session = useContext(SessionOfThread);
  const { rows } = useDaemon();
  const row = rows?.find((each) => each.id === session?.id);
  const [offer, setOffer] = useState<ForkOffer>();
  const [error, setError] = useState<string>();
  const [agents, setAgents] = useState<ModelGroup[]>();
  const [agentsError, setAgentsError] = useState<string>();
  if (!session) return null;
  const open = () => {
    setOffer(undefined);
    setError(undefined);
    setAgents(undefined);
    setAgentsError(undefined);
    run(["models", "--session", session.id]).then((reply) => setAgents(asGroups(reply.groups)), (cause) => setAgentsError(errorText(cause)));
    ask({ op: "run", args: ["fork", session.id, "--check", at] }, (reply) =>
      reply.ok ? setOffer(reply as unknown as ForkOffer) : setError(String(reply.message ?? reply.error ?? "Couldn't check this answer")),
    );
  };
  return (
    <ForkMenu
      chat={!row?.project}
      offer={offer}
      error={error}
      agents={agents}
      {...(agentsError && { agentsError })}
      current={offer?.agent ?? row?.backend ?? ""}
      model={(row as { model?: string | null } | undefined)?.model}
      busy={session.offline}
      onOpen={open}
      onPick={(pick) => {
        if (!offer) return;
        const title = `Fork of ${row?.title ?? ""}`;
        if ("where" in pick) startFork(session.id, row?.project ?? null, at, pick.where, offer.fingerprint, title);
        else startFork(session.id, row?.project ?? null, at, offer.default, offer.fingerprint, title, pick.to);
      }}
    />
  );
}

/** "Forked from ‹source›" where a fork starts: the source's title from its row, which opens it; gone, it reads "another session". */
export function ForkedLine({ item }: { item: Extract<Item, { kind: "forked" }> }) {
  const { rows } = useDaemon();
  const source = rows?.find((each) => each.id === item.source);
  return (
    <ForkedFrom
      origin={{ source: source ? { id: source.id, title: source.title } : null, where: item.where, summary: item.summary, leftOut: item.leftOut ?? [] }}
      chat={item.where === null}
      onOpen={(id) => (window.location.hash = `#thread/${encodeURIComponent(id)}`)}
    />
  );
}
