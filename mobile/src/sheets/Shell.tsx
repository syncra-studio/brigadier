// A `!` command's output, as the desktop's session/bang-row.tsx shows it opened: "Running", then "Ran", its Shell box
// read whole every 2 s while it runs, and Stop.
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator } from "react-native";
import { failure } from "../../../app/shared/session/run";
import { VERBS } from "../../../app/shared/words";
import { DialogButton } from "../Button";
import { forMac } from "../compose/state";
import { thread } from "../mac/mac";
import { color } from "../theme";
import { ErrorLine } from "../thread/rows/parts";
import { ShellBox } from "../thread/rows/tool";
import { Sheet } from "./Sheet";

export function ShellOutput({ id, cmd, command, onClose }: { id: string; cmd: string; command: string; onClose: () => void }) {
  const { run } = forMac();
  const [out, setOut] = useState<{ output: string; running: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  // How it ended, from its row in the thread.
  const item = useSyncExternalStore(thread.subscribe, () => thread.get()?.session?.items.find((each) => each.kind === "shell" && each.cmd === cmd));
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () =>
      void run(["shell", id, "output", cmd]).then((reply) => {
        if (!live) return;
        if (!reply.ok) return setError(failure(reply));
        setError(null);
        setOut({ output: String(reply.output ?? ""), running: reply.running === true });
        if (reply.running) timer = setTimeout(read, 2000);
      });
    read();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [id, cmd]);
  const stop = () => {
    setStopping(true);
    void run(["shell", id, "stop", cmd]).then((reply) => {
      if (reply.ok) return;
      setStopping(false);
      setError(failure(reply));
    });
  };
  const ended = item?.kind === "shell" && item.progress !== "running" ? item : null;
  return (
    <Sheet title={VERBS.run[out?.running === false ? 1 : 0]} onClose={onClose} footer={out?.running ? <DialogButton title={stopping ? "Stopping…" : "Stop"} variant="ghost" disabled={stopping} onPress={stop} /> : undefined}>
      {out ? <ShellBox keep={`${cmd}:sheet`} command={command} output={out.output} progress={out.running ? "running" : (ended?.progress ?? "done")} exitCode={ended?.exitCode ?? null} /> : !error && <ActivityIndicator color={color.mutedForeground} />}
      <ErrorLine error={error} />
    </Sheet>
  );
}
