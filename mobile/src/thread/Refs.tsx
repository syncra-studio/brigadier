// A reply's refs, as the desktop's thread/refs.tsx draws them: a word remarkRefs marked is a PR the session's card
// lists or another session, where the answer names it; anything else stays the word [D251]. Phone-only: no file or
// folder links (Rust's `paths` isn't the phone's to ask, and the Mac's files don't open here), nor `/` commands (the
// phone lists them only as the composer's menu opens).
import { useNavigation } from "@react-navigation/native";
import { type ReactNode, useSyncExternalStore } from "react";
import { Linking, Text } from "react-native";
import { SIDEBAR_WORDS } from "../../../app/shared/words";
import { Chat, PR_LOOK } from "../../../app/ui/src/icons";
import { WorkerGlyph } from "../../../app/ui/src/icons/worker-glyphs";
import { lists, openThread, thread } from "../mac/mac";
import { color } from "../theme";

export function RefWord({ word, plain }: { word: string; plain: ReactNode }) {
  const owner = useSyncExternalStore(thread.subscribe, () => thread.get()?.id);
  const { rows, projects } = useSyncExternalStore(lists.subscribe, lists.get);
  const navigation = useNavigation<{ setParams: (params: { id: string; title: string }) => void }>();
  if (!owner) return plain;
  if (/^#\d+$/.test(word)) {
    // A folder chat's bare number names no repository.
    const row = rows.find((each) => each.id === owner);
    const folder = projects.find((project) => project.id === row?.project)?.kind === "folder";
    const hits = folder ? [] : (row?.prs?.prs.filter((pr) => pr.number === Number(word.slice(1))) ?? []);
    const pr = hits.length === 1 ? hits[0]! : null;
    if (!pr) return plain;
    const { Icon, tint } = PR_LOOK[pr.state === "open" && pr.draft ? "draft" : pr.state];
    const url = pr.url;
    return (
      <Text style={{ color: color.link }} accessibilityRole="link" accessibilityHint={pr.title} onPress={url ? () => void Linking.openURL(url) : undefined}>
        <Icon className={`size-icon-sm ${tint}`} />#{pr.number}
      </Text>
    );
  }
  const row = word !== owner ? rows.find((each) => each.id === word) : undefined;
  if (!row) return plain;
  const title = row.title || SIDEBAR_WORDS.untitled;
  const open = () => {
    openThread(row.id);
    navigation.setParams({ id: row.id, title });
  };
  return (
    <Text style={{ color: color.link }} accessibilityRole="link" onPress={open}>
      {row.worker ? <WorkerGlyph id={row.id} className="size-icon-sm" /> : <Chat className="size-icon-sm text-link" />}
      {title}
    </Text>
  );
}
