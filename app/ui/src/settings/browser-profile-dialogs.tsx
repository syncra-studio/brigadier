import { type FormEvent, useId, useState } from "react";

import { type BrowserProfile, canDelete, createProfile, nextHue, deleteProfile, recolourProfile, renameProfile, sessionsOn, tabsOn, useDefaultProfile, useProfiles, useSessionPicks } from "../browser/profiles";
import { ProfileSwatches } from "../browser/profile-mark";
import { Button } from "../components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { Input } from "../components/input";
import { showToast } from "../components/toast";
import { useDaemon } from "../daemon";
import { errorText } from "../onboarding/api";
import { plural } from "../panel/words";
import { openSettings } from "./shell";

const MAC = window.brigadier?.platform === "darwin";

/** New profile, or (with `editing`) Rename: a name and a colour. */
export function ProfileDialog({
  open,
  onOpenChange,
  editing,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editing?: BrowserProfile;
  onCreated?: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="profile-dialog">{open && <Form editing={editing} onClose={() => onOpenChange(false)} onCreated={onCreated} />}</DialogContent>
    </Dialog>
  );
}

function Form({ editing, onClose, onCreated }: { editing: BrowserProfile | undefined; onClose: () => void; onCreated: ((id: string) => void) | undefined }) {
  const profiles = useProfiles();
  const [name, setName] = useState(editing?.name ?? "");
  const [hue, setHue] = useState(editing?.hue ?? nextHue(profiles));
  const taken = profiles.some((profile) => profile.id !== editing?.id && profile.name.toLowerCase() === name.trim().toLowerCase());
  const ready = name.trim().length > 0 && !taken;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    if (editing) {
      if (name.trim() !== editing.name) void renameProfile(editing.id, name);
      if (hue !== editing.hue) void recolourProfile(editing.id, hue);
    } else {
      createProfile(name, hue).then(onCreated, (error: unknown) => showToast(errorText(error), { tone: "error" }));
    }
    onClose();
  };
  return (
    <form onSubmit={submit} className="contents">
      <DialogHeader>
        <DialogTitle>{editing ? `Rename ${editing.name}` : "New profile"}</DialogTitle>
        <DialogDescription>
          {editing ? "Its sign-ins, history, bookmarks and passwords stay as they are." : "A separate set of sign-ins, history, bookmarks and passwords. It starts empty."}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-3">
        <label className="grid gap-1.5">
          <span className="text-label font-medium">Name</span>
          <Input value={name} autoFocus maxLength={40} onChange={(event) => setName(event.target.value)} />
          {taken && <span className="text-xs text-destructive">Another profile has this name.</span>}
        </label>
        <div className="grid gap-2">
          <span className="text-label font-medium">Colour</span>
          <div className="px-0.5">
            <ProfileSwatches value={hue} onChange={setHue} />
          </div>
        </div>
      </div>
      <DialogFooter className={editing || !MAC ? undefined : "sm:justify-between"}>
        {!editing && MAC && (
          <Button
            variant="link-blue"
            size="inline"
            onClick={() => {
              onClose();
              openSettings("browserImport");
            }}
          >
            Import from a browser instead…
          </Button>
        )}
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={!ready}>
            {editing ? "Save" : "Create profile"}
          </Button>
        </div>
      </DialogFooter>
    </form>
  );
}

/** The sessions that exist, for counting those on a profile. */
export const useSessionIds = (): ReadonlySet<string> => new Set(useDaemon().rows?.map((row) => row.id));

/** Delete, confirmed by typing the name. Its sessions and tabs move to the default, and reload, signed in there. */
export function ProfileDeleteDialog({ profile, open, onOpenChange, onDeleted }: { profile: BrowserProfile; open: boolean; onOpenChange: (open: boolean) => void; onDeleted?: () => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-slot="profile-delete">{open && <DeleteForm profile={profile} onClose={() => onOpenChange(false)} onDeleted={onDeleted} />}</DialogContent>
    </Dialog>
  );
}

function DeleteForm({ profile, onClose, onDeleted }: { profile: BrowserProfile; onClose: () => void; onDeleted: (() => void) | undefined }) {
  const target = useDefaultProfile().name;
  const [typed, setTyped] = useState("");
  const field = useId();
  const sessions = sessionsOn(profile.id, useSessionPicks(), useSessionIds());
  const tabs = tabsOn(profile.id);
  const remove = () => {
    if (!canDelete(profile.id)) return;
    deleteProfile(profile.id).catch((error: unknown) => showToast(`Its data couldn't be removed: ${errorText(error)}`, { tone: "error" }));
    onClose();
    onDeleted?.();
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Delete {profile.name}?</DialogTitle>
        <DialogDescription>Its sign-ins, history, bookmarks and passwords are removed from Brigadier. This can't be undone.</DialogDescription>
      </DialogHeader>
      <p className="text-xs text-muted-foreground">
        {sessions + tabs === 0
          ? `Nothing is open on ${profile.name}.`
          : `${plural(sessions, "session")} and ${plural(tabs, "open tab")} move to ${target}. Those pages reload, signed in as ${target}.`}
      </p>
      <p className="text-xs text-muted-foreground">Its saved passwords are deleted with it. They don't move to {target}.</p>
      <div className="grid gap-1.5">
        <label htmlFor={field} className="text-label">
          Type <span className="font-medium">{profile.name}</span> to confirm
        </label>
        <Input id={field} value={typed} autoFocus onChange={(event) => setTyped(event.target.value)} />
      </div>
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="destructive" disabled={typed !== profile.name} onClick={remove}>
          Delete profile
        </Button>
      </DialogFooter>
    </>
  );
}
