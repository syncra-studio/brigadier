import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { SwitchDivider } from "../components/thread/cards";
import { errorText } from "../onboarding/api";
import type { Reset } from "../sidebar/words";
import type { Item } from "../thread/item";
import { loadAccounts, switchSession, useAccounts } from "./api";
import { maskEmails } from "./parts";
import { agentHref } from "./providers";

/** The session a thread shows, for its switch row's one click; none outside a session. */
export const SessionOfThread = createContext<{ id: string; offline: boolean; reset?: Reset | null } | null>(null);

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
  const [pending, setPending] = useState<{ account: string | undefined; to: string; auto?: boolean; error?: string } | null>(null);
  // At its limit, or past an automatic switch that couldn't happen (Rust's `failed`): still the user's to move on.
  const live = (item.state === "limit" || item.state === "failed") && session !== null;

  useEffect(() => {
    if (live && !session.offline) void loadAccounts();
  }, [live, session?.offline]);

  const agent = agents?.find((a) => a.name === item.backend);
  const label = agent?.label ?? item.backend ?? "";
  const list = agent?.accounts?.list ?? [];
  const name = (id: string) => {
    const account = list.find((a) => a.id === id);
    if (id === "") return "this computer's login";
    return account?.name || (account?.check.email ? maskEmails(account.check.email) : "another account");
  };
  // Named as Rust names a side once switched: the account and its agent, or the agent alone with one login.
  const named = (id: string) => (agent?.accounts ? `${name(id)} (${label})` : label);
  const others = list.filter((a) => a.id !== (item.account ?? "") && a.check.signed_in === true && a.check.kept_apart !== false);
  const go = (account: string | undefined, to: string, auto = false) => {
    if (!session) return;
    setPending({ account, to, auto });
    // Done when Rust's row turns switched; only a refusal comes back here.
    switchSession(session.id, account, auto).catch((cause) => setPending({ account, to, auto, error: errorText(cause) }));
  };
  const link = (key: string, text: string, onClick: () => void) => (
    <Button key={key} variant="link-blue" size={null} disabled={session?.offline || (pending !== null && !pending.error)} onClick={onClick}>
      {text}
    </Button>
  );

  // The shape the row draws: Rust's, with the click's pending state over it while Rust's still reads limit.
  const row: Switch =
    live && pending ? { ...item, state: pending.error ? "failed" : "switching", to: pending.to, automatic: pending.auto === true, error: pending.error } : item;
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
          <a href={agentHref(item.backend ?? "")} className="shrink-0 text-link hover:underline">
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
        carries={live ? session?.reset : null}
        onRetry={() => (pending ? go(pending.account, pending.to, pending.auto) : go(undefined, item.to ?? "", true))}
      />
      {live && agents === undefined && <ErrorLine error={error} />}
    </div>
  );
}
