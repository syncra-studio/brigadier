import { useState } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from "../components/menu";
import { useDaemon } from "../daemon";
import { Check } from "../icons";
import { ProfileDialog } from "../settings/browser-profile-dialogs";
import { openSettings } from "../settings/shell";
import { type Tab } from "../shell/tab-store";
import { keysOf } from "../shortcuts";
import { ProfileDisc } from "./profile-mark";

import { known, switchProfile, useDefaultProfile, useProfiles, useSessionProfile } from "./profiles";

/** A profile's key in the menu: ⌥⌘1 to ⌥⌘9. */
export const profileKeyLabel = (index: number) => keysOf("switch-profile")[0]!.replace("1–9", String(index + 1));

/** The toolbar's profile button and its menu: which profile the tab is on, and the others to switch it to. */
export function ProfileButton({ owner, tab }: { owner: string; tab: Tab }) {
  const profiles = useProfiles();
  const fallback = useDefaultProfile();
  const session = useSessionProfile(owner);
  const current = profiles.find((each) => each.id === (known(tab.profile) ?? session)) ?? fallback;
  const driver = useDaemon().rows?.find((row) => row.id === tab.driver)?.title ?? (tab.driver ? "The agent" : null);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <TooltipIconButton
              tooltip={`Profile: ${current.name}`}
              size="icon-md"
              data-slot="browser-profile-button"
              className="shrink-0 rounded-full! bg-control ring-1 ring-glass-stroke ring-inset data-popup-open:bg-fill"
            />
          }
        >
          <ProfileDisc profile={current} size="lg" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" data-slot="browser-profiles" className="w-browser-profiles">
          <div className="flex flex-col gap-0.5 px-2 pt-1.5 pb-2">
            {driver ? (
              <>
                <span className="text-label font-medium">{driver} is working in {current.name}</span>
                <span className="text-xs text-muted-foreground">
                  It uses this profile's sign-ins. Picking another profile opens a new tab there, and {driver}'s next tabs follow.
                </span>
              </>
            ) : (
              <>
                <span className="text-label font-medium">Profile for this tab</span>
                <span className="text-xs text-muted-foreground">The tab reopens in the profile you pick. New tabs in this session follow it. Other tabs stay as they are.</span>
              </>
            )}
          </div>
          <DropdownMenuSeparator className="mx-2" />
          {profiles.map((profile, index) => (
            <DropdownMenuItem key={profile.id} className="h-browser-menu-item" onClick={() => void switchProfile(owner, profile.id)}>
              <ProfileDisc profile={profile} />
              <span className="min-w-0 flex-1 truncate">{profile.name}</span>
              {profile.id === fallback.id && <span className="text-xs text-muted-foreground">Default</span>}
              {profile.id === current.id ? <Check className="size-icon-md" /> : index < 9 && <DropdownMenuShortcut>{profileKeyLabel(index)}</DropdownMenuShortcut>}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator className="mx-2" />
          <DropdownMenuItem className="h-browser-menu-item" onClick={() => setCreating(true)}>
            New profile…
          </DropdownMenuItem>
          <DropdownMenuItem className="h-browser-menu-item" onClick={() => openSettings("browserImport")}>
            Import Browser Data…
          </DropdownMenuItem>
          <DropdownMenuItem className="h-browser-menu-item" onClick={() => openSettings("browser")}>
            Manage profiles
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <ProfileDialog open={creating} onOpenChange={setCreating} onCreated={(id) => void switchProfile(owner, id)} />
    </>
  );
}
