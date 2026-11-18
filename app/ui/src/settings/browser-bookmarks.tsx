import { useEffect, useId, useState } from "react";

import { addBookmark, type Bookmark, bookmarkAddress, type BookmarkEdit, bookmarkFolders, browserBookmarks, FOLDER_SEPARATOR, folderLabel, removeBookmark, updateBookmark } from "../browser/bookmarks";
import { siteOf } from "../browser/data";
import { openLink } from "../browser/links";
import { type BrowserProfile, useDefaultProfile, useProfiles } from "../browser/profiles";
import { Button } from "../components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../components/dialog";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { Input } from "../components/input";
import { DropdownMenuItem } from "../components/menu";
import { Select } from "../components/select";
import { SettingsCard } from "../components/settings-card";
import { ExternalLink, Globe, Pencil, Plus, Trash } from "../icons";
import { errorText } from "../onboarding/api";
import { SearchField } from "./archived-toolbar";
import { DayGroup, RowMenu } from "./browser-parts";
import { SettingsPage, SettingsSection } from "./parts";

/** The browser's profiles and the one a page is showing: `first`, or the default, until the user picks. */
export function useBrowserProfilePick(first?: string) {
  const profiles = useProfiles();
  const fallback = useDefaultProfile();
  const [picked, setPicked] = useState<string | null>(first ?? null);
  return { profiles, profile: picked ?? fallback.id, setProfile: setPicked };
}

/** Which profile's bookmarks a page shows. With one profile there is nothing to pick. */
export function BrowserProfilePick({ profiles, profile, onChange }: { profiles: readonly BrowserProfile[]; profile: string | null; onChange: (profile: string) => void }) {
  if (profiles.length < 2 || profile === null) return null;
  return <Select label="Browser profile" value={profile} options={profiles.map(({ id, name }) => ({ value: id, label: name }))} onChange={onChange} className="w-36" />;
}

/** Adds a bookmark, or edits `bookmark`. `onSave` does the work; a failure stays in the dialog. */
function BrowserBookmarksEdit({
  open,
  bookmark,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  bookmark: Bookmark | null;
  onOpenChange: (open: boolean) => void;
  onSave: (edit: BookmarkEdit) => Promise<void>;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{bookmark ? "Edit bookmark" : "Add bookmark"}</DialogTitle>
          <DialogDescription className="sr-only">The bookmark's name, address and folder.</DialogDescription>
        </DialogHeader>
        {open && <EditForm bookmark={bookmark} onCancel={() => onOpenChange(false)} onSave={onSave} />}
      </DialogContent>
    </Dialog>
  );
}

function EditForm({ bookmark, onCancel, onSave }: { bookmark: Bookmark | null; onCancel: () => void; onSave: (edit: BookmarkEdit) => Promise<void> }) {
  const ids = useId();
  const [title, setTitle] = useState(bookmark?.title ?? "");
  const [url, setUrl] = useState(bookmark?.url ?? "");
  const [folder, setFolder] = useState(bookmark ? folderLabel(bookmark.folders) : "Bookmarks");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = bookmarkAddress(url);
  const submit = () => {
    if (!address) return;
    const folders = folder
      .split(FOLDER_SEPARATOR.trim())
      .map((part) => part.trim())
      .filter(Boolean);
    setBusy(true);
    onSave({ url: address, title: title.trim(), folders: folders.join() === "Bookmarks" ? [] : folders }).catch((cause: unknown) => {
      setError(errorText(cause));
      setBusy(false);
    });
  };
  const fields = [
    { id: `${ids}-title`, label: "Name", value: title, set: setTitle, hint: "Rust docs" },
    { id: `${ids}-url`, label: "Address", value: url, set: setUrl, hint: "https://doc.rust-lang.org" },
    { id: `${ids}-folder`, label: "Folder", value: folder, set: setFolder, hint: "Bookmarks bar › Work" },
  ];
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {fields.map((field) => (
        <label key={field.id} htmlFor={field.id} className="flex flex-col gap-1">
          <span className="text-label">{field.label}</span>
          <Input id={field.id} value={field.value} placeholder={field.hint} spellCheck={false} onChange={(event) => field.set(event.target.value)} />
        </label>
      ))}
      <ErrorLine error={url && !address ? "That isn't a web address." : error} />
      <DialogFooter>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !address}>
          {bookmark ? "Save" : "Add bookmark"}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** One bookmark: its title and site (opens it) and a menu. */
function BrowserBookmarksRow({ bookmark, onEdit, onRemove }: { bookmark: Bookmark; onEdit: () => void; onRemove: () => void }) {
  const site = siteOf(bookmark.url);
  return (
    <li data-slot="bookmark-row" className="flex min-h-11 items-center gap-3 py-1.5">
      <Globe aria-hidden className="size-icon-md shrink-0 text-quiet-foreground" />
      <button type="button" title={bookmark.url} onClick={() => openLink(bookmark.url)} className="flex min-w-0 flex-1 items-baseline gap-2 text-start text-label">
        <span className="truncate">{bookmark.title || site}</span>
        {bookmark.title && <span className="shrink-0 text-xs text-quiet-foreground">{site}</span>}
      </button>
      <RowMenu name={bookmark.title || site}>
        <DropdownMenuItem onClick={() => openLink(bookmark.url)}>
          <ExternalLink />
          Open
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
          <Pencil />
          Edit
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={onRemove}>
          <Trash />
          Remove bookmark
        </DropdownMenuItem>
      </RowMenu>
    </li>
  );
}

/** Settings › Browser › Bookmarks: one profile's bookmarks, by folder, imported ones among them. */
export function BrowserBookmarks({ profile: first }: { profile?: string | undefined }) {
  const { profiles, profile, setProfile } = useBrowserProfilePick(first);
  const [read, setRead] = useState<{ from: string; bookmarks: Bookmark[] } | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Bookmark | "new" | null>(null);

  // What another profile's read left isn't shown: the list is empty until this one's comes.
  const bookmarks = read?.from === profile ? read.bookmarks : null;
  const setBookmarks = (change: (shown: Bookmark[]) => Bookmark[]) => setRead((last) => last && { from: last.from, bookmarks: change(last.bookmarks) });

  useEffect(() => {
    if (!profile) return;
    browserBookmarks(profile).then(
      (found) => setRead({ from: profile, bookmarks: found }),
      (cause: unknown) => setError(errorText(cause)),
    );
  }, [profile]);

  const save = async (edit: BookmarkEdit) => {
    if (!profile || !editing) return;
    if (editing === "new") {
      const added = await addBookmark(profile, edit);
      setBookmarks((shown) => [...shown, added]);
    } else {
      await updateBookmark(profile, editing.id, edit);
      setBookmarks((shown) => shown.map((one) => (one.id === editing.id ? { ...one, ...edit } : one)));
    }
    setEditing(null);
  };

  const remove = (id: number) => {
    if (!profile) return;
    removeBookmark(profile, id)
      .then(() => setBookmarks((shown) => shown.filter((one) => one.id !== id)))
      .catch((cause: unknown) => setError(errorText(cause)));
  };

  const folders = bookmarkFolders(bookmarks ?? [], query);
  return (
    <SettingsPage title="Bookmarks" description="Pages you keep in Brigadier's browser, and the ones you import from other browsers." back={{ label: "Browser", href: "#settings/browser" }}>
      <div className="flex items-center gap-2">
        <SearchField label="Search bookmarks" value={query} onChange={setQuery} />
        <BrowserProfilePick profiles={profiles} profile={profile} onChange={setProfile} />
        <Button variant="soft" disabled={!profile} onClick={() => setEditing("new")}>
          <Plus />
          Add bookmark
        </Button>
      </div>
      <SettingsSection title="All bookmarks" aside={bookmarks ? String(bookmarks.length) : undefined}>
        <ErrorLine error={error} />
        {bookmarks && folders.length === 0 && (
          <SettingsCard>
            <EmptyState variant="card" title={query ? "No bookmarks match." : "Bookmarks you add or import show here."} />
          </SettingsCard>
        )}
        {folders.map((folder) => (
          <DayGroup key={folder.key} label={folder.label}>
            {folder.bookmarks.map((bookmark) => (
              <BrowserBookmarksRow key={bookmark.id} bookmark={bookmark} onEdit={() => setEditing(bookmark)} onRemove={() => remove(bookmark.id)} />
            ))}
          </DayGroup>
        ))}
      </SettingsSection>
      <BrowserBookmarksEdit open={editing !== null} bookmark={editing === "new" ? null : editing} onOpenChange={(open) => !open && setEditing(null)} onSave={save} />
    </SettingsPage>
  );
}
