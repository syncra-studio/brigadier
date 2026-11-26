// A site permission's decisions, with no Electron in them: permissions.ts and browserPermissionsOs.ts carry them out.
import { type SiteAnswer, siteAnswer, type SiteAsk, type SiteChoice } from "./profiles";

export type CardAnswer = "once" | "visiting" | "never" | "dismiss";
export type RequestDecision = SiteAnswer | "not-the-tabs-site" | "no-location";

/** Linux has no location: Chromium goes to Google's paid service there, which would need a key in the app (Electron's GOOGLE_API_KEY). */
export const locationAvailable = (platform: NodeJS.Platform): boolean => platform !== "linux";

/** A question names one site, the tab's: another site's frame asking gets no question, and a page with no tab no door. */
export function decideRequest(request: {
  origin: string | null;
  top: string | null;
  hasTab: boolean;
  asked: SiteAsk;
  site: SiteChoice | undefined;
  platform: NodeJS.Platform;
}): RequestDecision {
  const { origin, top, hasTab, asked, site, platform } = request;
  if (!origin || origin !== top || !hasTab) return "not-the-tabs-site";
  // Before any card: a yes here couldn't bring a position.
  if (asked.location && !locationAvailable(platform)) return "no-location";
  return siteAnswer(site, asked);
}

/** What the page's permission check reads: only an Allow while visiting, and never location where there is none. */
export function checkAllows(origin: string | null, asked: SiteAsk, site: SiteChoice | undefined, platform: NodeJS.Platform): boolean {
  if (asked.location && !locationAvailable(platform)) return false;
  return origin !== null && siteAnswer(site, asked) === "grant";
}

export type LocationStatus = "off" | "undetermined" | "denied" | "restricted" | "allowed" | "unavailable";
/** Why macOS gave no location, for the tab's words; a plain refusal (denied) has none. */
export type LocationWhy = "off" | "restricted" | "unanswered" | "unavailable";

/**
 * macOS's answer about location, asked when it has none yet (the old app's wait, D516): Location Services is read once,
 * then only the app's answer, every `readMs` until `answerMs`. Still undetermined then is unanswered.
 */
export async function locationRefusal(
  read: () => LocationStatus,
  poll: () => LocationStatus,
  ask: () => void,
  { answerMs = 120_000, readMs = 250 }: { answerMs?: number; readMs?: number } = {},
): Promise<LocationWhy | "denied" | null> {
  let status = read();
  if (status === "undetermined") {
    ask();
    const until = Date.now() + answerMs;
    while (status === "undetermined" && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, readMs));
      status = poll();
    }
  }
  if (status === "allowed") return null;
  return status === "undetermined" ? "unanswered" : status;
}

export const cardAllows = (choice: CardAnswer): boolean => choice === "once" || choice === "visiting";

/** After the person's yes: a refusal goes to the page at once, and to the tab by name, with location's why. */
export async function answerFromOs<Device extends string>({ refusedByOs, tell, answer }: {
  refusedByOs: () => Promise<{ refused: Device[]; why?: LocationWhy }>;
  tell: (refused: Device[], why?: LocationWhy) => void;
  answer: (allowed: boolean) => void;
}): Promise<void> {
  let result: { refused: Device[]; why?: LocationWhy };
  try {
    result = await refusedByOs();
  } catch {
    answer(false);
    return;
  }
  if (result.refused.length > 0) tell(result.refused, result.why);
  answer(result.refused.length === 0);
}
