import { useEffect, useState } from "react";

import { NavRow } from "../components/nav";
import { useDaemon } from "../daemon";
import { Globe } from "../icons";
import { run } from "../onboarding/api";
import { HOME } from "../shell/tab-store";

/** The New tab's browser part (the old NewTabTools's): its session's Local servers [D508]. */

/** The local servers the session's background jobs printed, while they answer (Rust's `jobs <id> servers`), read again as its jobs change. */
export function LocalServers({ owner, active, onOpen }: { owner: string; active: boolean; onOpen: (url: string) => void }) {
  const row = useDaemon().rows?.find((each) => each.id === owner);
  const jobs = (row?.background ?? []).map((job) => `${job.pid}.${job.start_us}`).join(" ");
  const [servers, setServers] = useState<string[]>([]);
  useEffect(() => {
    if (!active || owner === HOME || !jobs) return setServers([]);
    let live = true;
    run(["jobs", owner, "servers"]).then(
      (reply) => live && setServers(reply.servers as string[]),
      () => live && setServers([]),
    );
    return () => {
      live = false;
    };
  }, [owner, active, jobs]);
  if (servers.length === 0) return null;
  return (
    <section aria-label="Local servers" className="flex flex-col gap-2">
      <h2 className="font-medium">Local servers</h2>
      <ul className="flex flex-col">
        {servers.map((url) => (
          <li key={url}>
            <NavRow onClick={() => onOpen(url)} className="text-label text-foreground">
              <Globe className="text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{url.replace(/^https?:\/\//, "")}</span>
            </NavRow>
          </li>
        ))}
      </ul>
    </section>
  );
}
