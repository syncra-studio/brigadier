import { run, store } from "../onboarding/api";

/*
 * Saved passwords of the built-in browser, by profile, in Rust's vault (`brigadier browser vault`). A list holds
 * sites and usernames only: a password reaches the app only when the user asks to see that one and the system
 * check passes. An offer to save holds its password here, outside the offer and React, until it is answered or
 * goes. No agent tool reads any of this.
 */

const vault = (profile: string, args: string[]) => run(["browser", "-", "vault", ...args, "--profile", profile]);

/** How long an offer to save waits for an answer before it goes, with its password. */
const OFFER_MS = 120_000;

export type SavedPassword = {
  id: number;
  /** The address it fills on, such as `https://github.com`. */
  site: string;
  username: string;
};

/** What asking to see a password came to. */
export type Reveal =
  | { kind: "shown"; password: string }
  /** The user cancelled the system's check, or it failed. */
  | { kind: "declined" }
  /** This Mac has no Touch ID to ask, or it can't be used now. */
  | { kind: "unavailable" };

/** The browser saw a sign-in in a tab the user is driving. Its password is held apart (`offerSignIn`). */
export type SaveOffer = {
  id: string;
  /** The Browser tab it came from: it shows only over that tab's page. */
  tab: string;
  profile: string;
  site: string;
  username: string;
  /** The site and username are saved already, with another password. */
  update: boolean;
};

export type OfferAnswer = "save" | "notNow" | "never";

export async function savedPasswords(profile: string): Promise<SavedPassword[]> {
  return (await vault(profile, ["list"])).logins as SavedPassword[];
}

export async function addPassword(profile: string, site: string, username: string, password: string): Promise<void> {
  await vault(profile, ["add", site, username, password]);
}

export async function removePassword(profile: string, id: number): Promise<void> {
  await vault(profile, ["remove", String(id)]);
}

/** Runs the system's check where the platform has one, then gives the one password. */
export async function revealPassword(profile: string, entry: SavedPassword): Promise<Reveal> {
  const checked = await window.brigadierShell.logins("check", { reason: `show your password for ${new URL(entry.site).host}` });
  if (checked !== "passed") return { kind: checked };
  const { password } = await vault(profile, ["reveal", String(entry.id)]);
  return { kind: "shown", password: password as string };
}

/** The sites this profile never offers to save on. */
export async function neverSites(profile: string): Promise<string[]> {
  return (await vault(profile, ["never"])).never as string[];
}

export async function allowSite(profile: string, site: string): Promise<void> {
  await vault(profile, ["allow", site]);
}

/** The offers waiting, newest last. */
const offers = store<SaveOffer[]>([]);
export const useSaveOffers = offers.use;
export const saveOffers = offers.get;
/** Each waiting offer's password and the timer that lets it go. */
const held = new Map<string, { password: string; timer: ReturnType<typeof setTimeout> }>();

function forget(id: string): void {
  clearTimeout(held.get(id)?.timer);
  held.delete(id);
}

export function showSaveOffer(offer: SaveOffer): void {
  offers.set([...offers.get().filter((other) => other.id !== offer.id), offer]);
}

export function dropSaveOffer(id: string): void {
  forget(id);
  offers.set(offers.get().filter((offer) => offer.id !== id));
}

/** Offers to save a sign-in, holding its password until the offer is answered or `OFFER_MS` passes. */
export function offerSignIn(offer: SaveOffer, password: string): void {
  forget(offer.id);
  held.set(offer.id, { password, timer: setTimeout(() => dropSaveOffer(offer.id), OFFER_MS) });
  showSaveOffer(offer);
}

/** Answers an offer. Whatever the answer, its password is then forgotten. */
export async function answerSaveOffer(offer: SaveOffer, answer: OfferAnswer): Promise<void> {
  const password = held.get(offer.id)?.password;
  dropSaveOffer(offer.id);
  if (answer === "save" && password !== undefined) await vault(offer.profile, ["add", offer.site, offer.username, password]);
  else if (answer === "never") await vault(offer.profile, ["never-add", offer.site]);
}

/** A site as the lists show it: its host without "www.". */
export function passwordSite(site: string): string {
  try {
    return new URL(site).host.replace(/^www\./, "");
  } catch {
    return site;
  }
}

/** The passwords whose site or username holds every word of `query`, by site then username. */
export function findPasswords(passwords: readonly SavedPassword[], query: string): SavedPassword[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return passwords
    .filter((entry) => {
      const text = `${passwordSite(entry.site)} ${entry.username}`.toLowerCase();
      return words.every((word) => text.includes(word));
    })
    .toSorted((a, b) => passwordSite(a.site).localeCompare(passwordSite(b.site)) || a.username.localeCompare(b.username));
}

/** What the user typed as a site, as an address: only http and https can hold a password. */
export function siteAddress(typed: string): string | null {
  const text = typed.trim();
  if (!text) return null;
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host ? url.origin : null;
  } catch {
    return null;
  }
}
