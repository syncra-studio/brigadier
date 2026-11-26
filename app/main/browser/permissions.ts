// What a web page may have. The camera, microphone and location go by the site's answer earlier in this run, then
// a question in the tab, then the system's; everything else not listed is refused: no handler at all would mean
// Electron grants it.
import type { Session, WebContents } from "electron";

import { handleFromApp, isAppPage } from "./appPage";
import { openOsSettings, type OsDevice, refusedByOs } from "./browserPermissionsOs";
import { answerFromOs, cardAllows, type CardAnswer, checkAllows, decideRequest, type LocationWhy } from "./browserPermissionsRules";
import { profileOfStorage, type SiteAsk, type SiteChoice } from "./profiles";

const ALLOWED = new Set<string>(["fullscreen", "clipboard-sanitized-write", "pointerLock"]);

type Question = { profileId: string; guest: WebContents; origin: string; asked: SiteAsk; answer: (allowed: boolean) => void };

let nextQuestion = 1;
const questions = new Map<number, Question>();
const watched = new WeakSet<WebContents>();
/** The site each tab was last told about a location refusal with no card (a store finder's timer): once, until it leaves. */
const toldLocation = new WeakMap<WebContents, string>();

/** Each profile's Allow while visiting the site and Don't allow, until Brigadier quits: nothing saves them, as Settings has no page for them [D731]. */
const siteAnswers = new Map<string, Map<string, SiteChoice>>();
const siteChoice = (profileId: string, origin: string): SiteChoice | undefined => siteAnswers.get(profileId)?.get(origin);

function originOf(url: string): string | null {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/** Tells the tab why the site can't have it; not once the tab has left the site (macOS may answer minutes later). */
function tell(guest: WebContents, origin: string, refused: OsDevice[], why: LocationWhy | undefined, carded: boolean): void {
  if (guest.isDestroyed() || originOf(guest.getURL()) !== origin) return;
  if (!carded && refused.includes("location")) {
    if (toldLocation.get(guest) === origin) return;
    toldLocation.set(guest, origin);
  }
  guest.hostWebContents?.send("brigadier:guest-permission-refused", { from: guest.id, origin, refused, ...(why ? { why } : {}) });
}

/** The system's own question comes only after the person's yes to ours: the first thing they see is ours. */
function grant(guest: WebContents, origin: string, asked: SiteAsk, answer: (allowed: boolean) => void, carded: boolean): void {
  void answerFromOs({ refusedByOs: () => refusedByOs(asked), tell: (refused, why) => tell(guest, origin, refused, why, carded), answer });
}

function dropQuestions(guest: WebContents, unlessOrigin: string | null): void {
  for (const [request, question] of questions) {
    if (question.guest !== guest || question.origin === unlessOrigin) continue;
    questions.delete(request);
    question.answer(false);
  }
}

/** Leaving the site ends its open question. */
function watchGuest(guest: WebContents): void {
  if (watched.has(guest)) return;
  watched.add(guest);
  guest.on("did-start-navigation", (details) => {
    if (!details.isMainFrame) return;
    const to = originOf(details.url);
    if (toldLocation.get(guest) !== to) toldLocation.delete(guest);
    dropQuestions(guest, to);
  });
  guest.once("destroyed", () => dropQuestions(guest, null));
}

function request(permission: string, profileId: string, guest: WebContents, requestingUrl: string, asked: SiteAsk, answer: (allowed: boolean) => void): void {
  const origin = originOf(requestingUrl);
  const host = guest.hostWebContents;
  const site = origin ? siteChoice(profileId, origin) : undefined;
  const decided = decideRequest({ origin, top: originOf(guest.getURL()), hasTab: !!host, asked, site, platform: process.platform });
  if (decided === "not-the-tabs-site" || !origin || !host) {
    console.warn("Permission refused, not the tab's own site:", permission, origin);
    answer(false);
    return;
  }
  watchGuest(guest);
  if (decided === "no-location") {
    tell(guest, origin, ["location"], undefined, false);
    answer(false);
    return;
  }
  if (decided === "grant") {
    grant(guest, origin, asked, answer, false);
    return;
  }
  if (decided === "deny") {
    answer(false);
    return;
  }
  const number = nextQuestion++;
  questions.set(number, { profileId, guest, origin, asked, answer });
  host.send("brigadier:guest-permission", { from: guest.id, request: number, origin, ...asked });
}

export function installPermissionAnswers(): void {
  handleFromApp("brigadier:permission-answer", (_event, request: number, choice: CardAnswer) => {
    const question = questions.get(request);
    if (!question) return;
    questions.delete(request);
    const { profileId, guest, origin, asked, answer } = question;
    if (choice === "visiting" || choice === "never") {
      const kept = siteAnswers.get(profileId) ?? new Map<string, SiteChoice>();
      const devices = (["camera", "microphone", "location"] as const).filter((device) => asked[device]);
      kept.set(origin, { ...kept.get(origin), ...Object.fromEntries(devices.map((device) => [device, choice === "visiting" ? "allow" : "block"])) });
      siteAnswers.set(profileId, kept);
    }
    if (cardAllows(choice)) grant(guest, origin, asked, answer, true);
    else answer(false);
  });
  handleFromApp("brigadier:permission-open-settings", (_event, device: OsDevice) => openOsSettings(device));
}

/** The app's own session: its page keeps what it asks for (the microphone for dictation), and nothing else in it gets anything. */
export function applyAppSessionPolicy(session: Session): void {
  session.setPermissionRequestHandler((contents, _permission, callback, details) => {
    callback(details.isMainFrame && isAppPage(details.requestingUrl || contents.getURL()));
  });
  session.setPermissionCheckHandler((_contents, _permission, origin) => isAppPage(origin));
}

export function applyPermissionPolicy(session: Session): void {
  const profileId = profileOfStorage(session.storagePath);
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === "media" && profileId) {
      const types = (details as Electron.MediaAccessPermissionRequest).mediaTypes ?? [];
      request(permission, profileId, contents, details.requestingUrl, { camera: types.includes("video"), microphone: types.includes("audio"), location: false }, callback);
      return;
    }
    if (permission === "geolocation" && profileId) {
      request(permission, profileId, contents, details.requestingUrl, { camera: false, microphone: false, location: true }, callback);
      return;
    }
    callback(ALLOWED.has(permission));
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    if ((permission === "media" || permission === "geolocation") && profileId) {
      const origin = originOf(requestingOrigin);
      const device: SiteAsk = permission === "geolocation"
        ? { camera: false, microphone: false, location: true }
        : { camera: details.mediaType === "video", microphone: details.mediaType !== "video", location: false };
      return checkAllows(origin, device, origin ? siteChoice(profileId, origin) : undefined, process.platform);
    }
    return ALLOWED.has(permission);
  });
  session.setDevicePermissionHandler(() => false);
  session.setDisplayMediaRequestHandler((_request, callback) => callback({} as never));
  session.on("select-hid-device", (event, _details, callback) => { event.preventDefault(); callback(""); });
  session.on("select-serial-port", (event, _ports, _contents, callback) => { event.preventDefault(); callback(""); });
  session.on("select-usb-device", (event, _details, callback) => { event.preventDefault(); callback(""); });
}
