// The shared samples, one per item kind and card [D58], each drawn as the thread draws rows, as the desktop's `pnpm thread` Samples.
import { useMemo, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { PendingApproval, PendingQuestion } from "../../vendor/brigadier-shared/cards";
import type { Item, Turn, Work } from "../../vendor/brigadier-shared/thread";
import approvalCards from "../../vendor/brigadier-shared/samples/approval-cards.json";
import approval from "../../vendor/brigadier-shared/samples/approval.json";
import childAgent from "../../vendor/brigadier-shared/samples/child-agent.json";
import compaction from "../../vendor/brigadier-shared/samples/compaction.json";
import fileChange from "../../vendor/brigadier-shared/samples/file-change.json";
import forked from "../../vendor/brigadier-shared/samples/forked.json";
import group from "../../vendor/brigadier-shared/samples/group.json";
import image from "../../vendor/brigadier-shared/samples/image.json";
import line from "../../vendor/brigadier-shared/samples/line.json";
import message from "../../vendor/brigadier-shared/samples/message.json";
import mockup from "../../vendor/brigadier-shared/samples/mockup.json";
import notice from "../../vendor/brigadier-shared/samples/notice.json";
import overnight from "../../vendor/brigadier-shared/samples/overnight.json";
import peer from "../../vendor/brigadier-shared/samples/peer.json";
import questionCards from "../../vendor/brigadier-shared/samples/question-cards.json";
import question from "../../vendor/brigadier-shared/samples/question.json";
import reasoning from "../../vendor/brigadier-shared/samples/reasoning.json";
import shell from "../../vendor/brigadier-shared/samples/shell.json";
import started from "../../vendor/brigadier-shared/samples/started.json";
import switchSample from "../../vendor/brigadier-shared/samples/switch.json";
import team from "../../vendor/brigadier-shared/samples/team.json";
import tool from "../../vendor/brigadier-shared/samples/tool.json";
import unknown from "../../vendor/brigadier-shared/samples/unknown.json";
import { color, text } from "../theme";
import { Cards } from "../thread/Cards";
import { lineMaker } from "../thread/lines";
import { Row } from "../thread/Row";

// The files' items carry no turn or `n`: each sample gets a done turn of its own, its rows counted from 1, so a group's span reaches its steps.
const ROWS: [string, { items: unknown[] }][] = Object.entries({
  approval, "child-agent": childAgent, compaction, "file-change": fileChange, forked, group, image, line, message, mockup, notice,
  overnight, peer, question, reasoning, shell, started, switch: switchSample, team, tool, unknown,
});

const NO_WORK: ReadonlyMap<string, Work> = new Map();

export function Samples() {
  return (
    <SafeAreaView style={st.page} edges={["top", "bottom"]}>
      <ScrollView contentContainerStyle={st.content}>
        {ROWS.map(([name, file]) => (
          <Sample key={name} name={name} items={file.items} />
        ))}
        <Text style={st.name} accessibilityRole="header">approval-cards, question-cards</Text>
        <Cards approvals={approvalCards as PendingApproval[]} questions={questionCards as PendingQuestion[]} />
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
