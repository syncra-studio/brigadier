// The right panel's icons, copied from @openai/apps-sdk-ui 0.2.2 (MIT, see THIRD_PARTY_NOTICES.md).
import type { IconProps } from ".";
import { PullRequestClosed, PullRequestDraft, PullRequestMerged, PullRequestOpen } from "../landing/icons";

// Shared with the landing views, which drew them first.
export { Clock, PullRequestClosed, PullRequestMerged, PullRequestOpen, Sparkles } from "../landing/icons";

/** A PR's state as GitHub says it, in its icon, word and colour: Open, Draft, Merged, Closed [D202]. */
export const PR_LOOK = {
  open: { Icon: PullRequestOpen, tint: "text-success" },
  draft: { Icon: PullRequestDraft, tint: "text-muted-foreground" },
  merged: { Icon: PullRequestMerged, tint: "text-pr-purple" },
  closed: { Icon: PullRequestClosed, tint: "text-destructive" },
};
/** Publish Branch: an arrow up out of a circle. */
export function Publish(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M4 12C4 7.58172 7.58172 4 12 4C16.4183 4 20 7.58172 20 12C20 16.4183 16.4183 20 12 20C7.58172 20 4 16.4183 4 12ZM12 2C6.47715 2 2 6.47715 2 12C2 17.5228 6.47715 22 12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2ZM16.2071 10.7929L12.7071 7.29289C12.3166 6.90237 11.6834 6.90237 11.2929 7.29289L7.79289 10.7929C7.40237 11.1834 7.40237 11.8166 7.79289 12.2071C8.18342 12.5976 8.81658 12.5976 9.20711 12.2071L11 10.4142V16C11 16.5523 11.4477 17 12 17C12.5523 17 13 16.5523 13 16V10.4142L14.7929 12.2071C15.1834 12.5976 15.8166 12.5976 16.2071 12.2071C16.5976 11.8166 16.5976 11.1834 16.2071 10.7929Z" />
    </svg>
  );
}

/** Sync Changes: two arrows round (apps-sdk-ui LoopXs without its play mark). */
export function SyncGlyph(props: IconProps) {
  return (
    <svg width="1em" height="1em" viewBox="0 0 18 18" fill="currentColor" aria-hidden {...props}>
      <path d="M3.5232 7.72593C4.09848 5.24525 6.31862 3.40002 8.9641 3.40002C10.407 3.40002 11.7225 3.94789 12.7148 4.85H12.3498C11.8528 4.85 11.4498 5.25294 11.4498 5.75C11.4498 6.24706 11.8528 6.65 12.3498 6.65H15.0998C15.5969 6.65 15.9998 6.24706 15.9998 5.75V3C15.9998 2.50294 15.5969 2.1 15.0998 2.1C14.6028 2.1 14.1998 2.50294 14.1998 3V3.50056C12.8394 2.20035 10.9952 1.40002 8.9641 1.40002C5.36475 1.40002 2.35508 3.90995 1.5749 7.27411C1.45014 7.81212 1.78513 8.3494 2.32314 8.47417C2.86115 8.59894 3.39843 8.26394 3.5232 7.72593Z" />
      <path d="M16.3533 10.7259C16.4781 10.1879 16.1431 9.65064 15.6051 9.52588C15.0671 9.40111 14.5298 9.7361 14.405 10.2741C13.8297 12.7548 11.6096 14.6 8.9641 14.6C7.52121 14.6 6.20567 14.0521 5.21336 13.15H5.65061C6.14767 13.15 6.55061 12.7471 6.55061 12.25C6.55061 11.7529 6.14767 11.35 5.65061 11.35H2.90061C2.40356 11.35 2.00061 11.7529 2.00061 12.25V15C2.00061 15.4971 2.40356 15.9 2.90061 15.9C3.39767 15.9 3.80061 15.4971 3.80061 15V14.5676C5.15377 15.8276 6.96875 16.6 8.9641 16.6C12.5635 16.6 15.5731 14.0901 16.3533 10.7259Z" />
    </svg>
  );
}
