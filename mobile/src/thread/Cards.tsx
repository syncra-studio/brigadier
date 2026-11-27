// The cards waiting on the user, drawn read only after the desktop's composer approval and question cards; answering comes later.
import { StyleSheet, Text, View } from "react-native";
import type { PendingApproval, PendingQuestion } from "../../vendor/brigadier-shared/cards";
import { color, text } from "../theme";
import { describe } from "./rows/asks";

export function Cards({ approvals, questions }: { approvals?: PendingApproval[]; questions?: PendingQuestion[] }) {
  if (!approvals?.length && !questions?.length) return null;
  return (
    <View style={st.cards}>
      {approvals?.map((approval) => <ApprovalCard key={approval.id} approval={approval} />)}
      {questions?.map((question) => <QuestionCard key={question.id} question={question} />)}
    </View>
  );
}

/** An approval: its kind (and the subagent asking), the reason as the title, the exact thing asked about. */
function ApprovalCard({ approval }: { approval: PendingApproval }) {
  const shown = describe(approval);
  return (
    <View style={st.card} accessibilityLabel="Approval">
      <Text style={st.kind}>{shown.kind}{approval.agent ? ` · ${approval.agent}` : ""}</Text>
      <Text style={st.title} accessibilityRole="header">{shown.title}{approval.review?.waits && !approval.revising ? " · waiting for you" : ""}</Text>
      {shown.detail ? <Text style={st.detail}>{shown.detail}</Text> : null}
      {shown.body || null}
      <OnMac />
    </View>
  );
}

/** A question or a round of them: each question and its answers, the recommended one marked. */
function QuestionCard({ question }: { question: PendingQuestion }) {
  return (
    <View style={st.card} accessibilityLabel="Question">
      {question.title ? <Text style={st.kind}>{question.title}</Text> : null}
      {question.items.map((item, at) => (
        <View key={at} style={{ gap: 6 }}>
          <Text style={st.title} accessibilityRole="header">{item.text}</Text>
          {item.options.map((option, n) => (
            <View key={n} style={st.option}>
              <Text style={st.number}>{n + 1}</Text>
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={st.label}>
                  {option.label}
                  {item.recommended === n ? <Text style={st.recommended}>  Recommended</Text> : null}
                </Text>
                {option.description ? <Text style={st.detail}>{option.description}</Text> : null}
              </View>
            </View>
          ))}
        </View>
      ))}
      <OnMac />
    </View>
  );
}

const OnMac = () => <Text style={st.onMac}>Answer on your Mac</Text>;

const st = StyleSheet.create({
  cards: { gap: 12, paddingTop: 24 },
  card: { gap: 10, borderRadius: 16, backgroundColor: color.muted, padding: 16 },
  kind: { fontSize: 13, lineHeight: 20, color: color.mutedForeground },
  title: { ...text.base, fontWeight: "500", color: color.foreground },
  detail: { ...text.sm, color: color.mutedForeground },
  option: { flexDirection: "row", gap: 10, borderRadius: 10, backgroundColor: color.fill, paddingHorizontal: 12, paddingVertical: 8 },
  number: { ...text.sm, minWidth: 14, color: color.mutedForeground },
  label: { ...text.sm, color: color.foreground },
  recommended: { fontSize: 12, color: color.mutedForeground },
  onMac: { ...text.sm, color: color.mutedForeground, paddingTop: 2 },
});
