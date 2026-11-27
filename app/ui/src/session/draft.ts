import { draftState } from "../../../shared/session/draft";
import { uncertain } from "./uncertain";

export { type Given, HOME_DRAFT } from "../../../shared/session/draft";

/** This Mac's drafts (app/shared/session/draft.ts). */
export const drafts = draftState(uncertain);
export const { draftOf, revOf, givenRefused, givenError, onGiven, resyncDraft, takeBack, keepDraft, moveDraft, oldProject, loadDraft } = drafts;
// The chip store's, set by it: imported here, it would reach the tab store, which reads HOME_DRAFT as it loads.
export const { onChipsBack, giveChips, keptChipsBack } = uncertain;
