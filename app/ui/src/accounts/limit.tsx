import { useEffect, useState } from "react";

import { Button } from "../components/button";
import { ErrorLine } from "../components/error-line";
import { LabeledDivider } from "../components/labeled-divider";
import type { Row } from "../daemon";
import { Info, Spinner } from "../icons";
import { errorText } from "../onboarding/api";
import { loadAccounts, switchSession, useAccounts } from "./api";

/**
 * For a session that hit its limit [D51]: the one-click switch to another signed-in account of
 * the same agent, the user choosing each time; with none, the way to add one. A conversation the
 * agent won't resume on this account offers a new one with a hand-off (D90 Q4). It sits under the
 * thread's last row, as the old app's usage-limit divider did. The click shows at once and holds
 * until Rust accepts the switch [D30].
 */
export function LimitBar({ row, offline }: { row: Row | undefined; offline: boolean }) {
  const { agents, error, loading } = useAccounts();
  const [pending, setPending] = useState<string | undefined | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // The switch Rust accepted: its note is in the thread now, so the line goes at once rather than when
  // the list catches up, which would leave it under the new turn while it streams. A new limit brings it back.
  const [switched, setSwitched] = useState(false);
  const why = row?.switchable;

  useEffect(() => {
    if (why && !offline) void loadAccounts();
  }, [why, offline]);
  useEffect(() => {
    if (!why) setSwitched(false);
  }, [why]);

  if (!row || !why || switched) return null;
  const agent = agents?.find((a) => a.name === row.backend);
  const current = row.account ?? "";
  const list = agent?.accounts?.list ?? [];
  const here = list.find((a) => a.id === current);
  const others = list.filter((a) => a.id !== current && a.check.signed_in === true && a.check.kept_apart !== false);
  const label = agent?.label ?? row.backend;
  const go = (account: string | undefined) => {
    setFailed(null);
    setPending(account);
    switchSession(row.id, account).then(
      () => {
        setPending(null);
        setSwitched(true);
      },
      (cause) => {
        setPending(null);
        setFailed(errorText(cause));
      },
    );
  };
  const busy = (account: string | undefined) => pending === account;

  const link = (account: string | undefined, text: string) => (
    <Button key={account ?? ""} variant="link-blue" size={null} disabled={offline || pending !== null} onClick={() => go(account)}>
      {busy(account) && <Spinner className="mr-1 inline size-icon-xs animate-spin motion-reduce:animate-none" />}
      {text}
    </Button>
  );

  // As the old app's usage-limit divider: one line across the thread, its actions as links.
  return (
    <div className="flex flex-col items-center">
      <LabeledDivider role="status" className="flex-wrap">
        <Info aria-hidden className="size-icon-sm shrink-0" />
        {why === "unresumable" ? (
          <>
            <span className="min-w-0 text-center">{label} couldn't resume this conversation on this account</span>
            {link(undefined, "Start a new conversation with a hand-off")}
          </>
        ) : (
          <>
            <span className="min-w-0 text-center">
              Usage limit reached on {current === "" ? "this computer's login" : (here?.name ?? "this account")}
              {agent ? ` · ${label}` : ""}
              {agents === undefined && error
                ? ""
                : agents === undefined || (loading && others.length === 0)
                  ? " · checking your other accounts…"
                  : !agent?.accounts
                    ? ` · ${label} keeps one login`
                    : others.length === 0
                      ? ` · no other signed-in ${label} account`
                      : ""}
            </span>
            {agent?.accounts && agents !== undefined && !(loading && others.length === 0) && others.length === 0 && (
              <a href="#accounts" className="shrink-0 text-link hover:underline">
                Add an account
              </a>
            )}
            {others.map((a) => link(a.id, `Switch to ${a.id === "" ? "this computer's login" : a.name}`))}
          </>
        )}
      </LabeledDivider>
      <ErrorLine error={agents === undefined ? error : null} />
      <ErrorLine error={failed} />
    </div>
  );
}
