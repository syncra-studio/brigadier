import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import type { Row } from "../daemon";
import { Spinner } from "../icons";
import { errorText } from "../onboarding/api";
import { loadAccounts, switchSession, useAccounts } from "./api";

/**
 * Above a session that hit its limit [D51]: the one-click switch to another signed-in account of
 * the same agent, the user choosing each time; with none, the way to add one. A conversation the
 * agent won't resume on this account offers a new one with a hand-off (D90 Q4). Also shown with the
 * terminal open [D47]. The click shows at once and holds until the list says the session moved [D30].
 */
export function LimitBar({ row, offline }: { row: Row | undefined; offline: boolean }) {
  const { agents, error, loading } = useAccounts();
  const [pending, setPending] = useState<{ account: string | undefined; items: number } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const why = row?.switchable;

  useEffect(() => {
    if (why && !offline) void loadAccounts();
  }, [why, offline]);
  // The session moved on (or something else reached its log): the click is reconciled.
  useEffect(() => {
    if (pending && row && row.items !== pending.items) setPending(null);
  }, [row?.items]);

  if (!row || !why) return null;
  const agent = agents?.find((a) => a.name === row.backend);
  const current = row.account ?? "";
  const list = agent?.accounts?.list ?? [];
  const here = list.find((a) => a.id === current);
  const others = list.filter((a) => a.id !== current && a.check.signed_in === true && a.check.kept_apart !== false);
  const label = agent?.label ?? row.backend;
  const go = (account: string | undefined) => {
    setFailed(null);
    setPending({ account, items: row.items });
    switchSession(row.id, account).catch((cause) => {
      setPending(null);
      setFailed(errorText(cause));
    });
  };
  const busy = (account: string | undefined) => pending !== null && pending.account === account;

  return (
    <div className="mx-auto w-full max-w-reading shrink-0 px-6 pt-2">
      <div className="flex flex-col gap-2 rounded-settings border border-divider bg-card px-4 py-3 text-sm" role="status">
        {why === "unresumable" ? (
          <>
            <p>{label} couldn't resume this conversation on this account.</p>
            <Button size="sm" variant="soft" className="self-start" disabled={offline || pending !== null} onClick={() => go(undefined)}>
              {busy(undefined) && <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />}
              Start a new conversation with a hand-off
            </Button>
          </>
        ) : (
          <>
            <p>
              Usage limit reached on {current === "" ? "this computer's login" : (here?.name ?? "this account")}
              {agent ? ` · ${label}` : ""}.
            </p>
            {agents === undefined && error ? (
              <ErrorLine error={error} />
            ) : agents === undefined || (loading && others.length === 0) ? (
              <p className="text-muted-foreground">Checking your other accounts…</p>
            ) : !agent?.accounts ? (
              <p className="text-muted-foreground">{label} keeps one login.</p>
            ) : others.length === 0 ? (
              <p className="text-muted-foreground">
                No other signed-in {label} account.{" "}
                <a href="#accounts" className="text-link hover:text-link-hover">
                  Add an account
                </a>
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {others.map((a) => (
                  <Button key={a.id} size="sm" variant="soft" disabled={offline || pending !== null} onClick={() => go(a.id)}>
                    {busy(a.id) && <Spinner className="size-icon-xs animate-spin motion-reduce:animate-none" />}
                    Switch to {a.id === "" ? "this computer's login" : a.name}
                  </Button>
                ))}
              </div>
            )}
          </>
        )}
        <ErrorLine error={failed} />
      </div>
    </div>
  );
}
