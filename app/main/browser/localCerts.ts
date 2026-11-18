// A local dev site whose certificate isn't trusted (a self-signed one) opens after the person's "Open anyway"
// (guestFailedLoad.ts), remembered per profile by host, for every request to it, until Clear browsing data. Rust keeps
// the list (crates/cli/src/browser/certs.rs), at <data>/browser/<profile>/local-certs.json; main only reads it [D725, D730].
import fs from "node:fs";
import path from "node:path";
import { app, type Session } from "electron";

import { toAppPages } from "./appPage";
import { profileOfStorage } from "./profiles";

/** This computer's dev hosts, as the UI's address.ts and links.ts read them, and *.test. Only these may be let through. */
export const isLocalHost = (host: string): boolean => /^(localhost|.+\.localhost|.+\.test|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(host);

const trusted = new Map<string, Set<string>>();

function hostsOf(profileId: string): Set<string> {
  let hosts = trusted.get(profileId);
  if (!hosts) {
    let saved: unknown = [];
    try {
      saved = JSON.parse(fs.readFileSync(path.join(app.getPath("userData"), "..", "browser", profileId, "local-certs.json"), "utf8"));
    } catch { /* none yet */ }
    trusted.set(profileId, (hosts = new Set(Array.isArray(saved) ? saved.filter((host) => typeof host === "string" && isLocalHost(host)) : [])));
  }
  return hosts;
}

/** Chromium asks for each request, the page's own and its fetches alike; one not answered here is refused. */
export function installLocalCerts(): void {
  app.on("certificate-error", (event, contents, url, _error, _certificate, callback) => {
    const profileId = profileOfStorage(contents.session.storagePath ?? null);
    const host = URL.parse(url)?.hostname ?? "";
    if (!profileId || !isLocalHost(host) || !hostsOf(profileId).has(host)) return;
    event.preventDefault();
    callback(true);
  });
}

export function trustLocalCert(profileId: string, host: string): void {
  if (!isLocalHost(host)) return;
  hostsOf(profileId).add(host);
  toAppPages("brigadier:browser-local-cert", { profile: profileId, host });
}

/** Clear browsing data's part: the page has had Rust empty the list. */
export function forgetLocalCerts(profileId: string, profileSession: Session): void {
  trusted.delete(profileId);
  // A connection already let through would carry on without asking.
  profileSession.closeAllConnections();
}
