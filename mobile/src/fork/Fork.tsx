// Fork from an answer, as the desktop's session/fork.tsx and components/thread/fork-menu.tsx [D1063, D1068]: Rust's
// check first, unsigned; then the one place it offers (a new worktree, or the chat alone) signed with Face ID, its
// fingerprint along, so Rust refuses if the answer changed meanwhile. Another agent is the Mac's.
import { useEffect, useState } from "react";
import { Alert } from "react-native";
import { failure } from "../../vendor/brigadier-shared/session/run";
import { FORK_FILES, FORK_REPO_FILES } from "../../vendor/brigadier-shared/words";
import { Confirm } from "../act/Confirm";
import { forMac } from "../compose/state";
import { lists } from "../mac/mac";
import { sessionId } from "../start/Start";

/** What Rust's check offers on an answer; `worktree` null in a chat with no project, which forks its conversation only. */
type Offer = { worktree: "snapshot" | "none" | "gone" | "sourceGone" | "repos" | null; repos?: { name: string; files: "snapshot" | "none" | "gone" | "later" }[]; fingerprint: string };

const named = (names: string[]) => (names.length > 5 ? `${names.slice(0, 5).join(", ")} and ${names.length - 5} more` : names.join(", "));
const detailOf = (offer: Offer) =>
  offer.worktree === "repos"
    ? FORK_REPO_FILES.map(([files, words]) => [words, (offer.repos ?? []).filter((repo) => repo.files === files).map((repo) => repo.name)] as const)
        .filter(([, names]) => names.length > 0)
        .map(([words, names]) => `${words}: ${named(names)}`)
        .join(" · ")
    : FORK_FILES[offer.worktree ?? "none"];

/** Forks session `id` at answer `at` (its turn's message id); `onForked` opens the new session. */
export function Fork({ id, at, onForked, onClose }: { id: string; at: string; onForked: (id: string, title: string) => void; onClose: () => void }) {
  const { run } = forMac();
  const [offer, setOffer] = useState<Offer | null>(null);
  const [made] = useState(sessionId);
  useEffect(() => {
    void run(["fork", id, "--check", at]).then((reply) => {
      if (reply.ok) return setOffer(reply as unknown as Offer);
      Alert.alert("Couldn't check this answer", failure(reply));
      onClose();
    });
  }, []);
  if (!offer) return null;
  const where = offer.worktree ? "worktree" : "chat";
  const title = `Fork of ${lists.get().rows.find((row) => row.id === id)?.title ?? ""}`;
  return (
    <Confirm
      title={offer.worktree ? (offer.repos ? "Fork to new copies of its repos?" : "Fork to a new worktree?") : "Fork chat?"}
      body="A new session goes on from this answer; this one stays as it is."
      shown={offer.worktree ? detailOf(offer) : "The conversation up to this answer"}
      args={["fork", id, made, "--at", at, "--where", where, "--fingerprint", offer.fingerprint]}
      onDone={(reply) => {
        // Told over the sheet, which goes with it: an alert can't show over a sheet going away.
        if (reply && !reply.ok) return Alert.alert("Couldn't fork", failure(reply), [{ text: "OK", onPress: onClose }]);
        onClose();
        if (reply) onForked(String(reply.session ?? made), title);
      }}
    />
  );
}
