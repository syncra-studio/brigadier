import { type Ref, useEffect, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { DotsHorizontal, Plus, Spinner } from "../icons";
import type { useAgentSetup } from "../onboarding/agents";
import type { Agent } from "../onboarding/api";
import { TerminalPane } from "../terminal/terminal";
import { type Account, type SwitchAgent, addAccount, closeSignIn, loadAccounts, renameAccount, signIn, signInRun, startOn } from "./api";
import { ConnectStatus, ROW_TITLE, useFailed } from "./parts";

/** How often the accounts are checked again while a sign-in terminal is open. */
const RECHECK_MS = 2000;
/** How long an account that hit its limit says so. */
const LIMIT_SHOWN_MS = 5 * 3600 * 1000;
const OWN_LOGIN = "This computer's login";

/**
 * One agent's accounts on its page, inside a card the caller draws [D51]: the computer's own login, then each
 * added one, each signed in by its agent's own sign-in in a real terminal in its own folder [D45]; ending in one
 * link [D2080]: Sign in while nothing is signed in, then Add another account. An agent that keeps one login shows
 * that login alone.
 */
export function AccountRows({
  agent,
  accounts,
  online,
  setup,
  onRemove,
}: {
  agent: Agent;
  accounts: SwitchAgent | undefined;
  online: boolean;
  setup: ReturnType<typeof useAgentSetup>;
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
  // An agent that keeps several logins in one home lists each as an account [D2078].
  const own = (name: string, signedIn: boolean | undefined, how?: string): Account => ({
    id: "",
    name,
    check: { installed: Boolean(agent.path), signed_in: signedIn, how },
    limited_at: null,
    sign_in: null,
  });
  const rows: Account[] = (
    list ?? (agent.logins?.length ? agent.logins.map((login) => own(login, true)) : [own("", agent.signed_in, agent.how ?? undefined)])
  ).filter((account) => account.id !== "" || account.check.signed_in === true);
  const anySignedIn = rows.some((account) => account.check.signed_in === true);
  // One action ends the card [D2080]: the agent's own sign-in while nothing is signed in, then another account,
  // kept apart where the agent keeps them apart, else its own sign-in again.
  const adds = anySignedIn && Boolean(accounts?.accounts);
  // An agent that keeps one login signs in with its own sign-in, in a terminal here [D2072].
  const ownSignIn = agent.setup?.action === "sign-in" && agent.setup.running;

  return (
    <>
      {accounts === undefined && agent.path === undefined ? (
        <p className="px-4 py-3 text-sm text-quiet-foreground">Reading the accounts…</p>
      ) : (
        rows.map((account) => (
          <AccountRow
            key={account.id || account.name}
            name={list ? undefined : account.name || undefined}
            account={account}
            label={agent.label}
            online={online}
            busy={open !== null || starting !== null}
            inUse={account.id === (accounts?.accounts?.use ?? "")}
            error={failed[account.id]}
            onSignIn={() => void start(account.id, () => signIn(account.id).then(() => account.id))}
            onUse={() => void act(account.id, () => startOn(agent.name, account.id))}
            onRename={list && ((name) => void act(account.id, () => renameAccount(agent.name, account.id, name)))}
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
      ) : ownSignIn ? (
        <div className="px-4 py-3">
          <div className="flex h-64 overflow-hidden rounded-surface border border-divider">
            <TerminalPane id={`setup-${agent.name}`} title={`${agent.label} · ${agent.sign_in}`} onClose={() => void setup.close(agent.name)} />
          </div>
        </div>
      ) : (
        <div className="flex flex-col">
          {adds ? (
            <LinkRow
              label={`Add another ${agent.label} account`}
              busy={starting === "add"}
              disabled={!online || !accounts?.installed || starting !== null}
              onClick={() => void start("add", () => addAccount(agent.name))}
            />
          ) : (
            agent.sign_in && (
              <LinkRow
                label={anySignedIn ? `Add another ${agent.label} account` : "Sign in"}
                busy={setup.starting === agent.name}
                disabled={!online || !agent.path || setup.starting !== null}
                onClick={() => void setup.begin(agent, "sign-in")}
              />
            )
          )}
          {agent.setup?.action === "sign-in" && (
            <ConnectStatus agent={agent} failed={undefined} onRetry={() => void setup.begin(agent, "sign-in")} onCancel={() => void setup.close(agent.name)} className="px-4 pb-3" />
          )}
          <ErrorLine error={failed.add} className="px-4 pb-3" />
        </div>
      )}
    </>
  );
}

/** The card's last row: a link that adds an account or signs in, the old app's. */
function LinkRow({ label, busy, disabled, onClick }: { label: string; busy: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-label font-medium text-link hover:underline focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-disabled"
    >
      {busy ? <Spinner className="size-icon-sm animate-spin motion-reduce:animate-none" /> : <Plus aria-hidden className="size-icon-sm" />}
      {label}
    </button>
  );
}

/**
 * One account: its initial, who it is over how it stands; its usage once Rust reads it; then In use on the one new
 * sessions start on where the others have Use (or Sign in), and its ⋯ menu.
 */
function AccountRow({
  account,
  name,
  label,
  online,
  busy,
  inUse,
  error,
  onSignIn,
  onUse,
  onRename,
  onRemove,
}: {
  account: Account;
  /** A login of an agent that keeps several in one home, named by it. */
  name?: string;
  label: string;
  online: boolean;
  busy: boolean;
  inUse: boolean;
  error: string | undefined;
  onSignIn: () => void;
  onUse: () => void;
  /** Absent for a login Rust keeps no name for. */
  onRename?: (name: string) => void;
  onRemove: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const c = account.check;
  const own = account.id === "";
  const signedIn = c.signed_in === true;
  const title = name ?? (account.name || (own ? OWN_LOGIN : "New account"));
  const status = !c.installed
    ? `${label} isn't installed`
    : account.sign_in?.running
      ? "Signing in…"
      : !signedIn
        ? "Not signed in"
        : c.kept_apart === false
          ? `${c.how} · this sign-in kind isn't kept apart, so it's never used`
          : c.how || "Signed in";
  // Called "This computer's login" already, the line doesn't say it again.
  const line = own && title !== OWN_LOGIN && !name ? `${status} · ${OWN_LOGIN}` : status;
  const menu = Boolean(onRename) || !own;
  const limited = account.limited_at !== null && Date.now() - account.limited_at < LIMIT_SHOWN_MS;
  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-4 px-4 py-3">
        {/* The old row's chevron slot, empty: an account here never opens to its limits. */}
        <span className="flex shrink-0 items-center gap-2">
          <span aria-hidden className="size-3.5" />
          <span aria-hidden className="flex size-8 items-center justify-center rounded-capsule bg-fill-hover text-label font-medium text-foreground">
            {(title.trim().charAt(0) || "?").toUpperCase()}
          </span>
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-0.75">
          {renaming && onRename ? (
            <RenameField
              ref={field}
              name={account.name}
              onDone={(next) => {
                setRenaming(false);
                if (next !== null && next !== account.name) onRename(next);
              }}
            />
          ) : (
            <span className={cx(ROW_TITLE, "truncate")}>{title}</span>
          )}
          <span className="truncate text-xs text-muted-foreground">{line}</span>
          {c.error && <span className="text-xs text-destructive">{c.error}</span>}
          <ErrorLine error={error} />
        </div>
        <span className="flex w-37.5 shrink-0 items-center justify-end">
          {limited && <Badge variant="warning">Hit its limit</Badge>}
        </span>
        <div className="flex w-24 shrink-0 items-center justify-end gap-2.5">
          {!own && !signedIn && !account.sign_in?.running ? (
            <Button variant="soft" size="sm" disabled={!online || !c.installed || busy} onClick={onSignIn}>
              Sign in
            </Button>
          ) : inUse && signedIn ? (
            <Badge variant="success" title="New chats start on this account" className="shrink-0">
              In use
            </Badge>
          ) : (
            <Button variant="soft" size="sm" disabled={!online || !signedIn || c.kept_apart === false} title="Start new chats on this account" onClick={onUse}>
              Use
            </Button>
          )}
          {menu && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger
                render={<Button size="icon-xs" variant="ghost" aria-label={`${title}: more`} className="shrink-0 text-muted-foreground data-popup-open:bg-fill data-popup-open:text-foreground" />}
              >
                <DotsHorizontal />
              </DropdownMenuTrigger>
              {/* Focus goes on to the name being edited, not back to ⋯. */}
              <DropdownMenuContent align="end" finalFocus={() => field.current ?? true}>
                {onRename && (
                  <DropdownMenuItem disabled={!online} onClick={() => setRenaming(true)}>
                    Rename
                  </DropdownMenuItem>
                )}
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
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The account's name, editable, the old app's: Enter or leaving the field keeps it (emptied, the account goes by its
 * own name again), Escape drops the edit, and so does leaving it untouched.
 */
function RenameField({ name, onDone, ref }: { name: string; onDone: (name: string | null) => void; ref: Ref<HTMLInputElement> }) {
  const [value, setValue] = useState(name);
  const done = useRef(false);
  const finish = (next: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(next === null || next === name ? null : next.trim());
  };
  return (
    <Input
      ref={ref}
      aria-label="Account name"
      placeholder="Name this account"
      autoFocus
      value={value}
      className="h-7 max-w-xs"
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(value);
        if (event.key === "Escape") {
          // Esc here drops the edit rather than leaving Settings.
          event.stopPropagation();
          finish(null);
        }
      }}
    />
  );
}
