// Fresh signatures (msgs/remote-wire.md; design §4.2, D51): a lasting answer, a start and each power is signed with
// Face ID over the exact command, once, with a nonce the Mac gave this stream.
import Link from "../../modules/link";
import type { Frame } from "../../vendor/brigadier-shared/client";
import { ask } from "../link";

/** What the signature names: an answer's session, request and answer; any other command's session (or new id) and verb. */
export function names(args: string[]): [string, string, string] {
  return args[0] === "answer" ? [args[1], args[2], args[3]] : [args[1], "", args[0]];
}

/** Runs `args` with a fresh signature. `{ok: false, error: "cancelled"}` when Face ID didn't sign. */
export async function signed(args: string[]): Promise<Frame> {
  const [session, request, action] = names(args);
  const challenge = await ask({ op: "challenge", session, request, action });
  if (!challenge.ok) return challenge;
  let sig: string;
  try {
    // The argv signed is the one sent: the client's frame holds `args` as this same JSON.
    sig = await Link.act(challenge.nonce, session, request, action, JSON.stringify(args));
  } catch {
    return { ok: false, error: "cancelled" };
  }
  return ask({ op: "run", args, act: { nonce: challenge.nonce, sig } });
}
