// What a session runs in the background, as the desktop's card section and its history (panel/background.tsx,
// background-history.tsx) [D105, D200]: what its turns left running, each with its ports, how long it has run and Stop;
// its `!` commands still running, with their output; then everything that ran, on the history's timeline.
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { type Job, jobName, jobPorts } from "../../../app/shared/rows";
import { failure } from "../../../app/shared/session/run";
import { duration, hhmm, ranWords, RUN_OUTCOME } from "../../../app/shared/words";
import { StopCircle, Terminal } from "../../../app/ui/src/icons";
import { forMac } from "../compose/state";
import { lists, thread } from "../mac/mac";
import { color, fontWeight, mono, radius, space, text, touch } from "../theme";
import { ErrorLine } from "../thread/rows/parts";
import { useSecond } from "../thread/rows/work";
import { ShellOutput } from "./Shell";
import { Line, Sheet, st } from "./Sheet";

/** One run as `jobs <id> history` gives it; `owner`: the worker that left it. */
type Run = { owner?: string; label: string; startedAt: number; endedAt: number | null; status: keyof typeof RUN_OUTCOME };

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
  const tick = useSecond(jobs.length > 0 || (history ?? []).some((each) => each.status === "running"));
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
    <Sheet title="Background processes" onClose={onClose}>
      {jobs.length === 0 && shells.length === 0 && <Text style={st.muted}>Nothing runs in the background now.</Text>}
      {jobs.length + shells.length > 0 && (
        <View>
          {jobs.map((job) => (
            <Line
              key={key(job)}
              icon={<Terminal className="size-icon-md text-muted-foreground" />}
              end={
                <View style={styles.end}>
                  <Text style={styles.ran}>{duration(tick - job.start_us / 1000)}</Text>
                  <Pressable accessibilityRole="button" accessibilityLabel={`Stop ${jobName(job)}`} disabled={stopping.has(key(job))} onPress={() => stop(job)} style={styles.stop}>
                    <StopCircle className="size-icon-xs" color={stopping.has(key(job)) ? color.placeholder : color.mutedForeground} />
                  </Pressable>
                </View>
              }
            >
              <Text style={st.lineText} numberOfLines={2}>
                {jobName(job)}
                {job.ports.length > 0 ? <Text style={{ color: color.mutedForeground }}> · {jobPorts(job).join(", ")}</Text> : null}
              </Text>
            </Line>
          ))}
          {shells.map((item) => (
            <Line key={item.id} icon={<Terminal className="size-icon-md text-muted-foreground" />} onPress={() => setOutput(item)} end={<Text style={[st.link, { ...text.label }]}>Output</Text>}>
              <Text style={[st.lineText, { fontFamily: mono }]} numberOfLines={2}>{item.command}</Text>
            </Line>
          ))}
        </View>
      )}
      <ErrorLine error={error} />
      <Text style={st.heading}>Everything that ran this session{history ? ` · ${history.length}` : ""}</Text>
      {!history && !error && <Text style={st.muted}>Loading background history…</Text>}
      {history?.length === 0 && <Text style={st.muted}>Background commands will appear here once one runs.</Text>}
      {history && history.length > 0 && (
        <View>
          {history.map((each, at) => {
            const live = each.status === "running";
            const last = at === history.length - 1;
            return (
              <View key={`${each.startedAt}.${at}`} style={styles.event}>
                <Text style={styles.time}>{hhmm(each.startedAt)}</Text>
                <View style={styles.rail}>
                  <View style={[styles.dot, live ? styles.now : { backgroundColor: color.timelinePast }]} />
                  {!last && <View style={styles.join} />}
                </View>
                <View style={[styles.what, !last && { paddingBottom: space(3) }]}>
                  <Text style={[styles.title, live && { fontWeight: fontWeight.medium }]}>{each.label}</Text>
                  <Text style={styles.detail}>{[each.owner, RUN_OUTCOME[each.status], ranWords(each, tick), new Date(each.startedAt).toLocaleDateString()].filter(Boolean).join(" · ")}</Text>
                </View>
              </View>
            );
          })}
        </View>
      )}
      {output && <ShellOutput id={id} cmd={output.cmd} command={output.command} onClose={() => setOutput(null)} />}
    </Sheet>
  );
}

// The desktop's card row end and Timeline (components/timeline.tsx).
const styles = StyleSheet.create({
  end: { flexDirection: "row", alignItems: "center", gap: space(1.5) },
  ran: { ...text.label, color: color.mutedForeground, fontVariant: ["tabular-nums"] },
  stop: { width: touch, height: touch, marginEnd: -space(2), alignItems: "center", justifyContent: "center", borderRadius: radius.sm },
  event: { flexDirection: "row", gap: space(2) },
  time: { width: space(11), paddingTop: space(0.5), textAlign: "right", fontFamily: mono, ...text["2xs"], color: color.mutedForeground, fontVariant: ["tabular-nums"] },
  rail: { width: space(3), alignItems: "center" },
  dot: { marginTop: space(1.5), width: space(2), height: space(2), borderRadius: radius.capsule },
  now: { backgroundColor: color.foreground, boxShadow: `0 0 0 4px ${color.input}` },
  join: { width: 1, flex: 1, backgroundColor: color.scrim },
  what: { flex: 1, gap: space(0.5) },
  title: { ...text.sm, color: color.timelineTitle },
  detail: { ...text.xs, lineHeight: text.xs.fontSize * 1.625, color: color.mutedForeground },
});
