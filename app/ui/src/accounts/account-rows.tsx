import { Fragment, type MouseEvent, type ReactNode, type Ref, useEffect, useId, useRef, useState } from "react";

import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../components/menu";
import { ChevronDown, ChevronRight, DotsHorizontal, Eye, EyeOff, Plus, Spinner } from "../icons";
import type { useAgentSetup } from "../onboarding/agents";
import type { Agent } from "../onboarding/api";
import { type Account, type SwitchAgent, addAccount, closeSignIn, loadAccounts, removeAccount, renameAccount, signIn, signInRun, startOn } from "./api";
import { ROW_LINE, ROW_TITLE, SetupLine, hasEmail, maskEmails, planName, useFailed } from "./parts";
import { LimitLine, TightestUsage, tightest } from "./usage";

/** How often the accounts are checked again while a sign-in runs. */
const RECHECK_MS = 2000;
const OWN_LOGIN = "This computer's login";

/**
 * One agent's accounts on its page, inside a card the caller draws, the old app's [D51, D24]: the computer's own login
 * while signed in [D2065], then each added one, each in its own folder; ending in "Add a/another <Agent> account"
 * [D27]. Adding one signs it in with the setup's own sign-in and line in the link's place [D29]; the new account shows
 * once signed in, and goes again if its sign-in is cancelled. An agent that keeps its logins in one home lists each,
 * and adds another with its own sign-in.
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
  // The account being signed in to here; `fresh`: just added, so it goes again if its sign-in never finishes.
  const [signing, setSigning] = useState<{ id: string; fresh: boolean } | null>(null);
  const [starting, setStarting] = useState(false);
  // The rows showing their email: the page's own, so leaving it hides them again.
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set());
  // The rows opened or closed here; the first starts open, the old app's [D7].
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
  const list = accounts?.accounts?.list;
  // An agent that keeps its logins in one home adds one with its own sign-in, its line shown here.
  const oneHome = accounts !== undefined && !accounts.accounts;
  const ownSigning = oneHome && agent.setup?.action === "sign-in";

  // Read again while a sign-in runs, and once more when it ends, so the login it made shows.
  const watching = signing !== null || (agent.setup?.action === "sign-in" && agent.setup.running);
  useEffect(() => {
    if (!watching || !online) return;
    const timer = window.setInterval(() => void loadAccounts(), RECHECK_MS);
    return () => {
      clearInterval(timer);
      void loadAccounts();
    };
  }, [watching, online]);
  const account = signing ? list?.find((each) => each.id === signing.id) : undefined;
  // Until the list has it, the sign-in just asked for.
  const run = signing && (account?.sign_in ?? { id: signInRun(agent.name, signing.id), action: "sign-in", running: true, code: null, signal: null, code_page: null, reason: null });
  // A sign-in that ended well closes by itself.
  const endedWell = account?.sign_in && !account.sign_in.running && account.sign_in.code === 0;
  useEffect(() => {
    if (endedWell && signing) void finish(signing);
  }, [endedWell]);

  /** Ends the sign-in run; a new account that never signed in goes again. */
  const finish = (ending: { id: string; fresh: boolean }) =>
    act(ending.id, async () => {
      setSigning(null);
      await closeSignIn(agent.name, ending.id);
      if (ending.fresh && account?.check.signed_in !== true) await removeAccount(ending.id);
    });
  const signInAgain = (id: string) => act(id, () => signIn(agent.name, id));
  const add = () =>
    act("add", async () => {
      setStarting(true);
      try {
        setSigning({ id: await addAccount(agent.name), fresh: true });
      } finally {
        setStarting(false);
      }
    });

  // An agent that keeps one login: that login, as onboarding checked it. The computer's login shows only while signed in [D2065].
  // An agent that keeps several logins in one home lists each as an account [D2078].
  const own = (name: string, signedIn: boolean | undefined, how?: string): Account => ({
    id: "",
    name,
    check: { installed: Boolean(agent.path), signed_in: signedIn, how },
    limited_until: null,
    sign_in: null,
  });
  const rows: Account[] = (
    list ?? (agent.logins?.length ? agent.logins.map((login) => own(login, true)) : [own("", agent.signed_in, agent.how ?? undefined)])
  ).filter((each) => (each.id !== "" || each.check.signed_in === true) && !(signing?.fresh && each.id === signing.id && each.check.signed_in !== true));
  const anySignedIn = rows.some((each) => each.check.signed_in === true);
  const addLabel = anySignedIn ? `Add another ${agent.label} account` : `Add a ${agent.label} account`;
  return (
    <>
      {accounts === undefined && agent.path === undefined ? (
        <p className="px-4 py-3 text-sm text-quiet-foreground">Reading the accounts…</p>
      ) : (
        rows.map((each, index) => (
          <AccountRow
            key={each.id || each.name}
            open={toggled.get(each.id || each.name) ?? index === 0}
            onToggle={() => setToggled((all) => new Map(all).set(each.id || each.name, !(all.get(each.id || each.name) ?? index === 0)))}
            name={list ? undefined : each.name || undefined}
            account={each}
            label={agent.label}
            online={online}
            busy={signing !== null || starting}
            inUse={each.id === (accounts?.accounts?.use ?? "")}
            error={failed[each.id]}
            revealed={revealed.has(each.id)}
            onReveal={() =>
              setRevealed((all) => {
                const next = new Set(all);
                if (!next.delete(each.id)) next.add(each.id);
                return next;
              })
            }
            onSignIn={() => {
              setSigning({ id: each.id, fresh: false });
              void signInAgain(each.id);
            }}
            onUse={() => void act(each.id, () => startOn(agent.name, each.id))}
            onRename={list && ((name) => void act(each.id, () => renameAccount(agent.name, each.id, name)))}
            onRemove={() => onRemove(each)}
          />
        ))
      )}
      {signing && run ? (
        <SetupLine
          agent={agent}
          run={run}
          account={signing.id}
          failed={failed[signing.id]}
          onRetry={() => void signInAgain(signing.id)}
          onCancel={() => void finish(signing)}
          className="px-4 py-3"
        />
      ) : ownSigning ? (
        <SetupLine agent={agent} failed={setup.failed[agent.name]} onRetry={() => void setup.begin(agent, "sign-in")} onCancel={() => void setup.close(agent.name)} className="px-4 py-3" />
      ) : (
        <div className="flex flex-col">
          <LinkRow
            label={addLabel}
            busy={starting || (oneHome && setup.starting === agent.name)}
            disabled={!online || !agent.path || starting || setup.starting !== null || (!oneHome && !accounts?.installed)}
            onClick={() => void (oneHome ? setup.begin(agent, "sign-in") : add())}
          />
          <ErrorLine error={failed.add} className="px-4 pb-3" />
        </div>
      )}
    </>
  );
}

/** The card's last row: a link that adds an account, the old app's. */
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
 * One account, the old app's: a chevron, its initial, who it is over how it stands; closed, its tightest limit; then In
 * use on the one new sessions start on where the others have Use (or Sign in), and its ⋯ menu. A press on the row opens
 * it to every limit with when each resets; its controls don't.
 */
function AccountRow({
  account,
  open,
  onToggle,
  name,
  label,
  online,
  busy,
  inUse,
  error,
  revealed,
  onReveal,
  onSignIn,
  onUse,
  onRename,
  onRemove,
}: {
  account: Account;
  open: boolean;
  onToggle: () => void;
  /** A login of an agent that keeps several in one home, named by it. */
  name?: string;
  label: string;
  online: boolean;
  busy: boolean;
  inUse: boolean;
  error: string | undefined;
  revealed: boolean;
  onReveal: () => void;
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
  // Who it is, as the old row named it: its name, else its email, masked until its eye is pressed [D26].
  const show = (text: string) => (revealed ? text : maskEmails(text));
  const email = c.email ?? null;
  const given = name ?? account.name;
  const renamed = given !== "" && given !== email;
  const title = renamed ? show(given) : email ? show(email) : own ? OWN_LOGIN : "New account";
  const eye = (hasEmail(given) || Boolean(email)) && (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={revealed ? "Hide email" : "Show email"}
      aria-pressed={revealed}
      className="size-5 shrink-0 text-muted-foreground"
      onClick={onReveal}
    >
      {revealed ? <EyeOff /> : <Eye />}
    </Button>
  );
  const line: ReactNode[] = [];
  if (!c.installed) line.push(`${label} isn't installed`);
  else {
    // Under a name of its own, the email shows on the line below.
    if (renamed && email)
      line.push(
        <span key="email" className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{show(email)}</span>
          {eye}
        </span>,
      );
    if (account.sign_in?.running) line.push("Signing in…");
    else if (!signedIn) line.push("Not signed in");
    else if (c.kept_apart === false) line.push(`${c.how} · this sign-in kind isn't kept apart, so it's never used`);
    else if (c.plan) line.push(`${planName(c.plan)} plan`);
  }
  // Called "This computer's login" already, the line doesn't say it again.
  if ((own || account.own_login) && title !== OWN_LOGIN) line.push(OWN_LOGIN);
  const menu = Boolean(onRename) || !own;
  const limited = account.limited_until !== null && Date.now() < account.limited_until;
  const limitsId = useId();
  // Only an account with limits read opens.
  const limits = signedIn ? (c.usage ?? []) : [];
  const opens = limits.length > 0;
  const shown = opens && open;
  const fullest = tightest(limits);
  const usage = !c.installed || !signedIn ? null : !fullest ? <span className={ROW_LINE}>Usage not read yet</span> : !shown && <TightestUsage limit={fullest} />;
  // A press on the row toggles it, but not one on its controls or in its menu, which React passes up from its layer.
  const toggle = (event: MouseEvent<HTMLDivElement>) => {
    if (!opens || !(event.target instanceof Element) || !event.currentTarget.contains(event.target)) return;
    const control = event.target.closest("button, input, a");
    if (control && control.getAttribute("data-slot") !== "account-toggle") return;
    onToggle();
  };
  const Chevron = shown ? ChevronDown : ChevronRight;
  return (
    <div className={cx("flex flex-col transition-colors", opens && "hover:bg-fill")}>
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- the button over it is the keyboard's and a screen reader's */}
      <div onClick={toggle} className={cx("group/account relative flex items-center gap-4 px-4 py-3", opens && "cursor-pointer")}>
        {/* What opens the row for the keyboard and a screen reader, beside its controls; the pointer goes through it. */}
        {opens && (
          <button
            type="button"
            data-slot="account-toggle"
            aria-expanded={shown}
            aria-controls={limitsId}
            aria-label={`${title}: ${shown ? "hide" : "show"} its limits`}
            className="pointer-events-none absolute inset-0 focus-visible:focus-ring"
          />
        )}
        <span className="flex shrink-0 items-center gap-2">
          <span aria-hidden className="flex size-3.5 items-center justify-center">
            {opens && <Chevron className="size-3.5 text-muted-foreground group-hover/account:text-foreground" />}
          </span>
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
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cx(ROW_TITLE, "truncate")}>{title}</span>
              {!(renamed && email) && eye}
            </span>
          )}
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            {line.map((part, index) => (
              <Fragment key={index}>
                {index > 0 && <span aria-hidden>·</span>}
                {typeof part === "string" ? <span className="shrink-0">{part}</span> : part}
              </Fragment>
            ))}
          </span>
          {c.error && <span className="text-xs text-destructive">{c.error}</span>}
          <ErrorLine error={error} />
        </div>
        <span className="flex w-37.5 shrink-0 items-center justify-end">
          {limited ? <Badge variant="warning">Hit its limit</Badge> : usage}
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
      {shown && (
        <div id={limitsId} className="flex flex-col gap-2.5 pr-16 pb-4 pl-21.5">
          {limits.map((limit) => (
            <LimitLine key={limit.name} limit={limit} now={Date.now()} />
          ))}
        </div>
      )}
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
