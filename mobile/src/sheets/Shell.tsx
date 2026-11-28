// A `!` command's output, as the desktop's session/bang-row.tsx reads it: whole every 2 s while it runs, with Stop.
import { useEffect, useState } from "react";
import { ActivityIndicator, Text } from "react-native";
import { failure } from "../../../app/shared/session/run";
import { Button } from "../Button";
import { forMac } from "../compose/state";
import { color } from "../theme";
import { Box, Capped } from "../thread/rows/parts";
import { Sheet, st } from "./Sheet";

export function ShellOutput({ id, cmd, command, onClose }: { id: string; cmd: string; command: string; onClose: () => void }) {
  const { run } = forMac();
  const [out, setOut] = useState<{ output: string; running: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
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
  return (
    <Sheet title={out?.running === false ? "Ran" : "Running"} onClose={onClose}>
      <Box title="Command"><Text selectable style={{ fontFamily: "Menlo", fontSize: 12.5, color: color.foreground }}>{command}</Text></Box>
      {out ? <Box title="Output">{out.output ? <Capped keep={`${cmd}:sheet`} text={out.output} tail /> : <Text style={st.muted}>No output yet</Text>}</Box> : !error && <ActivityIndicator color={color.mutedForeground} />}
      {error && <Text style={st.error}>{error}</Text>}
      {out?.running && <Button title={stopping ? "Stopping…" : "Stop"} disabled={stopping} onPress={stop} />}
    </Sheet>
  );
}
