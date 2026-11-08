import { createContext, type ReactNode, useContext, useEffect, useState } from "react";

import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { LabeledDivider } from "../components/labeled-divider";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/tooltip";
import { Info, Spinner } from "../icons";
import { errorText } from "../onboarding/api";
import type { Item } from "../thread/item";
import { loadAccounts, switchSession, useAccounts } from "./api";

/** The session a thread shows, for its switch row's one click; none outside a session (the gallery). */
export const SessionOfThread = createContext<{ id: string; offline: boolean } | null>(null);

type Switch = Extract<Item, { kind: "switch" }>;

/**
 * A session's limit and the switch past it, as one row Rust changes in place [D51, D132], in the kit's switch shape
 * (D133) drawn with today's divider, so the kit's line can take the shape as it is. At the limit it offers the
 * one-click switch to another signed-in account of the same agent, the user choosing each time, or the way to add
 * one; a conversation the agent won't resume on this account offers a new one with a hand-off (D90 Q4). The click
 * shows at once as switching, and a refused one as failed with Try again, until Rust's row says switched [D30].
 */
export function SwitchRow({ item }: { item: Switch }) {
  const session = useContext(SessionOfThread);
  const { agents, error, loading } = useAccounts();
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
  const from = row.from ?? named(item.account ?? "");
  const to = `${row.to}${row.model ? ` · ${row.model}` : ""}`;
  let words: ReactNode;
  let actions: ReactNode = null;
  switch (row.state) {
    case "switched":
      words = row.to ? `Switched ${row.automatic ? "automatically " : ""}to ${to}` : row.text;
      break;
    case "switching":
      words = `Switching to ${to}`;
      actions = <Spinner className="size-icon-sm shrink-0 animate-spin motion-reduce:animate-none" />;
      break;
    case "failed":
      words = (
        <Tooltip>
          <TooltipTrigger render={<span />}>Couldn't switch to {to} · the thread is unchanged</TooltipTrigger>
          <TooltipContent>{row.error}</TooltipContent>
        </Tooltip>
      );
      actions = link("again", "Try again", () => go(pending?.account, pending?.to ?? ""));
      break;
    default:
      if (row.reason === "unresumable") {
        words = `${label || "The agent"} couldn't resume this conversation on this account`;
        if (live) actions = link("new", "Start a new conversation with a hand-off", () => go(undefined, "a new conversation"));
        break;
      }
      words = `Usage limit on ${from}`;
      if (!live || agents === undefined || (loading && others.length === 0)) break;
      if (!agent?.accounts) words += ` · ${label} keeps one login`;
      else if (others.length === 0) {
        words += ` · no other signed-in ${label} account`;
        actions = (
          <a href="#accounts" className="shrink-0 text-link hover:underline">
            Add an account
          </a>
        );
      } else actions = others.map((a) => link(a.id, `Switch to ${name(a.id)}`, () => go(a.id, named(a.id))));
  }

  return (
    <div className="flex flex-col items-center">
      <LabeledDivider role="status" className="flex-wrap">
        <Info aria-hidden className="size-icon-sm shrink-0" />
        <span className="min-w-0 text-center">{words}</span>
        {actions}
      </LabeledDivider>
      {live && agents === undefined && <ErrorLine error={error} />}
    </div>
  );
}
