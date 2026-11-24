import { useContext, useRef, useState } from "react";

import { SessionOfThread } from "../accounts/limit";
import type { ModelGroup } from "../components/composer/model-picker";
import { ErrorLine } from "../components/error-line";
import { DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, MenuRow } from "../components/menu";
import { ForkMenu, type ForkOffer, ForkPlaces } from "../components/thread/fork-menu";
import { ForkedFrom } from "../components/thread/forked-from";
import { ask, useDaemon } from "../daemon";
import { BranchAlt, Spinner } from "../icons";
import { startFork } from "../home/start";
import { errorText, run } from "../onboarding/api";
import type { Item } from "../thread/item";
import type { SessionRow } from "../sidebar/words";
import { asGroups } from "./model";
import { SetUpAgentDialog } from "./set-up";

/*
 * Fork, wired for a new worktree and a chat's own fork [D1063]: the menu reads Rust's one
 * check as the pointer reaches it and as it opens, so it opens whole [D177]; a pick opens the new session at once, pending, and runs `fork` behind it (home/start.ts), the
 * menu's fingerprint going with it so Rust refuses if the answer changed meanwhile (proposed). Another agent [D1081]:
 * the composer's model picker, its list read as the menu opens; it goes where the one destination rule says (proposed).
 */

/** The fork icon under answer `at` (its turn's message id) in the open session. */
export function ForkAction({ at }: { at: string }) {
  return <Fork at={at} />;
}

type Latest = ForkOffer & { at: string };

/** Fork in a session's ⋯ menu, from its latest answer [D3105, D3106]: Rust's check read as the pointer reaches it and as it opens, then the places an answer's menu offers. */
export function ForkMenuItem({ row, onFork }: { row: SessionRow; onFork?: () => void }) {
  const [offer, setOffer] = useState<Latest>();
  const [error, setError] = useState<string>();
  const read = () =>
    ask({ op: "run", args: ["fork", row.id, "--latest"] }, (reply) => {
      setOffer(reply.ok ? (reply as unknown as Latest) : undefined);
      setError(reply.ok ? undefined : String(reply.message ?? reply.error ?? "Couldn't check this session"));
    });
  return (
    <DropdownMenuSub onOpenChange={(open) => open && read()}>
      <DropdownMenuSubTrigger onPointerEnter={read}>
        <BranchAlt />
        Fork
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-select">
        {offer ? (
          <ForkPlaces
            offer={offer}
            onPick={(pick) => {
              if (!("where" in pick)) return;
              onFork?.();
              startFork(row.id, row.project ?? null, offer.at, pick.where, offer.fingerprint, `Fork of ${row.title}`);
            }}
          />
        ) : error ? (
          <div className="px-2 py-1.5">
            <ErrorLine size="sm" error={error} />
          </div>
        ) : (
          <DropdownMenuItem disabled>
            <MenuRow icon={<Spinner className="animate-spin" />} title="Checking its latest answer" />
          </DropdownMenuItem>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function Fork({ at }: { at: string }) {
  const session = useContext(SessionOfThread);
  const { rows } = useDaemon();
  const row = rows?.find((each) => each.id === session?.id);
  const [offer, setOffer] = useState<ForkOffer>();
  const [error, setError] = useState<string>();
  const [agents, setAgents] = useState<ModelGroup[]>();
  const [agentsError, setAgentsError] = useState<string>();
  const [setUp, setSetUp] = useState<string | null>(null);
  // One read at a time; what was read stays shown while it's read again, so the menu opens whole.
  const reading = useRef(false);
  if (!session) return null;
  const open = () => {
    if (reading.current) return;
    reading.current = true;
    let left = 2;
    const done = () => {
      left -= 1;
      if (left === 0) reading.current = false;
    };
    run(["models", "--session", session.id])
      .then(
        (reply) => {
          setAgents(asGroups(reply.groups));
          setAgentsError(undefined);
        },
        (cause) => setAgentsError(errorText(cause)),
      )
      .finally(done);
    ask({ op: "run", args: ["fork", session.id, "--check", at] }, (reply) => {
      setOffer(reply.ok ? (reply as unknown as ForkOffer) : undefined);
      setError(reply.ok ? undefined : String(reply.message ?? reply.error ?? "Couldn't check this answer"));
      done();
    });
  };
  const now = row as { model?: string | null; effort?: string | null; fast?: boolean } | undefined;
  return (
    <>
      <ForkMenu
        chat={!row?.project}
        offer={offer}
        error={error}
        agents={agents}
        {...(agentsError && { agentsError })}
        current={offer?.agent ?? row?.backend ?? ""}
        value={now?.model && row ? { provider: row.backend, model: now.model, effort: now.effort ?? null, fast: now.fast === true } : null}
        busy={session.offline}
        onSetUp={setSetUp}
        onOpen={open}
        onPick={(pick) => {
          if (!offer) return;
          const title = `Fork of ${row?.title ?? ""}`;
          if ("where" in pick) startFork(session.id, row?.project ?? null, at, pick.where, offer.fingerprint, title);
          else startFork(session.id, row?.project ?? null, at, offer.default, offer.fingerprint, title, pick.to);
        }}
      />
      <SetUpAgentDialog
        name={setUp}
        onClose={() => {
          setSetUp(null);
          open();
        }}
      />
    </>
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
