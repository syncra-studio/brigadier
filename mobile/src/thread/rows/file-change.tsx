// Changed files, after the desktop's components/thread/file-change.tsx.
import { StyleSheet, Text, View } from "react-native";
import type { PendingApproval } from "../../../vendor/brigadier-shared/cards";
import type { FileChange, Item, Progress } from "../../../vendor/brigadier-shared/thread";
import { FILE_VERBS } from "../../../vendor/brigadier-shared/words";
import { color } from "../../theme";
import { Capped, Glyph, Line, Opening, s, Words } from "./parts";
import { Allowed } from "./tool";

/** A diff past this many lines isn't drawn. */
const MAX_DIFF_LINES = 5000;

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);

export function FileChangeItem({ item }: { item: Extract<Item, { kind: "fileChange" }> }) {
  return (
    <View style={{ gap: 4 }}>
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
      <Glyph g="✎" />
      <Words verb={verb} object={what} live={progress === "running"} />
    </>
  );
  if (live) return <Line>{head}</Line>;
  const trail = (
    <>
      {added !== null && removed !== null && <Counts added={added} removed={removed} />}
      {change.change === "deleted" && <View style={st.dot} />}
    </>
  );
  // shortcut: a change with no diff opens the Review tab on the Mac; the phone has none, so it's a plain row.
  if (change.diff === null) return <Line>{head}{trail}</Line>;
  return (
    <Opening keep={keep} label={`${verb} ${what}`} trail={trail} detail={<>{approval && <Allowed approval={approval} />}<DiffCard keep={keep} change={change} diff={change.diff} /></>}>
      {head}
    </Opening>
  );
}

/** "+7 −2", always green and red, a zero grey [D98]. */
function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <Text style={[s.code, st.counts]}>
      <Text style={added ? { color: color.success } : null}>+{added}</Text> <Text style={removed ? { color: color.destructive } : null}>−{removed}</Text>
    </Text>
  );
}

const paint = (line: string) =>
  line.startsWith("+") ? { color: color.success } : line.startsWith("-") ? { color: color.destructive } : line.startsWith("@@") ? { color: color.mutedForeground } : undefined;

/** A file's diff: its name and counts over the lines, added green, removed red. */
function DiffCard({ keep, change, diff: text }: { keep: string; change: FileChange; diff: string }) {
  const { added, removed } = change;
  const diff = text.replace(/\n$/, "");
  const count = diff ? diff.split("\n", MAX_DIFF_LINES + 1).length : 0;
  const empty = count === 0 ? (change.change === "deleted" ? "Contents deleted" : "No changes") : count > MAX_DIFF_LINES ? "Diff too large to preview" : null;
  return (
    <View style={st.card}>
      <View style={st.title}>
        <Text style={[s.row, s.shrink, { color: color.foreground }]} numberOfLines={1}>{fileName(change.path)}</Text>
        {added !== null && removed !== null && <Counts added={added} removed={removed} />}
      </View>
      <View style={{ padding: 10 }}>{empty === null ? <Capped keep={`${keep}:diff`} text={diff} paint={paint} /> : <Text style={[s.row, { color: color.mutedForeground }]}>{empty}</Text>}</View>
    </View>
  );
}

const st = StyleSheet.create({
  counts: { fontSize: 12, lineHeight: 21, color: color.row },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: color.destructive, alignSelf: "center" },
  card: { marginTop: 4, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: color.border, overflow: "hidden" },
  title: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: color.fill },
});
