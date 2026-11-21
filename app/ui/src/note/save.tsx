import { useContext } from "react";

import { SessionOfThread } from "../accounts/limit";
import { TooltipIconButton } from "../components/icon-button";
import { showToast } from "../components/toast";
import { useDaemon } from "../daemon";
import { StickyNote } from "../icons";
import { failure } from "../session/composer";
import { newId } from "../session/store";
import { openTab } from "../shell/tab-store";
import { copiedReply } from "../thread/reply-cards";
import { useNoteRun } from "./run";

/** Under an answer: a new note of the project's with the reply's text, opened in a tab, named by its first line [D913 D921]. */
export function SaveAsNote({ text }: { text: string }) {
  const session = useContext(SessionOfThread);
  const row = useDaemon().rows?.find((each) => each.id === session?.id);
  const run = useNoteRun(session?.id ?? "");
  // A note's own chat writes its note itself, and has no tabs to open one in.
  if (!session || row?.noteChat) return null;
  const save = () => {
    const id = newId();
    void run(["write", id, "", copiedReply(text)]).then((reply) => (reply.ok ? openTab(session.id, "note", id) : showToast(failure(reply), { tone: "error" })));
  };
  return (
    <TooltipIconButton tooltip="Save as note" size="icon-answer" onClick={save}>
      <StickyNote />
    </TooltipIconButton>
  );
}
