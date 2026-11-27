import { useMemo, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import type { Session } from "../../vendor/brigadier-shared/thread";
import { datedMessages } from "../../vendor/brigadier-shared/words";
import { older, thread } from "../mac/mac";
import { color, text } from "../theme";
import { Cards } from "./Cards";
import { type Line, lineMaker, workKey } from "./lines";
import { Row } from "./Row";

/** The open session's thread, read only: its rows as the desktop draws them, its waiting cards under them. */
export function Thread() {
  const open = useSyncExternalStore(thread.subscribe, thread.get);
  if (!open || (!open.session && open.status === "loading")) return <Centered><ActivityIndicator color={color.foreground} /></Centered>;
  const problem = open.status === "missing" ? "This session is no longer on your Mac." : open.status === "error" ? "Couldn't open this session." : null;
  if (!open.session) return <Centered><Text style={styles.muted}>{problem}</Text></Centered>;
  return (
    <View style={styles.page}>
      {/* Its rows as last seen stay under the reason they're no longer live. */}
      {problem && <Text style={[styles.muted, styles.banner]}>{problem}</Text>}
      <Rows session={open.session} />
    </View>
  );
}

/** Rows of a session, newest at the bottom; scrolling up past the first loads the page before it. */
export function Rows({ session, onOlder = older }: { session: Session; onOlder?: () => void }) {
  const make = useMemo(lineMaker, []);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const turns = useMemo(() => new Map(session.turns.map((t) => [t.id, t])), [session.turns]);
  const work = useMemo(() => new Map((session.work ?? []).map((w) => [w.turnId, w])), [session.work]);
  const lines = withSetup(make(session.items, turns, work, opened), session);
  const dated = useMemo(() => datedMessages(session.items), [session.items]);
  // Inverted, so it opens at the newest row and stays there as rows come.
  const data = useMemo(() => lines.slice().reverse(), [lines]);
  const toggle = (id: string) =>
    setOpened((was) => {
      const next = new Set(was);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  return (
    <FlatList
      style={styles.page}
      inverted
      data={data}
      keyExtractor={(line) => line.id}
      renderItem={({ item }) => <Row line={item} onToggle={toggle} dated={dated.has(item.id)} />}
      contentContainerStyle={styles.content}
      // Rows coming in keep the one being read in place; near the newest, it follows them.
      maintainVisibleContentPosition={{ minIndexForVisible: 0, autoscrollToTopThreshold: 40 }}
      onEndReached={() => void onOlder()}
      onEndReachedThreshold={0.5}
      // Inverted: the header is at the bottom, under the newest row.
      ListHeaderComponent={<Cards approvals={session.approvals} questions={session.questions} session={session.id} />}
      ListFooterComponent={session.before != null ? <ActivityIndicator style={{ padding: 16 }} color={color.mutedForeground} /> : undefined}
    />
  );
}

/** The worktree's setup row under its input, as the desktop's thread.tsx places it [D70, D77, D85]. */
function withSetup(rows: Line[], session: Session): Line[] {
  const setup = session.setup;
  if (!setup) return rows;
  // Before its input is in (a start still setting up, or one that failed doing it), it is the newest row.
  if (setup.after === null) return [...rows, { type: "setup", id: `${session.id}:setup`, gap: rows.length ? "turn" : "first", setup }];
  const at = rows.findIndex((row) => row.id === setup.after);
  if (at < 0) return rows;
  // Its turn's work's first item: folded away with it.
  const next = rows[at + 1];
  if (next?.type === "work" && next.open === false) return rows;
  const input = rows[at]!;
  const turn = input.type === "item" ? input.turn : undefined;
  const line: Line = { type: "setup", id: `${session.id}:setup`, gap: next?.type === "work" || turn ? "part" : "turn", setup };
  if (next?.type === "work") return [...rows.slice(0, at + 2), line, ...rows.slice(at + 2)];
  if (!turn) return [...rows.slice(0, at + 1), line, ...rows.slice(at + 1)];
  const head: Line = { type: "work", id: workKey(turn.id), gap: "turn", turn, work: undefined, open: null };
  return [...rows.slice(0, at + 1), head, line, ...rows.slice(at + 1)];
}

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={[styles.page, { alignItems: "center", justifyContent: "center", padding: 24 }]}>{children}</View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.background },
  content: { paddingHorizontal: 16, paddingVertical: 12 },
  muted: { ...text.base, color: color.mutedForeground, textAlign: "center" },
  banner: { padding: 12, borderBottomWidth: 1, borderBottomColor: color.border },
});
