// The session's changes, as the desktop's Review tab draws them (review/review-tab.tsx, brief.tsx, file-section.tsx,
// hunks.tsx, engine.tsx) [D1035, D1036]: the scope menu over the brief and a scope's files with their counts, one
// opened to its diff. Rust sends each side whole and where its hunks sit; the lines of a hunk are matched here.
// Phone-only: one file shows at a time, its header taking it back to the list; no comments, Open in or diff options.
import { useEffect, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { failure } from "../../../app/shared/session/run";
import { branchSince, couldntReadDiff, NO_TURN_WORDS, plural, REVIEW_SCOPES, REVIEW_WORDS } from "../../../app/shared/words";
import { ChevronDown, ChevronLeft, Dot, Spinner } from "../../../app/ui/src/icons";
import { FileIcon } from "../../../app/ui/src/icons/file-types";
import { Spin, usePulse } from "../compose/motion";
import { forMac } from "../compose/state";
import { color, mono, radius, space, spacing, text, touch } from "../theme";
import { MenuSheet, Sheet, st as sheet } from "./Sheet";

type Scope = "last" | "uncommitted" | "branch";
export type File = { path: string; from: string | null; status: string; insertions: number; deletions: number; binary?: boolean };
type Review = { files: File[]; insertions: number; deletions: number; base?: string | null; none?: string; turn?: { before: string; after: string } };
type Hunk = { id: string; header: string };

const SCOPES: Scope[] = ["last", "uncommitted", "branch"];
// The scope menu's trigger, a finger's size round the desktop's h-control-xs.
const SLOP = (touch - spacing.controlXs) / 2;

/** `file`: one opened from the start (a sample screen). */
export function Changes({ id, file: opened, onClose }: { id: string; file?: File; onClose: () => void }) {
  const { run } = forMac();
  const [scope, setScope] = useState<Scope>("last");
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(opened ?? null);
  const [picking, setPicking] = useState(false);
  useEffect(() => void run(["source", id, "status"]).then((reply) => reply.ok && setBranch(reply.git?.head?.branch ?? null)), [id]);
  useEffect(() => {
    let live = true;
    setReview(null);
    setError(null);
    void run(["source", id, "review", scope]).then((reply) => live && (reply.ok ? setReview(reply.review) : setError(failure(reply))));
    return () => void (live = false);
  }, [id, scope]);
  const label = (value: Scope) => (value === "branch" ? branchSince((scope === "branch" && review?.base) || null) : REVIEW_SCOPES[value]);
  const open = file && review;
  const brief = review && !review.none && (
    <View style={st.brief}>
      <Text style={st.briefText}>{plural(review.files.length, "file")} · <Counts {...review} /></Text>
    </View>
  );
  return (
    // One sheet throughout, its file's diff in place of the list: a sheet can't give way to another as it goes.
    <Sheet title="Changes" description={branch ? `On ${branch}` : undefined} onClose={onClose}>
      <View style={st.tab}>
        <View style={st.bar}>
          <Pressable accessibilityRole="button" accessibilityState={{ expanded: open ? undefined : picking }} hitSlop={SLOP} onPress={() => (open ? setFile(null) : setPicking(true))} style={({ pressed }) => [st.trigger, pressed && { backgroundColor: color.fill }]}>
            {open ? <ChevronLeft className="size-icon-xs text-muted-foreground" /> : null}
            <Text style={st.triggerText}>{open ? "All files" : label(scope)}</Text>
            {open ? null : <ChevronDown className="size-icon-xs text-muted-foreground" />}
          </Pressable>
        </View>
        {error ? <Text accessibilityRole="alert" style={[st.error, st.listError]}>{error}</Text> : null}
        {open ? (
          <>
            {brief}
            <FileView id={id} scope={scope} review={review} file={file} onBack={() => setFile(null)} />
          </>
        ) : !review ? (
          !error && <ListLoading />
        ) : review.none ? (
          <Text accessibilityRole="summary" style={st.empty}>{NO_TURN_WORDS[review.none as keyof typeof NO_TURN_WORDS] ?? review.none}</Text>
        ) : (
          <>
            {brief}
            {review.files.length === 0 ? <Text style={st.none}>{REVIEW_WORDS.noChanges}</Text> : review.files.map((each) => <FileHeader key={each.path} file={each} open={false} onPress={() => setFile(each)} />)}
          </>
        )}
      </View>
      {picking ? (
        <MenuSheet onClose={() => setPicking(false)}>
          {SCOPES.map((value) => (
            <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: scope === value }} onPress={() => (setPicking(false), setScope(value))} style={({ pressed }) => [sheet.item, pressed && { backgroundColor: color.fill }]}>
              <Text style={sheet.itemText} numberOfLines={1}>{label(value)}</Text>
              {scope === value ? <Dot className="size-icon-md text-foreground" /> : null}
            </Pressable>
          ))}
        </MenuSheet>
      ) : null}
    </Sheet>
  );
}

/** "+3 −1", the desktop's Counts: mono, tabular, green and red, a zero dim. */
function Counts({ insertions, deletions }: { insertions: number; deletions: number }) {
  return (
    <Text style={st.counts}>
      <Text style={{ color: insertions === 0 ? color.mutedForeground : color.success }}>+{insertions}</Text>{" "}
      <Text style={{ color: deletions === 0 ? color.mutedForeground : color.destructive }}>−{deletions}</Text>
    </Text>
  );
}

/** A file's header, as FileSection's: its icon, path and counts; the click opens or folds its diff. */
function FileHeader({ file, open, onPress }: { file: File; open: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} onPress={onPress} style={({ pressed }) => [st.file, pressed && { backgroundColor: color.fill }]}>
      <FileIcon name={file.path} />
      <Text style={st.path} numberOfLines={1}>{file.from ? `${file.from} → ${file.path}` : file.path}</Text>
      {file.binary ? <Text style={st.binary}>{REVIEW_WORDS.binary}</Text> : <Counts {...file} />}
    </Pressable>
  );
}

/** Before the first list arrives: three file headers' worth of grey, pulsing. */
function ListLoading() {
  const pulse = usePulse();
  return (
    <View style={st.loading}>
      {[0, 1, 2].map((at) => <Animated.View key={at} style={[st.skeleton, { opacity: pulse }]} />)}
    </View>
  );
}

function FileView({ id, scope, review, file, onBack }: { id: string; scope: Scope; review: Review; file: File; onBack: () => void }) {
  const { run } = forMac();
  const [contents, setContents] = useState<{ before: string; after: string; hunks: Hunk[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const where = scope === "last" ? ["last", review.turn?.before ?? "", review.turn?.after ?? ""] : [scope];
    void run(["source", id, "review-file", ...where, file.path, ...(file.from ? [file.from] : [])]).then((reply) => {
      if (!reply.ok) return setError(failure(reply));
      if (reply.contents.error) return setError(String(reply.contents.error));
      setContents(reply.contents);
    });
  }, []);
  return (
    <>
      <FileHeader file={file} open onPress={onBack} />
      {file.binary ? (
        <Text style={st.muted}>{REVIEW_WORDS.binaryFile}</Text>
      ) : error ? (
        <Text accessibilityRole="alert" style={[st.muted, st.error]}>{couldntReadDiff(error)}</Text>
      ) : !contents ? (
        <View style={[st.muted, st.row]}>
          <Spin><Spinner className="size-icon-sm text-muted-foreground" /></Spin>
          <Text style={st.mutedText}>{REVIEW_WORDS.loading}</Text>
        </View>
      ) : contents.hunks.length === 0 ? (
        <Text style={st.muted}>{REVIEW_WORDS.noContentChanges}</Text>
      ) : (
        <Diff {...contents} />
      )}
    </>
  );
}

type Line = { mark: " " | "-" | "+"; number: number; line: string } | { gap: number };

/** The engine's unified look: numbered lines, a changed one tinted with a bar at its start, and the unchanged lines
 * between hunks as "N unmodified lines", as its line-info separators. */
function Diff({ before, after, hunks }: { before: string; after: string; hunks: Hunk[] }) {
  const old = before.split("\n");
  const now = after.split("\n");
  const lines: Line[] = [];
  let shown = 0; // the new side's last line drawn
  for (const hunk of hunks) {
    const [, a = "1", b = "1", c = "1", d = "1"] = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header) ?? [];
    // A hunk with no new lines sits after its start line, not on it.
    const start = +d === 0 ? +c : +c - 1;
    if (start > shown) lines.push({ gap: start - shown });
    let [o, n] = [+a, +c];
    for (const [mark, line] of lineDiff(old.slice(+a - 1, +a - 1 + +b), now.slice(+c - 1, +c - 1 + +d))) {
      // Unified shows one number: a removed line's old one, any other's new one.
      lines.push({ mark, line, number: mark === "-" ? o : n });
      if (mark !== "+") o++;
      if (mark !== "-") n++;
    }
    shown = start + +d;
  }
  const total = after === "" ? 0 : after.endsWith("\n") ? now.length - 1 : now.length;
  if (total > shown) lines.push({ gap: total - shown });
  const digits = String(Math.max(old.length, now.length)).length;
  return (
    <ScrollView horizontal contentContainerStyle={st.diffScroll}>
      <View style={st.diff}>
        {lines.map((each, at) =>
          "gap" in each ? (
            <View key={at} style={[st.separator, at === 0 && { marginTop: 0 }, at === lines.length - 1 && { marginBottom: 0 }]}>
              <Text style={st.separatorText}>{plural(each.gap, "unmodified line")}</Text>
            </View>
          ) : (
            <View key={at} style={[st.line, each.mark !== " " && { backgroundColor: each.mark === "+" ? color.diffAdded : color.diffRemoved }]}>
              {each.mark !== " " ? <View style={[st.indicator, { backgroundColor: each.mark === "+" ? color.success : color.destructive }]} /> : null}
              <Text style={[st.code, st.number]}>{String(each.number).padStart(digits)}</Text>
              <Text style={[st.code, st.content]}>{each.line}</Text>
            </View>
          ),
        )}
      </View>
    </ScrollView>
  );
}

const st = StyleSheet.create({
  // The tab's own background, out to the sheet's edges.
  tab: { marginHorizontal: -space(5), backgroundColor: color.background },
  bar: { flexDirection: "row", alignItems: "center", height: spacing.panelHeader, gap: space(1), paddingHorizontal: space(2), borderBottomWidth: 1, borderBottomColor: color.border },
  trigger: { flexDirection: "row", alignItems: "center", height: spacing.controlXs, gap: space(1), paddingHorizontal: space(1.5), borderRadius: radius.control },
  triggerText: { ...text.sm, color: color.mutedForeground },
  error: { ...text.sm, lineHeight: space(5.25), color: color.destructive },
  listError: { paddingHorizontal: space(4), paddingVertical: space(3) },
  empty: { ...text.sm, color: color.quietForeground, paddingVertical: space(8), textAlign: "center" },
  brief: { gap: space(1), paddingHorizontal: space(3), paddingVertical: space(2.5), borderBottomWidth: 1, borderBottomColor: color.divider, backgroundColor: color.fillFaint },
  briefText: { ...text.xs, color: color.mutedForeground },
  none: { ...text.sm, color: color.mutedForeground, padding: space(4) },
  counts: { ...text.xs, fontFamily: mono, fontVariant: ["tabular-nums"], flexShrink: 0 },
  // A finger's height, past the desktop's h-control-lg.
  file: { flexDirection: "row", alignItems: "center", minHeight: touch, gap: space(2), paddingHorizontal: space(3), borderBottomWidth: 1, borderBottomColor: color.border, backgroundColor: color.background },
  path: { ...text.sm, color: color.foreground, flexShrink: 1 },
  binary: { ...text.xs, color: color.mutedForeground },
  loading: { gap: space(3), padding: space(3) },
  skeleton: { height: spacing.controlXs, width: "50%", borderRadius: radius.control, backgroundColor: color.muted },
  muted: { ...text.sm, color: color.mutedForeground, paddingHorizontal: space(3), paddingVertical: space(2) },
  row: { flexDirection: "row", alignItems: "center", gap: space(2) },
  mutedText: { ...text.sm, color: color.mutedForeground },
  diffScroll: { flexGrow: 1 },
  diff: { flexGrow: 1, paddingVertical: space(2) },
  separator: { justifyContent: "center", height: space(8), marginVertical: space(2), paddingHorizontal: space(2), backgroundColor: color.fillSubtle },
  separatorText: { ...text.xs, color: color.mutedForeground },
  line: { flexDirection: "row" },
  indicator: { position: "absolute", left: 0, top: 0, bottom: 0, width: space(1) },
  code: { ...text.diff, fontFamily: mono },
  number: { color: color.mutedForeground, paddingStart: space(4), paddingEnd: space(2) },
  content: { color: color.foreground, paddingEnd: space(3) },
});

/** A hunk's lines kept, removed or added: the longest run its two sides share, as git cut it from the same two. */
export function lineDiff(old: string[], now: string[]): [" " | "-" | "+", string][] {
  // shortcut: a hunk past a million line pairs shows its old lines, then its new ones; match them if one shows up.
  if (old.length * now.length > 1e6) return [...old.map((line): ["-", string] => ["-", line]), ...now.map((line): ["+", string] => ["+", line])];
  const n = old.length;
  const m = now.length;
  const longest = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) longest[i]![j] = old[i] === now[j] ? longest[i + 1]![j + 1]! + 1 : Math.max(longest[i + 1]![j]!, longest[i]![j + 1]!);
  const out: [" " | "-" | "+", string][] = [];
  let [i, j] = [0, 0];
  while (i < n && j < m) {
    if (old[i] === now[j]) out.push([" ", old[i++]!]), j++;
    else if (longest[i + 1]![j]! >= longest[i]![j + 1]!) out.push(["-", old[i++]!]);
    else out.push(["+", now[j++]!]);
  }
  while (i < n) out.push(["-", old[i++]!]);
  while (j < m) out.push(["+", now[j++]!]);
  return out;
}
