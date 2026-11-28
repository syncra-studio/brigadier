// Rust's rewind preview as both apps read it [D384, D481].

/**
 * Rust's answer: what a restore would put back and leave alone. No paths, no file choice [D481]. `sharer`: the files
 * stay because another session in this folder worked during these turns, or works now [D1078]. `nested`: the
 * nested repositories among `leftOut`. `why`: Rust's reason only keep is offered, when it has one [D384]. `stale`: a
 * folder chat's repos missing a snapshot of one of these turns, which stay as they are [D3105].
 */
export type RewindPreview = { paths: string[]; hand: string[]; leftOut: string[]; nested: string[]; stale?: string[]; commits: boolean; error?: string; sharer?: { id: string; now: boolean }; why?: string };

/** Why a rewind's command was refused, or its answer lost. */
export const why = (reply: Record<string, any>) => (reply.error === "disconnected" ? "Brigadier isn't running, so the outcome isn't known yet." : String(reply.message ?? reply.error ?? "Refused"));

export function previewOf(reply: Record<string, any>): RewindPreview {
  const none = { paths: [], hand: [], leftOut: [], nested: [], commits: false };
  if (!reply.ok) return { ...none, error: why(reply) };
  if (reply.restore === true) return { paths: reply.paths ?? [], hand: reply.hand ?? [], leftOut: reply.leftOut ?? [], nested: reply.nested ?? [], stale: reply.stale ?? [], commits: reply.commits === true };
  // Another session in the folder keeps the files [D1078]; else Rust's reason [D384].
  return typeof reply.with === "string" ? { ...none, sharer: { id: reply.with, now: reply.why === "busy" } } : { ...none, why: String(reply.why) };
}
