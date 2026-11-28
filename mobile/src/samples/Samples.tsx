// The shared samples, one per item kind and card [D58], each drawn as the thread draws rows, as the desktop's `pnpm thread` Samples.
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { PendingApproval, PendingQuestion } from "../../../app/shared/cards";
import type { Item, Turn, Work } from "../../../app/shared/thread";
import approvalCards from "../../../app/shared/samples/approval-cards.json";
import approval from "../../../app/shared/samples/approval.json";
import childAgent from "../../../app/shared/samples/child-agent.json";
import compaction from "../../../app/shared/samples/compaction.json";
import fileChange from "../../../app/shared/samples/file-change.json";
import forked from "../../../app/shared/samples/forked.json";
import group from "../../../app/shared/samples/group.json";
import image from "../../../app/shared/samples/image.json";
import markdown from "../../../app/shared/samples/markdown.json";
import line from "../../../app/shared/samples/line.json";
import message from "../../../app/shared/samples/message.json";
import mockup from "../../../app/shared/samples/mockup.json";
import notice from "../../../app/shared/samples/notice.json";
import overnight from "../../../app/shared/samples/overnight.json";
import peer from "../../../app/shared/samples/peer.json";
import questionCards from "../../../app/shared/samples/question-cards.json";
import question from "../../../app/shared/samples/question.json";
import reasoning from "../../../app/shared/samples/reasoning.json";
import shell from "../../../app/shared/samples/shell.json";
import started from "../../../app/shared/samples/started.json";
import switchSample from "../../../app/shared/samples/switch.json";
import team from "../../../app/shared/samples/team.json";
import tool from "../../../app/shared/samples/tool.json";
import unknown from "../../../app/shared/samples/unknown.json";
import Link from "../../modules/link";
import { color } from "../theme";
import { Cards } from "../thread/Cards";
import { lineMaker } from "../../../app/shared/lines";
import { Row } from "../thread/Row";

// The files' items carry no turn or `n`: each sample gets a done turn of its own, its rows counted from 1, so a group's span reaches its steps.
const ROWS: [string, { items: unknown[] }][] = Object.entries({
  approval, "child-agent": childAgent, compaction, "file-change": fileChange, forked, group, image, line, markdown, message, mockup, notice,
  overnight, peer, question, reasoning, shell, started, switch: switchSample, team, tool, unknown,
});
const only = Link.screen?.startsWith("samples:") ? Link.screen.slice("samples:".length) : null;

const NO_WORK: ReadonlyMap<string, Work> = new Map();

export function Samples() {
  return (
    <SafeAreaView style={st.page} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={st.content}>
        {ROWS.filter(([name]) => !only || name === only).map(([name, file]) => (
          <Sample key={name} name={name} items={file.items} />
        ))}
        {!only || only === "cards" ? (
          <>
            <Text style={st.name} accessibilityRole="header">approval-cards, question-cards</Text>
            <Cards approvals={approvalCards as PendingApproval[]} questions={questionCards as PendingQuestion[]} />
          </>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function Sample({ name, items: raw }: { name: string; items: unknown[] }) {
  const turnId = `sample:${name}`;
  const [items, turns] = useMemo(() => {
    const items = raw.map((item, at) => ({ ...(item as object), turnId, n: at + 1 }) as Item);
    const turn: Turn = { id: turnId, status: "done", startedAt: 0, endedAt: 0 };
    return [items, new Map([[turnId, turn]])] as const;
  }, [raw, turnId]);
  const make = useMemo(lineMaker, []);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((was) => {
      const next = new Set(was);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <View style={st.sample}>
      <Text style={st.name} accessibilityRole="header">{name}</Text>
      {make(items, turns, NO_WORK, open).map((each) => (
        <Row key={each.id} line={each} onToggle={toggle} />
      ))}
    </View>
  );
}

const st = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.background },
  content: { paddingHorizontal: 16, paddingBottom: 48 },
  sample: { paddingTop: 8 },
  name: { fontSize: 12, lineHeight: 16, fontWeight: "600", letterSpacing: 0.5, textTransform: "uppercase", color: color.mutedForeground, paddingTop: 32, paddingBottom: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: color.border },
});
