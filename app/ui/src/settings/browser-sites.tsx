import { useEffect, useState } from "react";

import { type BrowserSite, browserSites, setSite, type SitePermission } from "../browser/data";
import { useDefaultProfile } from "../browser/profiles";
import { EmptyState } from "../components/empty-state";
import { ErrorLine } from "../components/error-line";
import { Select } from "../components/select";
import { SettingsCard } from "../components/settings-card";
import { Camera, MapPin, Mic } from "../icons/browser";
import { errorText } from "../onboarding/api";
import { ProfilePicker } from "./browser-clear";
import { dataBack } from "./browser-parts";
import { SettingsPage, SettingsSection } from "./parts";

type Device = "camera" | "microphone" | "location";

const CHOICES = [
  { value: "ask", label: "Ask" },
  { value: "allow", label: "Allow" },
  { value: "block", label: "Block" },
] as const satisfies readonly { value: SitePermission; label: string }[];

const DEVICES = [
  { device: "camera", name: "Camera", Icon: Camera },
  { device: "microphone", name: "Microphone", Icon: Mic },
  { device: "location", name: "Location", Icon: MapPin },
] as const;

/** One site in Site settings: its origin and what it may use: the camera, the microphone and location. */
function SiteRow({ site, onChoose }: { site: BrowserSite; onChoose: (device: Device, choice: SitePermission) => void }) {
  return (
    <li className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 py-2">
      <span className="min-w-0 flex-1 truncate text-label" title={site.origin}>
        {site.origin.replace(/^https:\/\//, "")}
      </span>
      {DEVICES.map(({ device, name, Icon }) => (
        <span key={device} className="flex items-center gap-2">
          <Icon aria-hidden className="size-icon-sm text-quiet-foreground" />
          <Select label={`${name} for ${site.origin}`} value={site[device]} options={CHOICES} onChange={(choice) => onChoose(device, choice)} />
        </span>
      ))}
    </li>
  );
}

/**
 * Settings › Browser › Site settings: every site that asked for the camera, microphone or location in a
 * profile, and what each may use there. Another profile's choices for the same site are its own.
 */
export function BrowserSiteSettings({ profile: opened }: { profile?: string | undefined }) {
  const fallback = useDefaultProfile();
  const [profile, setProfile] = useState(opened ?? fallback.id);
  const [sites, setSites] = useState<BrowserSite[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    browserSites(profile).then(
      (found) => current && setSites(found),
      (cause: unknown) => current && setError(errorText(cause)),
    );
    return () => {
      current = false;
    };
  }, [profile]);

  const choose = (origin: string, device: Device, choice: SitePermission) => {
    setError(null);
    setSite(profile, origin, { [device]: choice })
      .then(() => setSites((shown) => shown?.map((site) => (site.origin === origin ? { ...site, [device]: choice } : site)) ?? null))
      .catch((cause: unknown) => setError(errorText(cause)));
  };

  return (
    <SettingsPage title="Site settings" description="Which sites may use your camera, microphone and location, for each profile." back={dataBack(opened)}>
      <SettingsSection>
        <ProfilePicker value={profile} onChange={setProfile} />
      </SettingsSection>
      <SettingsSection title="Camera, microphone and location">
        <ErrorLine error={error} />
        {sites && sites.length === 0 ? (
          <SettingsCard>
            <EmptyState variant="card" title="Sites that ask for your camera, microphone or location show here. Until you choose, each asks you first." />
          </SettingsCard>
        ) : (
          <SettingsCard inset>
            <ul className="divide-y divide-divider">
              {(sites ?? []).map((site) => (
                <SiteRow key={site.origin} site={site} onChoose={(device, choice) => choose(site.origin, device, choice)} />
              ))}
            </ul>
          </SettingsCard>
        )}
      </SettingsSection>
    </SettingsPage>
  );
}
