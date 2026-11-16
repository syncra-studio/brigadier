import { run } from "../onboarding/api";
import { tabAnywhere } from "../shell/tab-store";
import { isDriven, onPauseChanged } from "./pause";
import { answerSaveOffer, offerSignIn, saveOffers } from "./passwords";
import { defaultOf, known } from "./profiles";

/*
 * The app's half of saved passwords on a page (the old app's renderer guestLogins.ts): only here is it known whether an
 * agent drives a tab (isDriven), and only here is Rust's vault reached. A tab it drives gets no fill and no offer; a tab
 * the user has taken over counts as theirs, and fills on the takeover.
 */

type Login = { username: string; password: string; usedMs: number };
const failed = (cause: unknown) => console.error("saved passwords on a page failed", cause);
const profileOf = (tab: string) => known(tabAnywhere(tab)?.tab.profile) ?? defaultOf().id;
const vault = async (tab: string, args: string[]) => run(["browser", "-", "vault", ...args, "--profile", profileOf(tab)]);

/** The site's saved logins, and whether it asked never to be offered a save. */
const saved = async (tab: string, site: string) => (await vault(tab, ["fill", site])) as { logins: Login[]; never: boolean };

export function installGuestLogins(tabOf: (guest: number) => string | null): void {
  /** Tabs whose page has sign-in boxes it couldn't fill because an agent drove them: their guest and site. */
  const waiting = new Map<string, { guest: number; site: string }>();
  const fill = (tab: string, guest: number, site: string) => {
    if (isDriven(tab)) {
      waiting.set(tab, { guest, site });
      return;
    }
    waiting.delete(tab);
    saved(tab, site)
      .then(({ logins }) => (logins.length > 0 ? window.brigadierShell.logins("fill", { guest, site, logins }) : undefined))
      .catch(failed);
  };
  // A sign-in worked: the same login only gets its date, and anything else asks, unless the site is on the never list.
  const signedIn = async (tab: string, site: string, username: string, password: string) => {
    const { logins, never } = await saved(tab, site);
    if (never) return;
    const login = logins.find((one) => one.username === username);
    if (login?.password === password) {
      await vault(tab, ["used", site, username]);
      return;
    }
    offerSignIn({ id: crypto.randomUUID(), tab, profile: profileOf(tab), site, username, update: login !== undefined }, password);
  };
  window.brigadierShell.onGuestLogin(({ from, kind, site, username, password }) => {
    const tab = tabOf(from);
    if (!tab) return;
    if (kind === "fields") fill(tab, from, site);
    else if (kind === "signed-in" && password && !isDriven(tab)) signedIn(tab, site, username ?? "", password).catch(failed);
  });
  onPauseChanged(() => {
    for (const [tab, { guest, site }] of waiting) if (!isDriven(tab)) fill(tab, guest, site);
    // Continue hands the tab back: an offer still up goes, and its password with it.
    for (const offer of saveOffers()) {
      if (isDriven(offer.tab)) answerSaveOffer(offer, "notNow").catch(failed);
    }
  });
}
