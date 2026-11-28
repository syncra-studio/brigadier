// Fresh signatures (D51, crates/daemon/src/remote/fresh.rs): a lasting answer, a start and each power is signed with
// Face ID over the exact command, once, with a nonce the Mac gave this stream.
import Link from "../../modules/link";
import type { Frame } from "../../../app/shared/client";
import { ask, streamNow } from "../link";

/** What the signature names: an answer's session, request and answer; any other command's session (or new id) and verb. */
export function names(args: string[]): [string, string, string] {
  return args[0] === "answer" ? [args[1], args[2], args[3]] : [args[1], "", args[0]];
}

/**
 * Runs `given` with a fresh signature; it never throws. Errors of its own: "cancelled" (Face ID didn't confirm),
 * "notSigned" (U couldn't sign), "closed" (the stream ended or changed: nothing more is sent).
 */
export async function signed(given: string[]): Promise<Frame> {
  // A copy: what is named, signed and sent can't change underneath.
  const args = [...given];
  const [session, request, action] = names(args);
  const at = streamNow();
  const lost = { ok: false, error: "closed" };
  if (at < 0) return lost;
  try {
    const challenge = await ask({ op: "challenge", session, request, action });
    if (!challenge.ok || streamNow() !== at) return challenge.ok ? lost : challenge;
    let sig: string;
    try {
      // The argv signed is the one sent: the client's frame holds `args` as this same JSON.
      sig = await Link.act(challenge.nonce, session, request, action, JSON.stringify(args));
    } catch (e: any) {
      return { ok: false, error: e?.code === "cancelled" ? "cancelled" : "notSigned" };
    }
    // The signature covers that stream's handshake: on any other it is void, and the command isn't for it.
    if (streamNow() !== at) return lost;
    return await ask({ op: "run", args, act: { nonce: challenge.nonce, sig } });
  } catch {
    return lost;
  }
}
