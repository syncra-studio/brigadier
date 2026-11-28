import { useEffect, useSyncExternalStore } from "react";

import { sends, sendState } from "../../../shared/session/sent";
import { type Draft, plainText } from "../components/composer/draft";
import { ThinkingLine, UserBubble, datedAfter } from "../components/thread/message";
import { threadSource, view } from "../daemon";
import { sendFailed } from "../thread/follow";
import type { Source } from "../thread/thread";
import { daemonRun, type Runner } from "./composer";
import { drafts } from "./draft";
import { inThread } from "./queued";
import { flagOf, forget, type Going, uncertain, useGoingOf } from "./uncertain";

export { addArgs, chipArgs, draftArgs, sendOp } from "../../../shared/session/sent";

/** This Mac's sends (app/shared/session/sent.ts), each on the connection it went on. */
const sending = sendState(uncertain, drafts, { connection: () => view.daemon, sendFailed });
export const { keep, go, answered, adopt, again, discard, sendMessage } = sending;

/** Session `id`'s messages Rust may not hold, handed to it on each new connection (app/shared/session/sent.ts). */
export function useHanding(id: string, daemon: unknown, run: Runner): void {
  const mine = useGoingOf(id);
  useEffect(() => {
    if (daemon) sending.handOver(run, id, mine, daemon);
  });
}

/** Whether the session has messages on their way (so the thread's footer shows them); `useOnItsWay` counts none stuck, which wait on Try again, so nothing spins for them. */
export const useSending = (id: string) => sends(useGoingOf(id)).length > 0;
export const useOnItsWay = (id: string) => sends(useGoingOf(id)).some((each) => each.stuck === undefined);

/** The messages on their way, under the thread's last row. */
export function SentBubbles({ id, source = threadSource, run = daemonRun, hover = false }: { id: string; source?: Source; run?: Runner; /** Actions only on hover: the worker panel's, whose rows draw none. */ hover?: boolean }) {
  const list = sends(useGoingOf(id));
  const session = useSyncExternalStore(source.subscribe, source.get);
  const done = (each: Going) => inThread(session).has(each.cid);
  useEffect(() => {
    for (const each of list.filter(done)) forget(id, each.cid);
  });
  const shown = list.filter((each) => !done(each));
  if (shown.length === 0) return null;
  // Dated as their rows will be (after the thread's last message, or the bubble before), so a row takes its place without a shift.
  let previous: { sentAt?: number } | undefined = session?.items.findLast((item) => item.kind === "message");
  return (
    // In the thread's footer (its pt-3 under rows, pt-8 as the first row), Rust's rows' gaps (rows.tsx) and Thinking 12 under, so a row takes a bubble's place without a shift.
    <div className="flex flex-col gap-6 pt-2 in-data-footer:gap-8 in-data-first:pt-0 in-data-rows:pt-5">
      {shown.map((each) => {
        const dated = datedAfter(previous, each.at);
        previous = { sentAt: each.at };
        const parts = flagOf(each.op, "--parts");
        return (
          <UserBubble
            key={each.cid}
            keep={each.cid}
            text={each.op[2] ?? plainText(each.draft.parts)}
            time={each.at} older={hover || each !== shown.at(-1)}
            dated={dated}
            owner={id}
            parts={parts ? (JSON.parse(parts) as Draft).parts : each.draft.parts}
            failed={each.stuck}
            maybe={each.reached !== false}
            onRetry={each.op.length > 0 ? () => void again(run, id, each) : undefined}
            // One that may have reached its agent is only tried again, under its id [C75].
            onDiscard={each.reached !== false ? undefined : () => discard(run, id, each)}
            rewind={each.stuck === undefined || each.reached !== false ? undefined : { open: () => discard(run, id, each, true) }}
          />
        );
      })}
      {shown.at(-1)!.stuck === undefined && <div className="in-data-footer:-mt-5"><ThinkingLine /></div>}
    </div>
  );
}
