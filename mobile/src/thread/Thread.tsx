import { useMemo, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from "react-native";
import type { Session } from "../../vendor/brigadier-shared/thread";
import { datedMessages } from "../../vendor/brigadier-shared/words";
import { older, thread } from "../mac/mac";
import { color, text } from "../theme";
import { Cards } from "./Cards";
import { lineMaker } from "./lines";
import { Row } from "./Row";

/** The open session's thread, read only: its rows as the desktop draws them, its waiting cards under them. */
export function Thread() {
  const open = useSyncExternalStore(thread.subscribe, thread.get);
  if (!open || (!open.session && open.status === "loading")) return <Centered><ActivityIndicator color={color.foreground} /></Centered>;
  if (!open.session) return <Centered><Text style={styles.muted}>{open.status === "missing" ? "This session is no longer on your Mac." : "Couldn't open this session."}</Text></Centered>;
  return <Rows session={open.session} />;
}

/** Rows of a session, newest at the bottom; scrolling up past the first loads the page before it. */
export function Rows({ session, onOlder = older }: { session: Session; onOlder?: () => void }) {
  const make = useMemo(lineMaker, []);
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set());
  const turns = useMemo(() => new Map(session.turns.map((t) => [t.id, t])), [session.turns]);
  const work = useMemo(() => new Map((session.work ?? []).map((w) => [w.turnId, w])), [session.work]);
  const lines = make(session.items, turns, work, opened);
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
      onEndReached={() => void onOlder()}
      onEndReachedThreshold={0.5}
      // Inverted: the header is at the bottom, under the newest row.
      ListHeaderComponent={<Cards approvals={session.approvals} questions={session.questions} />}
      ListFooterComponent={session.before != null ? <ActivityIndicator style={{ padding: 16 }} color={color.mutedForeground} /> : undefined}
    />
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <View style={[styles.page, { alignItems: "center", justifyContent: "center", padding: 24 }]}>{children}</View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.background },
  content: { paddingHorizontal: 16, paddingVertical: 12 },
  muted: { ...text.base, color: color.mutedForeground, textAlign: "center" },
});
