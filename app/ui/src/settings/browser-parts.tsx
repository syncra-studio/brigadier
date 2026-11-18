import { store } from "../onboarding/api";

/** Clear browsing data is a dialog over Settings › Browser, never a route of its own. */
const clearing = store(false);
export const useClearingBrowsingData = clearing.use;
export const setClearingBrowsingData = (open: boolean) => clearing.set(open);

/** Shows Settings › Browser, with Clear browsing data open over it for "clear". */
export function openBrowserSettings(view?: "clear"): void {
  if (view === "clear") clearing.set(true);
  window.location.hash = "#settings/browser";
}
