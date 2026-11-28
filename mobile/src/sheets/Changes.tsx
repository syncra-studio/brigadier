// The session's changes, as the desktop's Review tab reads them [D1035, D1036]: a scope's files with their counts, one
// opened to its hunks. Rust sends each side whole and where its hunks sit; the lines of a hunk are matched here.
import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { failure } from "../../../app/shared/session/run";
import { forMac } from "../compose/state";
import { color, mono } from "../theme";
import { Sheet, st } from "./Sheet";

type Scope = "last" | "uncommitted" | "branch";
export type File = { path: string; from: string | null; status: string; insertions: number; deletions: number; binary?: boolean };
type Review = { files: File[]; insertions: number; deletions: number; base?: string | null; none?: string; turn?: { before: string; after: string } };
type Hunk = { id: string; header: string };

/** Last turn with nothing to compare: Rust's reason in the desktop's words (review/brief.tsx). */
const NO_TURN: Record<string, string> = {
  noNight: "This night's start or end wasn't captured, so there's nothing to compare.",
  noProject: "This chat has no project folder, so there's no turn's files to show.",
  notGit: "This folder isn't a git checkout, so Review can't show the last turn.",
  noTurn: "No turn yet. What the next one changes shows here.",
  midTurn: "The last message was sent while a turn ran, so it has no capture of its own.",
  noSnapshot: "The last turn's start wasn't captured, so there's nothing to compare.",
};

/** `file`: one opened from the start (a sample screen). */
export function Changes({ id, file: opened, onClose }: { id: string; file?: File; onClose: () => void }) {
  const { run } = forMac();
  const [scope, setScope] = useState<Scope>("last");
  const [review, setReview] = useState<Review | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(opened ?? null);
  useEffect(() => void run(["source", id, "status"]).then((reply) => reply.ok && setBranch(reply.git?.head?.branch ?? null)), [id]);
  useEffect(() => {
    let live = true;
    setReview(null);
    setError(null);
    void run(["source", id, "review", scope]).then((reply) => live && (reply.ok ? setReview(reply.review) : setError(failure(reply))));
    return () => void (live = false);
  }, [id, scope]);
  const scopes: [Scope, string][] = [["last", "Last turn"], ["uncommitted", "Uncommitted changes"], ["branch", `Branch since ${(scope === "branch" && review?.base) || "base"}`]];
  const list = (
    <>
      {branch && <Text style={st.muted}>On {branch}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {scopes.map(([value, label]) => (
          <Pressable key={value} accessibilityRole="radio" accessibilityState={{ checked: scope === value }} onPress={() => setScope(value)} style={[st.item, { paddingVertical: 8 }, scope === value && st.on]}>
            <Text style={st.muted}>{label}</Text>
          </Pressable>
        ))}
      </View>
      {error && <Text style={st.error}>{error}</Text>}
      {!review && !error && <ActivityIndicator color={color.mutedForeground} />}
      {review?.none ? <Text style={st.muted}>{NO_TURN[review.none] ?? review.none}</Text> : review?.files.length === 0 ? <Text style={st.muted}>No changes</Text> : null}
      {review && review.files.length > 0 && <Text style={st.muted}>{review.files.length === 1 ? "1 file" : `${review.files.length} files`} · <Counts {...review} /></Text>}
      {review?.files.map((each) => (
        <Pressable key={each.path} accessibilityRole="button" onPress={() => setFile(each)} style={st.item}>
          <Text style={[st.body, { flex: 1 }]} numberOfLines={2}>{each.from ? `${each.from} → ${each.path}` : each.path}</Text>
          {each.binary ? <Text style={st.muted}>Binary</Text> : <Text style={st.muted}><Counts {...each} /></Text>}
        </Pressable>
      ))}
    </>
  );
  // One sheet throughout, its file's diff in place of the list: a sheet can't give way to another as it goes.
  return (
    <Sheet title={file ? (file.path.split("/").pop() ?? file.path) : "Changes"} onClose={onClose}>
      {file && review ? <FileView id={id} scope={scope} review={review} file={file} onBack={() => setFile(null)} /> : list}
    </Sheet>
  );
}

function Counts({ insertions, deletions }: { insertions: number; deletions: number }) {
  return (
    <>
      <Text style={{ color: color.success }}>+{insertions}</Text> <Text style={{ color: color.destructive }}>−{deletions}</Text>
    </>
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
  const before = contents?.before.split("\n") ?? [];
  const after = contents?.after.split("\n") ?? [];
  return (
    <>
      <Pressable accessibilityRole="button" onPress={onBack} hitSlop={8}>
        <Text style={st.link}>‹ All files</Text>
      </Pressable>
      <Text style={st.muted}>{file.from ? `${file.from} → ${file.path}` : file.path}</Text>
      {error && <Text style={st.error}>{error}</Text>}
      {!contents && !error && <ActivityIndicator color={color.mutedForeground} />}
      {file.binary ? <Text style={st.muted}>Binary file</Text> : contents?.hunks.length === 0 ? <Text style={st.muted}>No changes</Text> : null}
      {!file.binary &&
        contents?.hunks.map((hunk) => {
          const [, a = "1", b = "1", c = "1", d = "1"] = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(hunk.header) ?? [];
          const old = before.slice(+a - 1, +a - 1 + +b);
          const now = after.slice(+c - 1, +c - 1 + +d);
          return (
            <ScrollView key={hunk.id} horizontal style={{ backgroundColor: color.codeSurface, borderRadius: 8 }} contentContainerStyle={{ paddingVertical: 6 }}>
              <View>
                <Text style={{ fontFamily: mono, fontSize: 12, lineHeight: 17, color: color.mutedForeground, paddingHorizontal: 8 }}>{hunk.header}</Text>
                {lineDiff(old, now).map(([mark, line], at) => (
                  <Text key={at} style={{ fontFamily: mono, fontSize: 12, lineHeight: 17, paddingHorizontal: 8, color: color.foreground, backgroundColor: mark === "+" ? "rgba(84,206,136,0.15)" : mark === "-" ? "rgba(255,103,100,0.15)" : undefined }}>
                    {mark} {line}
                  </Text>
                ))}
              </View>
            </ScrollView>
          );
        })}
    </>
  );
}

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
