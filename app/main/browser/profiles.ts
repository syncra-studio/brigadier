// A browser profile is a partition. A guest's partition can't change once it attaches, so a tab
// carries its profile id from the moment it's made.
const PREFIX = "persist:browser-profile-";
const STORAGE_NAME = "browser-profile-";

export function profilePartition(profileId: string): string {
  if (!/^[a-z0-9-]{1,64}$/.test(profileId)) throw new Error(`Bad profile id: ${profileId}`);
  return `${PREFIX}${profileId}`;
}

/** Whether a session's storage path belongs to a browser profile rather than the app's own pages. */
export function isProfilePartition(storagePath: string | null): boolean {
  return storagePath !== null && storagePath.includes(STORAGE_NAME);
}

/** The profile a session's storage path belongs to; null for the app's own pages. */
export function profileOfStorage(storagePath: string | null): string | null {
  return /[\\/]browser-profile-([a-z0-9-]{1,64})$/.exec(storagePath ?? "")?.[1] ?? null;
}

export type SitePermission = "ask" | "allow" | "block";
export type SiteDevice = "camera" | "microphone" | "location";
/** `location` is absent from what was saved before sites could ask for it. */
export type SiteChoice = { camera: SitePermission; microphone: SitePermission; location?: SitePermission; askedMs: number };
/** What a page asked for. */
export type SiteAsk = Record<SiteDevice, boolean>;
export type SiteAnswer = "grant" | "deny" | "ask";

/** A request goes by the site's saved choices for what it asks: a block refuses, all allowed grants. */
export function siteAnswer(site: SiteChoice | undefined, asked: SiteAsk): SiteAnswer {
  const devices = (["camera", "microphone", "location"] as const).filter((device) => asked[device]);
  if (devices.length === 0) return "deny";
  if (devices.some((device) => site?.[device] === "block")) return "deny";
  return devices.every((device) => site?.[device] === "allow") ? "grant" : "ask";
}
