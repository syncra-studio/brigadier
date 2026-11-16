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

/** What the page's permission check reads: only a saved Allow, and never location where there is none. */
export function checkAllows(origin: string | null, asked: SiteAsk, site: SiteChoice | undefined, platform: NodeJS.Platform): boolean {
  if (asked.location && !locationAvailable(platform)) return false;
  return origin !== null && siteAnswer(site, asked) === "grant";
}

export const cardAllows = (choice: CardAnswer): boolean => choice === "once" || choice === "visiting";

/** After the person's yes: a refusal goes to the page at once, and to the tab by name. */
export async function answerFromOs<Device extends string>({ refusedByOs, tell, answer }: {
  refusedByOs: () => Promise<Device[]>;
  tell: (refused: Device[]) => void;
  answer: (allowed: boolean) => void;
}): Promise<void> {
  let refused: Device[];
  try {
    refused = await refusedByOs();
  } catch {
    answer(false);
    return;
  }
  if (refused.length > 0) tell(refused);
  answer(refused.length === 0);
}
