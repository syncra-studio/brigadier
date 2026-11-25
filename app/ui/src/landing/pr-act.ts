import { ask } from "../daemon";
import type { PullRequest } from "./pull-requests";

/** `host <whose> <verb> <ref> …` on a PR, whose: the chat its tab is in, so as its project's account [D631], else the Pull Requests page's. */
export const prArgs = (verb: string, pr: Pick<PullRequest, "ref" | "owner">, ...rest: string[]) => ["host", pr.owner ?? "@", verb, pr.ref!, ...rest];

/** A PR write through Rust [D164–D166]: resolves when GitHub took it, else rejects with GitHub's words. */
export const prAct = (verb: string, pr: Pick<PullRequest, "ref" | "owner">, ...rest: string[]): Promise<void> =>
  new Promise((resolve, reject) => ask({ op: "run", args: prArgs(verb, pr, ...rest) }, (reply) => (reply.ok ? resolve() : reject(new Error(String(reply.error))))));

/** `--text` and the words, for a verb that takes them. */
export const said = (text: string) => ["--text", text];
