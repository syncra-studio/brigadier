// What a session runs in the background: what its turns left running with Stop, its `!` commands still running, and
// everything that ran, as the desktop's card and panel/background-history.tsx show them [D105, D200].
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, Text, View } from "react-native";
import type { Job } from "../../vendor/brigadier-shared/rows";
import { failure } from "../../vendor/brigadier-shared/session/run";
import { duration, sentAt } from "../../vendor/brigadier-shared/words";
import { forMac } from "../compose/state";
import { lists, thread } from "../mac/mac";
import { ShellOutput } from "./Shell";
import { Sheet, st } from "./Sheet";

/** One run as `jobs <id> history` gives it; `owner`: the worker that left it. */
type Run = { owner?: string; label: string; startedAt: number; endedAt: number | null; status: "running" | "stopped" | "ended" | "unknown" };
const OUTCOME: Record<Run["status"], string> = { running: "Running", stopped: "Stopped by you", ended: "Ended", unknown: "End not observed" };

export function Background({ id, onClose }: { id: string; onClose: () => void }) {
  const { run } = forMac();
  const jobs = useSyncExternalStore(lists.subscribe, () => lists.get().rows.find((row) => row.id === id)?.background) ?? [];
  const items = useSyncExternalStore(thread.subscribe, () => thread.get()?.session?.items);
  const shells = (items ?? []).flatMap((item) => (item.kind === "shell" && item.progress === "running" ? [item] : []));
  const [history, setHistory] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
  // A command's output opens over this sheet, which stays under it.
  const [output, setOutput] = useState<{ cmd: string; command: string } | null>(null);
  const key = (job: Job) => `${job.pid}.${job.start_us}`;
  const now = jobs.map(key).join(" ");
  // Read again as its jobs start and end.
  useEffect(() => {
    void run(["jobs", id, "history"]).then((reply) => (reply.ok ? setHistory(reply.history as Run[]) : setError(`Couldn't load background history: ${failure(reply)}`)));
  }, [id, now]);
  const stop = (job: Job) => {
    setStopping((was) => new Set(was).add(key(job)));
    void run(["jobs", id, "stop", String(job.pid), String(job.start_us)]).then((reply) => {
      if (reply.ok) return;
      setStopping((was) => new Set([...was].filter((each) => each !== key(job))));
      setError(failure(reply));
    });
  };
  return (
    <Sheet title="Background" onClose={onClose}>
      {jobs.length === 0 && shells.length === 0 && <Text style={st.muted}>Nothing runs in the background now.</Text>}
      {jobs.map((job) => (
        <View key={key(job)} style={st.item}>
          <View style={{ flex: 1 }}>
            <Text style={st.body} numberOfLines={3}>{job.label}</Text>
            {job.ports.length > 0 && <Text style={st.muted}>Listening on {job.ports.map((port) => `:${port}`).join(", ")}</Text>}
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel={`Stop ${job.label}`} disabled={stopping.has(key(job))} onPress={() => stop(job)} hitSlop={8}>
            <Text style={st.link}>{stopping.has(key(job)) ? "Stopping…" : "Stop"}</Text>
          </Pressable>
        </View>
      ))}
      {shells.map((item) => (
        <Pressable key={item.id} accessibilityRole="button" onPress={() => setOutput(item)} style={st.item}>
          <Text style={[st.body, { flex: 1, fontFamily: "Menlo" }]} numberOfLines={2}>{item.command}</Text>
          <Text style={st.link}>Output</Text>
        </Pressable>
      ))}
      {error && <Text style={st.error}>{error}</Text>}
      <Text style={st.heading}>Everything that ran this session{history ? ` · ${history.length}` : ""}</Text>
      {!history && !error && <Text style={st.muted}>Loading background history…</Text>}
      {history?.length === 0 && <Text style={st.muted}>Background commands will appear here once one runs.</Text>}
      {history?.map((each, at) => (
        <View key={`${each.startedAt}.${at}`} style={{ gap: 2 }}>
          <Text style={st.body} numberOfLines={2}>{each.label}</Text>
          <Text style={st.muted}>{[sentAt(each.startedAt), each.owner, OUTCOME[each.status], each.endedAt !== null ? duration(each.endedAt - each.startedAt) : null].filter(Boolean).join(" · ")}</Text>
        </View>
      ))}
      {output && <ShellOutput id={id} cmd={output.cmd} command={output.command} onClose={() => setOutput(null)} />}
    </Sheet>
  );
}
