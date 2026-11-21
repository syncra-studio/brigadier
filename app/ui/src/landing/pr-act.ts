import { ask } from "../daemon";

/** A PR write through Rust's `host @ <verb> <ref> …` [D164–D166]: resolves when GitHub took it, else rejects with GitHub's words. */
export const prAct = (verb: string, ref: string, ...rest: string[]): Promise<void> =>
  new Promise((resolve, reject) => ask({ op: "run", args: ["host", "@", verb, ref, ...rest] }, (reply) => (reply.ok ? resolve() : reject(new Error(String(reply.error))))));

/** `--text` and the words, for a verb that takes them. */
export const said = (text: string) => ["--text", text];
