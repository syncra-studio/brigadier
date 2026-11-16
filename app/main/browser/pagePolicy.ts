const REFUSED_SCHEMES = new Set(["file:", "chrome:", "chrome-untrusted:", "devtools:", "view-source:", "javascript:", "app:"]);

/** An address no web page may go to: a local or browser-internal one, or the app's own. */
export function refusedAddress(url: string): boolean {
  try {
    return REFUSED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}
