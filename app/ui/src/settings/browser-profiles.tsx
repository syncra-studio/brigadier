import { DragDropProvider } from "@dnd-kit/react";
import { isSortable, useSortable } from "@dnd-kit/react/sortable";
import { useEffect, useState } from "react";

import { importOrigins } from "../browser/imports";
import { ProfileDisc, ProfileSwatches } from "../browser/profile-mark";
import { type BrowserProfile, makeDefaultProfile, moveProfile, recolourProfile, sessionsOn, useDefaultProfile, useProfiles, useSessionPicks } from "../browser/profiles";
import { Badge } from "../components/badge";
import { Button } from "../components/button";
import { cx } from "../components/cx";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/menu";
import { Select } from "../components/select";
import { RowText, SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { ChevronRight, DotsHorizontal, Plus } from "../icons";
import { DragDots } from "../icons/note";
import { plural } from "../panel/words";
import { ClearBrowsingDataDialog } from "./browser-clear";
import { ProfileDeleteDialog, ProfileDialog, useSessionIds } from "./browser-profile-dialogs";
import { SettingsSection } from "./parts";
import { openSettings } from "./shell";

/** How a profile started and how many sessions are on it. */
export const profileLine = (sessions: number, importedFrom?: string): string =>
  `${importedFrom ? `Imported from ${importedFrom}` : "Started empty"} · ${sessions === 0 ? "No sessions" : plural(sessions, "session")}`;

export const profileHref = (id: string) => `#settings/browser/profile/${encodeURIComponent(id)}`;

/** Settings › Browser's Profiles: the list to reorder and open, and which one new sessions start on. */
export function ProfilesSection() {
  const profiles = useProfiles();
  const fallback = useDefaultProfile();
  const picks = useSessionPicks();
  const sessions = useSessionIds();
  const [creating, setCreating] = useState(false);
  const [origins, setOrigins] = useState<Partial<Record<string, string>>>({});
  useEffect(() => void importOrigins().then(setOrigins), []);
  return (
    <SettingsSection
      title="Profiles"
      setting="Profiles"
      description="Each profile keeps its own sign-ins."
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={() => openSettings("browserImport")}>
            Import…
          </Button>
          <Button variant="soft" size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-icon-sm" />
            New profile
          </Button>
        </>
      }
    >
      <SettingsCard>
        <DragDropProvider
          onDragEnd={({ operation, canceled }) => {
            const { source } = operation;
            if (!canceled && isSortable(source) && source.index !== source.initialIndex) moveProfile(String(source.id), source.index);
          }}
        >
          {profiles.map((profile, index) => (
            <ProfileRow
              key={profile.id}
              profile={profile}
              index={index}
              count={profiles.length}
              isDefault={profile.id === fallback.id}
              sessions={sessionsOn(profile.id, picks, sessions)}
              importedFrom={origins[profile.id]}
            />
          ))}
        </DragDropProvider>
      </SettingsCard>
      <SettingsCard>
        <SettingsRow label="New sessions start on" description="You can switch any session from the browser toolbar">
          <Select label="New sessions start on" value={fallback.id} onChange={(id) => void makeDefaultProfile(id)} options={profiles.map((profile) => ({ value: profile.id, label: profile.name }))} />
        </SettingsRow>
      </SettingsCard>
      <ProfileDialog open={creating} onOpenChange={setCreating} />
    </SettingsSection>
  );
}

function ProfileRow({ profile, index, count, isDefault, sessions, importedFrom }: { profile: BrowserProfile; index: number; count: number; isDefault: boolean; sessions: number; importedFrom: string | undefined }) {
  const { ref, handleRef, isDragging } = useSortable({ id: profile.id, index, disabled: count < 2 });
  const [renaming, setRenaming] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const only = count === 1;
  return (
    <div ref={ref} data-slot="profile-row" data-profile={profile.id} className={cx("flex items-center gap-3 bg-card px-4 py-3", isDragging && "opacity-80")}>
      <button
        ref={handleRef}
        type="button"
        aria-label={`Move ${profile.name}`}
        disabled={count < 2}
        onKeyDown={(event) => {
          const to = index + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0);
          if (isDragging || to === index || to < 0 || to >= count) return;
          event.preventDefault();
          moveProfile(profile.id, to);
        }}
        className="flex shrink-0 cursor-grab touch-none items-center text-muted-foreground active:cursor-grabbing disabled:cursor-default"
      >
        <DragDots className="h-3.5 w-2.5" />
      </button>
      <ProfileDisc profile={profile} size="lg" />
      <a href={profileHref(profile.id)} className="flex min-w-0 flex-1 text-start focus-visible:focus-ring">
        <RowText
          title={
            <span className="flex items-center gap-2">
              {profile.name}
              {isDefault && (
                <Badge variant="secondary" className="font-normal">
                  Default
                </Badge>
              )}
            </span>
          }
          line={profileLine(sessions, importedFrom)}
        />
      </a>
      <div className="flex shrink-0 items-center gap-1">
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`${profile.name} options`} className="text-muted-foreground data-popup-open:bg-fill" />}>
            <DotsHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60" data-slot="profile-row-menu">
            <DropdownMenuItem onClick={() => setRenaming(true)}>Rename</DropdownMenuItem>
            <div role="group" aria-label="Colour" className="p-2">
              <ProfileSwatches value={profile.hue} onChange={(hue) => void recolourProfile(profile.id, hue)} />
            </div>
            <DropdownMenuSeparator className="mx-2" />
            <DropdownMenuItem disabled={isDefault} onClick={() => void makeDefaultProfile(profile.id)}>
              Make default
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setClearing(true)}>Clear browsing data</DropdownMenuItem>
            <DropdownMenuItem onClick={() => (window.location.hash = profileHref(profile.id))}>Open details</DropdownMenuItem>
            <DropdownMenuSeparator className="mx-2" />
            <DropdownMenuItem variant="destructive" disabled={only || isDefault} onClick={() => setDeleting(true)}>
              {only ? "Delete (last profile)" : isDefault ? "Delete (default profile)" : "Delete"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ChevronRight aria-hidden className="size-icon-sm text-muted-foreground" />
      </div>
      <ProfileDialog open={renaming} onOpenChange={setRenaming} editing={profile} />
      <ClearBrowsingDataDialog profile={profile.id} open={clearing} onOpenChange={setClearing} />
      <ProfileDeleteDialog profile={profile} open={deleting} onOpenChange={setDeleting} />
    </div>
  );
}
