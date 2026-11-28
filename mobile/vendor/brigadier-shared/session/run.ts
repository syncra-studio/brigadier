/** Runs a `brigadier` command on the Mac and answers with its reply, a refusal included; each app passes its own. */
export type Runner = (args: string[]) => Promise<Record<string, any>>;

export const failure = (reply: Record<string, any>) => (reply.error === "disconnected" ? "Brigadier isn't running" : String(reply.message ?? reply.error ?? "Refused"));
