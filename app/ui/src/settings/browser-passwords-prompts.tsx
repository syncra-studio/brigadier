import { type RefObject, useEffect, useState } from "react";

import { followLayout } from "../browser/follow";
import { answerSaveOffer, type OfferAnswer, passwordSite, type SaveOffer, useSaveOffers } from "../browser/passwords";
import { Button } from "../components/button";
import { Popover, PopoverContent } from "../components/popover";
import { Key } from "../icons";

/** A click meant for the page must not land on a card that just came up under it. */
const ARM_MS = 500;

function answer(offer: SaveOffer, choice: OfferAnswer): void {
  answerSaveOffer(offer, choice).catch((cause: unknown) => console.error("answering a password offer failed", cause));
}

/** 12px in from the page area's top end corner, as the old app's card sat. */
const INSET = 12;

/**
 * "Save this password?" over the page, after a sign-in in a tab the user drives; a tab an agent
 * drives never gets one. It shows the site and username, never the password.
 */
function BrowserPasswordsSavePrompt({ offer, anchor, onAnswer }: { offer: SaveOffer; anchor: RefObject<HTMLElement | null>; onAnswer: (answer: OfferAnswer) => void }) {
  const site = passwordSite(offer.site);
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_MS);
    return () => clearTimeout(timer);
  }, []);
  return (
    <PopoverContent
      anchor={anchor}
      side="bottom"
      align="end"
      sideOffset={({ anchor: box }) => INSET - box.height}
      alignOffset={INSET}
      data-slot="save-password-prompt"
      aria-label={offer.update ? `Update password for ${site}?` : `Save password for ${site}?`}
      // Not a menu: the page stays live around it.
      data-above-page
      padded={false}
      initialFocus={false}
      className="flex w-84 flex-col gap-3 p-4"
    >
      <div className="flex items-start gap-2.5">
        <Key aria-hidden className="mt-0.5 size-icon-md shrink-0 text-quiet-foreground" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium">{offer.update ? "Update this password?" : "Save this password?"}</span>
          <span className="truncate text-xs text-quiet-foreground" title={offer.username}>
            {offer.username ? `${offer.username} on ${site}` : site}
          </span>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1.5">
        {!offer.update && (
          <Button size="sm" variant="ghost" className="me-auto" disabled={!armed} onClick={() => onAnswer("never")}>
            Never for this site
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={!armed} onClick={() => onAnswer("notNow")}>
          Not now
        </Button>
        <Button size="sm" disabled={!armed} onClick={() => onAnswer("save")}>
          {offer.update ? "Update" : "Save"}
        </Button>
      </div>
    </PopoverContent>
  );
}

/**
 * What a tab has to say about passwords, in the top end corner of `anchor`, its page's area. It
 * leaves the page live around it (`data-above-page`), goes only when answered, and nothing shows
 * while the tab doesn't.
 */
export function BrowserPasswordsPrompts({ tab, anchor }: { tab: string; anchor: RefObject<HTMLElement | null> }) {
  const offer = useSaveOffers().findLast((one) => one.tab === tab);
  const [visible, setVisible] = useState(false);
  const shown = offer !== undefined;

  useEffect(() => {
    if (!shown) return;
    // The tab moves and resizes with the panels around it.
    return followLayout(
      () => [anchor.current],
      () => {
        const element = anchor.current;
        const box = element && !element.closest("[inert]") ? element.getBoundingClientRect() : null;
        setVisible(box !== null && box.width > 0 && box.height > 0);
      },
    );
  }, [anchor, shown]);

  if (!offer) return null;
  return (
    <Popover open={visible} onOpenChange={() => {}}>
      <BrowserPasswordsSavePrompt key={offer.id} offer={offer} anchor={anchor} onAnswer={(choice) => answer(offer, choice)} />
    </Popover>
  );
}
