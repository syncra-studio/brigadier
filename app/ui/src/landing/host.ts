import { createContext, useContext } from "react";

/** Home's picked project, whose repository its Pull requests and Actions tabs read before the first message [D279]. */
export const HostOf = createContext<string | null>(null);

/** Whose repository `owner`'s tab reads: the session's, or Home's project's. */
export const useHost = (owner: string) => useContext(HostOf) ?? owner;
