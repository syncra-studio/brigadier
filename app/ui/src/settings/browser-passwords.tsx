import { useCallback, useEffect, useId, useState } from "react";

import { openLink } from "../browser/links";
import { addPassword, allowSite, findPasswords, neverSites, passwordSite, removePassword, revealPassword, type SavedPassword, savedPasswords, siteAddress } from "../browser/passwords";
import { Button } from "../components/button";
import { ConfirmDialog } from "../components/confirm-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { TooltipIconButton } from "../components/icon-button";
import { Input } from "../components/input";
import { DropdownMenuItem } from "../components/menu";
import { SettingsCard } from "../components/settings-card";
import { ExternalLink, Eye, EyeOff, Globe, Plus, Trash } from "../icons";
import { errorText } from "../onboarding/api";
import { SearchField } from "./archived-toolbar";
import { BrowserProfilePick, useBrowserProfilePick } from "./browser-bookmarks";
import { RowMenu } from "./browser-parts";
import { SettingsPage, SettingsSection } from "./parts";

/** How long a shown password stays before it hides itself. */
const SHOWN_MS = 30_000;

/** Adds a password by hand. `onAdded` follows once the browser's store has it. */
function BrowserPasswordsAdd({ profile, open, onOpenChange, onAdded }: { profile: string; open: boolean; onOpenChange: (open: boolean) => void; onAdded: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add password</DialogTitle>
          <DialogDescription>It fills when you sign in on this site in Brigadier's browser.</DialogDescription>
        </DialogHeader>
        {/* Made each time it opens: what was typed last time is gone. */}
        {open && <AddForm profile={profile} onCancel={() => onOpenChange(false)} onAdded={onAdded} />}
      </DialogContent>
    </Dialog>
  );
}

function AddForm({ profile, onCancel, onAdded }: { profile: string; onCancel: () => void; onAdded: () => void }) {
  const ids = useId();
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = siteAddress(site);
  const submit = () => {
    if (!address || !password) return;
    setBusy(true);
    addPassword(profile, address, username.trim(), password)
      .then(onAdded)
      .catch((cause: unknown) => {
        setError(errorText(cause));
        setBusy(false);
      });
  };
  const fields = [
    { id: `${ids}-site`, label: "Site", value: site, set: setSite, type: "text", hint: "github.com" },
    { id: `${ids}-user`, label: "Username", value: username, set: setUsername, type: "text", hint: "you@example.com" },
    { id: `${ids}-pass`, label: "Password", value: password, set: setPassword, type: "password", hint: "" },
  ];
  return (
    <form
      className="flex flex-col gap-3"
      autoComplete="off"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {fields.map((field) => (
        <label key={field.id} htmlFor={field.id} className="flex flex-col gap-1">
          <span className="text-label">{field.label}</span>
          <Input id={field.id} type={field.type} value={field.value} placeholder={field.hint} autoComplete="off" spellCheck={false} onChange={(event) => field.set(event.target.value)} />
        </label>
      ))}
      <ErrorLine error={site && !address ? "That isn't a web address." : error} />
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !address || !password}>
          Add password
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * One saved password: its site and username, dots until the user asks to see it and the system's
 * check passes, and a menu. The password is held only while it shows.
 */
function BrowserPasswordsRow({ profile, entry, onRemove, onError }: { profile: string; entry: SavedPassword; onRemove: () => void; onError: (error: string | null) => void }) {
  const [shown, setShown] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const site = passwordSite(entry.site);

  useEffect(() => {
    if (shown === null) return;
    const timer = setTimeout(() => setShown(null), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [shown]);

  const toggle = () => {
    if (shown !== null) return setShown(null);
    setAsking(true);
    onError(null);
    revealPassword(profile, entry)
      .then((reveal) => {
        if (reveal.kind === "shown") setShown(reveal.password);
        else if (reveal.kind === "unavailable") onError("This Mac can't ask for Touch ID now, so the password stays hidden.");
        else onError("Your computer didn't confirm it's you, so the password stays hidden.");
      })
      .catch((cause: unknown) => onError(errorText(cause)))
      .finally(() => setAsking(false));
  };

  return (
    <li data-slot="password-row" className="flex min-h-12 items-center gap-3 py-1.5">
      <Globe aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-label" title={entry.site}>
          {site}
        </span>
        <span className="truncate text-xs text-quiet-foreground">{entry.username}</span>
      </span>
      <span data-slot="password-value" className="max-w-48 shrink-0 truncate text-xs text-quiet-foreground tabular-nums select-text">
        {shown ?? "••••••••"}
      </span>
      <TooltipIconButton tooltip={shown === null ? "Show password" : "Hide password"} size="icon-sm" disabled={asking} className="shrink-0 text-quiet-foreground" onClick={toggle}>
        {shown === null ? <Eye /> : <EyeOff />}
      </TooltipIconButton>
      <RowMenu name={`${entry.username} on ${site}`}>
        <DropdownMenuItem onClick={() => openLink(entry.site)}>
          <ExternalLink />
          Open site
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Trash />
          Remove password
        </DropdownMenuItem>
      </RowMenu>
    </li>
  );
}

/**
 * Settings › Browser › Saved passwords: one profile's passwords, by site. Shows a password only
 * on request, after the system's check; adds and removes; lists the sites that never offer to save.
 */
export function BrowserPasswords({ profile: first }: { profile?: string | undefined }) {
  const { profiles, profile, setProfile } = useBrowserProfilePick(first);
  const [read, setRead] = useState<{ from: string; passwords: SavedPassword[] } | null>(null);
  const [never, setNever] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SavedPassword | null>(null);
  const [busy, setBusy] = useState(false);

  // What another profile's read left isn't shown: the list is empty until this one's comes.
  const passwords = read?.from === profile ? read.passwords : null;
  const setPasswords = (change: (shown: SavedPassword[]) => SavedPassword[]) => setRead((last) => last && { from: last.from, passwords: change(last.passwords) });

  const load = useCallback((from: string) => {
    savedPasswords(from).then(
      (found) => setRead({ from, passwords: found }),
      (cause: unknown) => setError(errorText(cause)),
    );
    neverSites(from).then(setNever, (cause: unknown) => setError(errorText(cause)));
  }, []);

  useEffect(() => {
    if (profile) load(profile);
  }, [profile, load]);

  const remove = () => {
    if (!profile || !removing) return;
    setBusy(true);
    removePassword(profile, removing.id)
      .then(() => {
        setPasswords((shown) => shown.filter((entry) => entry.id !== removing.id));
        setRemoving(null);
      })
      .catch((cause: unknown) => setError(errorText(cause)))
      .finally(() => setBusy(false));
  };

  const allow = (site: string) => {
    if (!profile) return;
    allowSite(profile, site)
      .then(() => setNever((shown) => shown.filter((other) => other !== site)))
      .catch((cause: unknown) => setError(errorText(cause)));
  };

  const found = findPasswords(passwords ?? [], query);
  return (
    <SettingsPage
      title="Saved passwords"
      description="Passwords Brigadier's browser fills for you. Agents never see them, and a tab an agent is driving doesn't fill them."
      back={{ label: "Browser", href: "#settings/browser" }}
    >
      <div className="flex items-center gap-2">
        <SearchField label="Search saved passwords" value={query} onChange={setQuery} />
        <BrowserProfilePick profiles={profiles} profile={profile} onChange={setProfile} />
        <Button variant="soft" disabled={!profile} onClick={() => setAdding(true)}>
          <Plus />
          Add password
        </Button>
      </div>
      <SettingsSection title="Passwords" aside={passwords ? String(passwords.length) : undefined}>
        <ErrorLine error={error} />
        {passwords && found.length === 0 ? (
          <SettingsCard>
            <EmptyState variant="card" title={query ? "No passwords match." : "Sign in on a site in Brigadier's browser and it offers to save your password here."} />
          </SettingsCard>
        ) : (
          <SettingsCard inset>
            <ul className="divide-y divide-divider">
              {profile && found.map((entry) => <BrowserPasswordsRow key={entry.id} profile={profile} entry={entry} onRemove={() => setRemoving(entry)} onError={setError} />)}
            </ul>
          </SettingsCard>
        )}
      </SettingsSection>
      {never.length > 0 && (
        <SettingsSection title="Never offered on">
          <SettingsCard inset>
            <ul className="divide-y divide-divider">
              {never.map((site) => (
                <li key={site} className="flex min-h-11 items-center gap-3 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-label" title={site}>
                    {passwordSite(site)}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => allow(site)}>
                    Offer again
                  </Button>
                </li>
              ))}
            </ul>
          </SettingsCard>
        </SettingsSection>
      )}
      {profile && (
        <BrowserPasswordsAdd
          profile={profile}
          open={adding}
          onOpenChange={setAdding}
          onAdded={() => {
            setAdding(false);
            load(profile);
          }}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={removing && `Remove the password for ${passwordSite(removing.site)}?`}
        description={removing ? `${removing.username || "This password"} won't fill any more. This can't be undone.` : ""}
        confirm="Remove"
        destructive
        busy={busy}
        onConfirm={remove}
      />
    </SettingsPage>
  );
}
