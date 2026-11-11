import { useEffect, useMemo, useState } from "react";

import { useDaemon } from "../daemon";
import { errorText, run } from "../onboarding/api";

type Preview = { state: "ready" | "error" | "disconnected"; branch: string | null; reason: string };
const OFFLINE: Preview = { state: "disconnected", branch: null, reason: "Brigadier isn't connected." };

/** Rust owns branch eligibility, collision suffixes and the name the confirm pins. */
export function useBranchPreview(session: string, title: string) {
  const connected = !!useDaemon().daemon;
  const [preview, setPreview] = useState<Preview | null>(null);
  const request = useMemo(() => {
    let pending: Promise<Preview> | undefined;
    return {
      active: false,
      load: () => pending ??= connected
        ? run(["rename", session, title, "--preview"]).then((reply): Preview => ({ state: "ready", branch: reply.branch, reason: reply.reason }))
          .catch((cause): Preview => errorText(cause) === "disconnected" ? OFFLINE : ({ state: "error", branch: null, reason: errorText(cause) }))
        : Promise.resolve(OFFLINE),
    };
  }, [session, title, connected]);
  // The first read goes at once; while typing, the last answer stays until the new one replaces it [D1261].
  const first = preview === null;
  useEffect(() => {
    request.active = true;
    const timer = connected && title.trim() ? setTimeout(() => {
      request.load().then((next) => { if (request.active) setPreview(next); });
    }, first ? 0 : 180) : undefined;
    return () => { request.active = false; clearTimeout(timer); };
  }, [request, connected, title]);
  return {
    connected,
    preview: connected ? preview : OFFLINE,
    // Submit flushes the debounce and shares its request; closing or changing the form cancels it.
    wait: async () => {
      const next = await request.load();
      return request.active ? next : null;
    },
  };
}
