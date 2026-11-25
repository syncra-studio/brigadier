// A page's address and title as an agent sees them.

/**
 * An address as an agent sees it: what a query's or a fragment's sensitive names hold stays out. `query` false keeps
 * the query, and the address whole, for a page the agent may have to open again.
 * Its source goes to the agent's script too (browserAgentSecrets.ts), so it names nothing outside itself.
 */
export function shownUrl(url: string, query = true): string {
  // A name's own words, not letters inside one: zipcode and zip_code are ordinary names, and the address must open again.
  const sensitive = (name: string): boolean => {
    let plain = name;
    try {
      plain = decodeURIComponent(name);
    } catch {
      // Named as it's written.
    }
    const words = plain.replace(/([a-z0-9])([A-Z])|([A-Z]+)(?=[A-Z][a-z])/g, "$1$3_$2").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    return [
      /(^|_)(o?auth2?|authorization|jwt|t?otp|sid|passcode|passphrase|passkey)(_|$)/,
      /(token|password|passwd|pwd|secret)\d*(_|$)/,
      /^(state|relay_?state|saml_?response|session|(user_?)?pass)$/,
      /sess(ion)?_?(id|key|state)$/,
      /^code$|(^|_)(auth|authorization|access|device|user|login|email|sms|mfa|2fa|one_?time|verif(y|ication)|confirm(ation)?|reset|invite|recovery|backup|security)_?code$/,
      /^key$|(^|_)(api|access|private|secret|security|signing|encryption|license|reset|activation)_?key(_?id)?$/,
    ].some((each) => each.test(words));
  };
  const most = 300;
  let shown = url;
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    for (const name of query ? Array.from(parsed.searchParams.keys()) : []) {
      if (sensitive(name)) parsed.searchParams.set(name, "(hidden)");
    }
    // A sign-in's answer (#access_token=…), or a route with a query of its own (#/callback?code=…).
    if (parsed.hash) parsed.hash = parsed.hash.replace(/([^#?&=]+)=[^&]*/g, (pair, name: string) => (sensitive(name) ? `${name}=(hidden)` : pair));
    shown = parsed.toString();
  } catch {
    // Not an address to take apart: shown as it came, cut.
  }
  return query && shown.length > most ? `${shown.slice(0, most)}…` : shown;
}

/** A title as an agent sees it: Chromium titles a page with none by its address, which is told apart. */
export function shownTitle(title: string, url: string): string {
  try {
    const { host } = new URL(url);
    const rest = title.replace(/^[a-z]+:\/\//i, "");
    return host && rest.startsWith(host) && /^[/?#]/.test(rest.slice(host.length)) ? "" : title;
  } catch {
    return title;
  }
}
