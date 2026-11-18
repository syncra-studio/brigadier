import { useEffect, useState } from "react";

import { ProfileDisc, ProfileSwatches } from "../browser/profile-mark";
import { canDelete, makeDefaultProfile, profileCounts, type ProfileCounts, recolourProfile, renameProfile, sessionsOn, useDefaultProfile, useProfiles, useSessionPicks } from "../browser/profiles";
import { Button } from "../components/button";
import { Input } from "../components/input";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { Switch } from "../components/switch";
import { plural } from "../panel/words";
import { ClearBrowsingDataDialog } from "./browser-clear";
import { openBrowserSettings } from "./browser-parts";
import { ProfileDeleteDialog, useSessionIds } from "./browser-profile-dialogs";
import { SettingsPage, SettingsSection } from "./parts";

const BACK = "#settings/browser";
const back = () => void (window.location.hash = BACK);

/** Settings › Browser › one profile: its name and colour, what it holds, delete. */
export function ProfileDetailPage({ id }: { id: string }) {
  const profiles = useProfiles();
  const fallback = useDefaultProfile();
  const picks = useSessionPicks();
  const sessionIds = useSessionIds();
  const profile = profiles.find((each) => each.id === id);
  const [counts, setCounts] = useState<ProfileCounts | null>(null);
  const [read, setRead] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [name, setName] = useState(profile?.name ?? "");
  useEffect(() => {
    let current = true;
    profileCounts(id).then(
      (found) => current && setCounts(found),
      () => current && setCounts(null),
    );
    return () => {
      current = false;
    };
    // `read` reads the counts again after a clear.
  }, [id, read]);
  if (!profile) {
    return (
      <SettingsPage title="No such profile" back={{ label: "Browser", href: BACK }}>
        {null}
      </SettingsPage>
    );
  }
  const isDefault = fallback.id === id;
  const only = !canDelete(id);
  const sessions = sessionsOn(id, picks, sessionIds);
  const on = sessions === 0 ? "No sessions are on it." : sessions === 1 ? "1 session is on it." : `${sessions} sessions are on it.`;
  const saveName = () => {
    const trimmed = name.trim();
    const taken = profiles.some((each) => each.id !== id && each.name.toLowerCase() === trimmed.toLowerCase());
    if (!trimmed || taken) setName(profile.name);
    else if (trimmed !== profile.name) void renameProfile(id, trimmed);
  };
  return (
    <SettingsPage title={profile.name} mark={<ProfileDisc profile={profile} size="xl" />} description={`${isDefault ? "The default profile. " : ""}${on}`} back={{ label: "Browser", href: BACK }}>
      <SettingsSection>
        <SettingsCard>
          <SettingsRow label="Name">
            <Input
              aria-label="Name"
              value={name}
              maxLength={40}
              className="h-7 w-52"
              onChange={(event) => setName(event.target.value)}
              onBlur={saveName}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </SettingsRow>
          <SettingsRow label="Colour">
            <ProfileSwatches value={profile.hue} onChange={(hue) => void recolourProfile(id, hue)} />
          </SettingsRow>
          <SettingsRow label="Default for new sessions" description="One profile is always the default. To change it, turn this on for another profile.">
            <Switch checked={isDefault} disabled={isDefault} aria-label="Default for new sessions" onCheckedChange={(checked) => checked && void makeDefaultProfile(id)} />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Data in this profile">
        <SettingsCard>
          <SettingsRow label="Sign-ins" description={counts ? `${plural(counts.signIns, "site")} with cookies, not a count of accounts.` : undefined} />
          <SettingsRow label="Download history" description="The files this profile downloaded.">
            <Button variant="soft" size="sm" aria-label="Manage download history" onClick={() => openBrowserSettings("downloads", id)}>
              Manage
            </Button>
          </SettingsRow>
          <SettingsRow label="Site settings" description="Which sites may use your camera, microphone and location in this profile.">
            <Button variant="soft" size="sm" aria-label="Manage site settings" onClick={() => openBrowserSettings("sites", id)}>
              Manage
            </Button>
          </SettingsRow>
          <SettingsRow
            label="Browsing data"
            description="Clear this profile's sign-ins, site data, cache and download history, by time range. Other profiles aren't touched."
          >
            <Button variant="soft" size="sm" onClick={() => setClearing(true)}>
              Clear browsing data
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      <SettingsSection>
        <SettingsCard>
          <SettingsRow
            label="Delete this profile"
            description={only ? `The ${profiles.length === 1 ? "last" : "default"} profile can't be deleted. You can clear its data instead.` : "Removes it and its data from Brigadier."}
          >
            <Button variant="soft-destructive" size="sm" disabled={only} onClick={() => setDeleting(true)}>
              Delete profile…
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
      <ClearBrowsingDataDialog profile={id} open={clearing} onOpenChange={setClearing} onCleared={() => setRead((times) => times + 1)} />
      <ProfileDeleteDialog profile={profile} open={deleting} onOpenChange={setDeleting} onDeleted={back} />
    </SettingsPage>
  );
}
