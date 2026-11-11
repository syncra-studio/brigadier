import { useEffect, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { DotsHorizontal, Plus, Spinner } from "../icons";
import type { Agent } from "../onboarding/api";
import { TerminalPane } from "../terminal/terminal";
import { type Account, type SwitchAgent, addAccount, closeSignIn, loadAccounts, signIn, signInRun } from "./api";
import { ROW_LINE, ROW_TITLE, useFailed } from "./parts";

/** How often the accounts are checked again while a sign-in terminal is open. */
const RECHECK_MS = 2000;
/** How long an account that hit its limit says so. */
const LIMIT_SHOWN_MS = 5 * 3600 * 1000;
const OWN_LOGIN = "This computer's login";

/**
 * One agent's accounts on its page, inside a card the caller draws [D51]: the computer's own login, then each
 * added one, each signed in by its agent's own sign-in in a real terminal in its own folder [D45]; ending, for an
 * agent that keeps accounts apart, in a link that adds another and shows its sign-in. An agent that keeps one
 * login shows that login alone.
 */
export function AccountRows({
  agent,
  accounts,
  online,
  onRemove,
}: {
  agent: Agent;
  accounts: SwitchAgent | undefined;
  online: boolean;
  onRemove: (account: Account) => void;
}) {
  const { failed, act } = useFailed();
  // The sign-in terminal shown, and whether an account is being added or signed in to again.
  const [open, setOpen] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !online) return;
    const timer = window.setInterval(() => void loadAccounts(), RECHECK_MS);
    return () => clearInterval(timer);
  }, [open, online]);
  const list = accounts?.accounts?.list;
  // A sign-in that ended well closes by itself.
  const signing = open !== null ? list?.find((account) => account.id === open) : undefined;
  const endedWell = signing?.sign_in && !signing.sign_in.running && signing.sign_in.code === 0;
  useEffect(() => {
    if (endedWell && open) close(open);
  }, [endedWell]);

  const close = (id: string) => {
    setOpen((current) => (current === id ? null : current));
    void act(id, () => closeSignIn(id));
  };
  const start = (key: string, work: () => Promise<string>) =>
    act(key, async () => {
      setStarting(key);
      try {
        setOpen(await work());
      } finally {
        setStarting(null);
      }
    });

  // An agent that keeps one login: that login, as onboarding checked it. The computer's login shows only while signed in [D2065].
  const rows: Account[] = (list ?? [
    {
      id: "",
      name: "",
      check: { installed: Boolean(agent.path), signed_in: agent.signed_in, how: agent.how ?? undefined },
      limited_at: null,
      sign_in: null,
    },
  ]).filter((account) => account.id !== "" || account.check.signed_in === true);
  const anySignedIn = rows.some((account) => account.check.signed_in === true);
  const addLabel = anySignedIn ? `Add another ${agent.label} account` : `Add a ${agent.label} account`;

  return (
    <>
      {accounts === undefined && agent.path === undefined ? (
        <p className="px-4 py-3 text-sm text-quiet-foreground">Reading the accounts…</p>
      ) : !rows.length && !accounts?.accounts ? (
        <p className="px-4 py-3 text-sm text-quiet-foreground">No {agent.label} account signed in</p>
      ) : (
        rows.map((account) => (
          <AccountRow
            key={account.id}
            account={account}
            label={agent.label}
            online={online}
            busy={open !== null || starting !== null}
            error={failed[account.id]}
            onSignIn={() => void start(account.id, () => signIn(account.id).then(() => account.id))}
            onRemove={() => onRemove(account)}
          />
        ))
      )}
      {open !== null ? (
        <div className="px-4 py-3">
          <div className="flex h-64 overflow-hidden rounded-surface border border-divider">
            <TerminalPane key={open} id={signInRun(agent.name, open)} title={`${agent.label} · Sign in`} onClose={() => close(open)} />
          </div>
        </div>
      ) : (
        accounts?.accounts && (
          <div className="flex flex-col">
            <button
              type="button"
              aria-label={addLabel}
              disabled={!online || !accounts.installed || starting !== null}
              onClick={() => void start("add", () => addAccount(agent.name))}
              className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-label font-medium text-link hover:underline focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled"
            >
              {starting === "add" ? <Spinner className="size-icon-sm animate-spin motion-reduce:animate-none" /> : <Plus aria-hidden className="size-icon-sm" />}
              {addLabel}
            </button>
            <ErrorLine error={failed.add} className="px-4 pb-3" />
          </div>
        )
      )}
    </>
  );
}

/**
 * One account: its initial, who it is over how it stands; its usage; then In use where the others have Use (or
 * Sign in), and its ⋯ menu. New sessions start on the computer's own login, so that one is In use.
 */
function AccountRow({
  account,
  label,
  online,
  busy,
  error,
  onSignIn,
  onRemove,
}: {
  account: Account;
  label: string;
  online: boolean;
  busy: boolean;
  error: string | undefined;
  onSignIn: () => void;
  onRemove: () => void;
}) {
  const c = account.check;
  const own = account.id === "";
  const signedIn = c.signed_in === true;
  const title = own ? OWN_LOGIN : account.name;
  const line = !c.installed
    ? `${label} isn't installed`
    : account.sign_in?.running
      ? "Signing in…"
      : !signedIn
        ? "Not signed in"
        : c.kept_apart === false
          ? `${c.how} · this sign-in kind isn't kept apart, so it's never used`
          : c.how || "Signed in";
  const limited = account.limited_at !== null && Date.now() - account.limited_at < LIMIT_SHOWN_MS;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-4 px-4 py-3">
        <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-capsule bg-fill-hover text-label font-medium text-foreground">
          {(title.trim().charAt(0) || "?").toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.75">
          <span className={cx(ROW_TITLE, "truncate")}>{title}</span>
          <span className={cx(ROW_LINE, "truncate")}>{line}</span>
          {c.error && <span className="text-xs text-destructive">{c.error}</span>}
          <ErrorLine error={error} />
        </div>
        <span className="flex w-37.5 shrink-0 items-center justify-end">
          {limited ? <Badge variant="warning">Hit its limit</Badge> : signedIn && <span className={ROW_LINE}>Usage not read yet</span>}
        </span>
        <div className="flex w-24 shrink-0 items-center justify-end gap-2.5">
          {!own && !signedIn && !account.sign_in?.running ? (
            <Button variant="soft" size="sm" disabled={!online || !c.installed || busy} onClick={onSignIn}>
              Sign in
            </Button>
          ) : own && signedIn ? (
            <Badge variant="success" title="New sessions start on this account" className="shrink-0">
              In use
            </Badge>
          ) : (
            // Drawn only: starting new sessions on another account waits for Rust [D388].
            <Button variant="soft" size="sm" disabled title="Start new sessions on this account">
              Use
            </Button>
          )}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              render={<Button size="icon-xs" variant="ghost" aria-label={`${title}: more`} className="shrink-0 text-muted-foreground data-popup-open:bg-fill data-popup-open:text-foreground" />}
            >
              <DotsHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {/* Drawn only: naming an account waits for Rust [D388]. */}
              <DropdownMenuItem disabled>Rename</DropdownMenuItem>
              {!own && signedIn && (
                <DropdownMenuItem disabled={!online || busy} onClick={onSignIn}>
                  Sign in again
                </DropdownMenuItem>
              )}
              {!own && (
                <DropdownMenuItem variant="destructive" disabled={!online || Boolean(account.sign_in?.running)} onClick={onRemove}>
                  Remove
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
