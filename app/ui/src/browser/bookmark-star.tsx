import { useEffect, useState } from "react";

import { TooltipIconButton } from "../components/icon-button";
import { showToast } from "../components/toast";
import { Star, StarFilled } from "../icons";
import { errorText } from "../onboarding/api";
import { type Tab } from "../shell/tab-store";
import { bookmarkPage, isBookmarked, unbookmarkPage, useBookmarkChanges } from "./bookmarks";
import { known, useProfiles, useSessionProfile } from "./profiles";

const web = (url: string) => /^https?:\/\//i.test(url);

/** The profile a tab's page is on: its own, else its session's (the old tabProfileId). */
export function useTabProfile(owner: string, tab: Tab): string {
  useProfiles();
  const session = useSessionProfile(owner);
  return known(tab.profile) ?? session;
}

/** The address field's star: fills when the page is bookmarked in the tab's profile, and a press adds or removes it. */
export function BookmarkStar({ owner, tab, url, title }: { owner: string; tab: Tab; url: string; title: string }) {
  const profile = useTabProfile(owner, tab);
  const changes = useBookmarkChanges();
  const [read, setRead] = useState<{ url: string; marked: boolean } | null>(null);
  useEffect(() => {
    if (!web(url)) return;
    let current = true;
    isBookmarked(profile, url).then(
      (marked) => current && setRead({ url, marked }),
      (cause: unknown) => console.error("reading bookmarks failed", cause),
    );
    return () => {
      current = false;
    };
  }, [profile, url, changes]);
  if (!web(url)) return null;
  const marked = read?.url === url && read.marked;
  return (
    <TooltipIconButton
      tooltip={marked ? "Remove bookmark" : "Bookmark this page"}
      size="icon-md"
      data-slot="bookmark-star"
      aria-pressed={marked}
      className="shrink-0 rounded-capsule @max-md/browser-toolbar:hidden"
      // Typing goes on after the click.
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        (marked ? unbookmarkPage(profile, url) : bookmarkPage(profile, url, title)).catch((cause: unknown) => showToast(errorText(cause), { tone: "error" }));
      }}
    >
      {marked ? <StarFilled /> : <Star />}
    </TooltipIconButton>
  );
}
