import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { SwitchDivider } from "../components/thread/cards";
import { errorText } from "../onboarding/api";
import type { Item } from "../thread/item";
import { loadAccounts, switchSession, useAccounts } from "./api";

/** The session a thread shows, for its switch row's one click; none outside a session (the gallery). */
export const SessionOfThread = createContext<{ id: string; offline: boolean } | null>(null);

type Switch = Extract<Item, { kind: "switch" }>;

/**
 * A session's limit and the switch past it, as one row Rust changes in place [D51, D132], in the kit's switch shape
 * (D133), drawn by the kit's SwitchDivider. At the limit it offers the
 * one-click switch to another signed-in account of the same agent, the user choosing each time, or the way to add
 * one; a conversation the agent won't resume on this account offers a new one with a hand-off (D90 Q4). The click
 * shows at once as switching, and a refused one as failed with Try again, until Rust's row says switched [D30].
 */
export function SwitchRow({ item }: { item: Switch }) {
  const session = useContext(SessionOfThread);
  const { agents, error } = useAccounts();
  const [pending, setPending] = useState<{ account: string | undefined; to: string; error?: string } | null>(null);
  const live = item.state === "limit" && session !== null;

  useEffect(() => {
    if (live && !session.offline) void loadAccounts();
  }, [live, session?.offline]);

  const agent = agents?.find((a) => a.name === item.backend);
  const label = agent?.label ?? item.backend ?? "";
  const list = agent?.accounts?.list ?? [];
  const name = (id: string) => (id === "" ? "this computer's login" : (list.find((a) => a.id === id)?.name ?? "this account"));
  // Named as Rust names a side once switched: the account and its agent, or the agent alone with one login.
  const named = (id: string) => (agent?.accounts ? `${name(id)} (${label})` : label);
  const others = list.filter((a) => a.id !== (item.account ?? "") && a.check.signed_in === true && a.check.kept_apart !== false);
  const go = (account: string | undefined, to: string) => {
    if (!session) return;
    setPending({ account, to });
    // Done when Rust's row turns switched; only a refusal comes back here.
    switchSession(session.id, account).catch((cause) => setPending({ account, to, error: errorText(cause) }));
  };
  const link = (key: string, text: string, onClick: () => void) => (
    <Button key={key} variant="link-blue" size={null} disabled={session?.offline || (pending !== null && !pending.error)} onClick={onClick}>
      {text}
    </Button>
  );

  // The shape the row draws: Rust's, with the click's pending state over it while Rust's still reads limit.
  const row: Switch =
    live && pending ? { ...item, state: pending.error ? "failed" : "switching", to: pending.to, error: pending.error } : item;
  // What follows the limit's words. Kept in every state within a session, so the row keeps its room as it moves on.
  let actions: ReactNode = null;
  if (session !== null && item.reason === "unresumable") {
    actions = link("new", "Start a new conversation", () => go(undefined, "a new conversation"));
  } else if (session !== null && agents !== undefined) {
    if (!agent?.accounts) actions = <span>· {label} keeps one login</span>;
    else if (others.length === 0) {
      actions = (
        <>
          <span>· no other signed-in {label} account</span>
          <a href="#accounts" className="shrink-0 text-link hover:underline">
            Add an account
          </a>
        </>
      );
    } else actions = others.map((a) => link(a.id, `Switch to ${name(a.id)}`, () => go(a.id, named(a.id))));
  }

  return (
    <div className="flex flex-col items-center">
      <SwitchDivider
        change={row}
        from={named(item.account ?? "")}
        actions={actions}
        onRetry={() => go(pending?.account, pending?.to ?? "")}
      />
      {live && agents === undefined && <ErrorLine error={error} />}
    </div>
  );
}
