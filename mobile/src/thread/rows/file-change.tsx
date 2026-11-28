// Changed files, after the desktop's components/thread/file-change.tsx.
import { StyleSheet, Text, View } from "react-native";
import type { PendingApproval } from "../../../../app/shared/cards";
import type { FileChange, Item, Progress } from "../../../../app/shared/thread";
import { FILE_VERBS } from "../../../../app/shared/words";
import { color, mono, radius, space, text } from "../../theme";
import { Capped, Line, Opening, s, StepIcon, Words } from "./parts";
import { Allowed } from "./tool";

/** A diff past this many lines isn't drawn. */
const MAX_DIFF_LINES = 5000;

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function FileChangeItem({ item }: { item: Extract<Item, { kind: "fileChange" }> }) {
  return (
    <View style={{ gap: space(1) }}>
      {item.changes.map((change, at) => (
        <FileChangeRow key={at} keep={`${item.id}:${at}`} change={change} progress={item.progress} approval={at === 0 ? item.approval : undefined} />
      ))}
    </View>
  );
}

/**
 * One changed file: "Edited blocks.ts", then its counts (+7 −2, green and red) and a red dot for a deleted file. A
 * finished one opens to its diff. A declined change reads "Rejected".
 */
function FileChangeRow({ keep, change, progress, approval }: { keep: string; change: FileChange; progress: Progress; approval?: PendingApproval }) {
  const { added, removed } = change;
  const live = progress === "running" || progress === "pending";
  const name = fileName(change.path);
  const [doing, done, waiting] = FILE_VERBS[change.change];
  const object = change.change === "renamed" && change.from ? `${fileName(change.from)} to ${name}` : name;
  const [verb, what] =
    progress === "pending" ? [`Waiting to ${waiting}`, object] : progress === "cancelled" ? ["Rejected", name] : [live ? doing : done, progress === "failed" ? `${object} — failed` : object];
  const head = (
    <>
      <StepIcon kind="edit" />
      <Words verb={verb} object={what} live={progress === "running"} />
    </>
  );
  if (live) return <Line>{head}</Line>;
  const trail = (
    <>
      {added !== null && removed !== null && <Counts added={added} removed={removed} quiet />}
      {change.change === "deleted" && <View style={st.dot} />}
    </>
  );
  // A change with no diff opens the Review tab on the Mac; the phone has none, so it's a plain row.
  if (change.diff === null) return <Line>{head}<View style={s.trail}>{trail}</View></Line>;
  return (
    <Opening keep={keep} label={`${verb} ${what}`} trail={trail} detail={<>{approval && <Allowed approval={approval} />}<DiffCard keep={keep} change={change} diff={change.diff} /></>}>
      {head}
    </Opening>
  );
}

/** "+7 −2", always green and red, a zero grey [D98]. Quiet: the row's mono figures. */
function Counts({ added, removed, quiet = false }: { added: number; removed: number; quiet?: boolean }) {
  return (
    <Text style={[st.counts, quiet ? { fontFamily: mono, color: color.rowForeground } : { color: color.mutedForeground }]}>
      <Text style={added ? { color: color.success } : null}>+{added}</Text> <Text style={removed ? { color: color.destructive } : null}>−{removed}</Text>
    </Text>
  );
}

const paint = (line: string) =>
  line.startsWith("+") ? { color: color.success } : line.startsWith("-") ? { color: color.destructive } : line.startsWith("@@") ? { color: color.mutedForeground } : undefined;

/** A file's diff, in the desktop's diff card: its name and counts over the lines, added green, removed red. */
function DiffCard({ keep, change, diff: words }: { keep: string; change: FileChange; diff: string }) {
  const { added, removed } = change;
  const diff = words.replace(/\n$/, "");
  const count = diff ? diff.split("\n", MAX_DIFF_LINES + 1).length : 0;
  const empty = count === 0 ? (change.change === "deleted" ? "Contents deleted" : "No changes") : count > MAX_DIFF_LINES ? "Diff too large to preview" : null;
  return (
    <View style={st.card}>
      <View style={st.title}>
        <Text style={[text.sm, st.name]} numberOfLines={1}>{fileName(change.path)}</Text>
        {added !== null && removed !== null && <Counts added={added} removed={removed} />}
      </View>
      {empty === null ? (
        <View style={st.pre}><Capped keep={`${keep}:diff`} text={diff} paint={paint} style={st.diff} /></View>
      ) : (
        <Text style={[text.sm, st.empty]}>{empty}</Text>
      )}
    </View>
  );
}

const st = StyleSheet.create({
  counts: { ...text.xs, fontVariant: ["tabular-nums"] },
  dot: { width: space(1.5), height: space(1.5), borderRadius: radius.capsule, backgroundColor: color.destructive },
  card: { marginTop: space(1), borderRadius: radius.shell, borderWidth: 1, borderColor: color.border, overflow: "hidden" },
  title: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: space(8), paddingLeft: space(3), paddingRight: space(1), backgroundColor: color.fillSubtle },
  name: { flexShrink: 1, color: color.actionHover },
  pre: { paddingHorizontal: space(3) },
  diff: { ...text.diff },
  empty: { paddingHorizontal: space(3), paddingVertical: space(2), color: color.mutedForeground },
});
