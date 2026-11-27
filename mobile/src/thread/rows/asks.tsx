// Approvals and questions in the thread, after the desktop's components/thread/cards.tsx and composer/approval.tsx's describe.
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import type { PendingApproval, PendingQuestion, QuestionItem } from "../../../vendor/brigadier-shared/cards";
import type { ApprovalAction, Item, SentFile, Turn } from "../../../vendor/brigadier-shared/thread";
import { color } from "../../theme";
import { Box, Glyph, Line, Opening, s, Words } from "./parts";

const WITHDRAWN = "withdrawn";
/** The session that started a worker, which a request it answers names [D131]; the desktop's own default name. */
const PARENT = "Its parent";

const Code = ({ children }: { children: ReactNode }) => <Text style={s.code} selectable>{children}</Text>;
const Faint = ({ children }: { children: ReactNode }) => <Text style={[s.code, { color: color.mutedForeground }]}>{children}</Text>;

/** What an approval asks, compactly: its kind, the reason (or the plain question) as the title, the exact thing asked about. */
export function describe(approval: PendingApproval): { kind: string; title: string; detail?: string; body?: ReactNode } {
  const { action, reason, command, cwd, paths = [], host, input, body } = approval;
  const prose = body ? <Box><Text style={[s.row, { color: color.foreground }]} selectable>{body}</Text></Box> : undefined;
  switch (action) {
    case "command":
      return {
        kind: "Terminal",
        title: reason || "Allow this command?",
        body: command && (
          <Box>
            <Code>{command}</Code>
            {cwd ? <Faint>in {cwd}</Faint> : null}
            {paths.length > 0 && <Faint>with {paths.join(", ")}</Faint>}
          </Box>
        ),
      };
    case "edit":
      return {
        kind: "Edit files",
        title: reason || (paths.length === 1 ? "Allow editing this file?" : "Allow editing these files?"),
        body: paths.length > 0 && <Box>{paths.map((path) => <Code key={path}>{path}</Code>)}</Box>,
      };
    case "network":
      return {
        kind: "Internet access",
        title: reason || (host ? `Allow connecting to https://${host}?` : "Allow connecting to the internet?"),
        body: host && <Text style={[s.row, { color: color.mutedForeground }]}>{host} isn’t on this session’s list of allowed sites.</Text>,
      };
    case "land":
      return {
        kind: "Land a change",
        title: `Land this change on ${approval.branch ?? "the branch"}?`,
        detail: reason ?? undefined,
        body: approval.files && (
          <Box>
            {approval.files.map((file) => (
              <Text key={file.path} style={s.code}>
                {file.path}{"  "}
                {file.binary ? <Text style={{ color: color.mutedForeground }}>binary</Text> : <><Text style={{ color: color.success }}>+{file.insertions}</Text> <Text style={{ color: color.destructive }}>−{file.deletions}</Text></>}
              </Text>
            ))}
          </Box>
        ),
      };
    case "plan":
      return {
        kind: "Plan",
        title: approval.revising ? "Revising this plan" : approval.review ? `Reviewing this plan · ${approval.review.name}` : reason || "Build this plan?",
        detail: approval.reviewed,
        body: prose,
      };
    case "message":
      return { kind: "Message", title: `Send a message to ${approval.to ?? "another session"}?`, detail: reason ?? undefined, body: prose };
    case "browser":
      return { kind: "Browser", title: reason || "Go ahead in the browser?", body: prose };
    case "computer":
      return { kind: "Computer use", title: reason || "Use this app?", body: prose };
    default:
      return { kind: "Ask permission", title: reason || "Allow this?", body: prose ?? (input && <Box><Code>{input}</Code></Box>) };
  }
}

/** A glyph for what an approval asks to do, in place of the desktop's icons. */
const ACTIONS: Record<ApprovalAction, string> = { command: "$", edit: "✎", network: "◎", permission: "⚿", plan: "✦", land: "⑂", message: "✉", browser: "◎", computer: "⌖", other: "⚙" };

/**
 * An approval, read like a question: "Asking for approval · waiting", then "Asked for approval · allowed" or
 * "· denied", which opens to what was asked. A plan denied was sent back [D394]. Undecided once the turn moved on: withdrawn.
 */
export function ApprovalRow({ item, turn }: { item: Extract<Item, { kind: "approval" }>; turn: Turn | undefined }) {
  const { request, decision } = item;
  const shown = describe(request);
  const subject = request.command || request.host || request.paths?.join(", ") || request.input || undefined;
  const toParent = item.to === "parent";
  const action = request.action;
  const glyph = <Glyph g={ACTIONS[action] ?? ACTIONS.other} />;
  if (decision === null || decision === "withdrawn") {
    const waiting = decision === null && (turn?.status === "running" || turn?.held === true);
    const asking = toParent ? `Asking ${PARENT}` : "Asking for approval";
    const asked = toParent ? `Asked ${PARENT}` : "Asked for approval";
    return <Line>{glyph}<Words verb={waiting ? `${asking} · waiting` : `${asked} · ${WITHDRAWN}`} object={subject} live={waiting} /></Line>;
  }
  const said = decision === "approved" ? "allowed" : action !== "plan" ? "denied" : item.by === "review" ? "sent back by review" : "sent back";
  const verb = toParent ? `${PARENT} ${said}:` : `Asked for approval · ${said}`;
  return (
    <Opening
      keep={item.id}
      label={subject ? `${verb} ${subject}` : verb}
      detail={
        <View style={{ gap: 6, paddingTop: 4 }}>
          <Text style={s.row} selectable>{shown.title}</Text>
          {shown.body}
          {shown.detail ? <Text style={[s.code, { color: color.rowObject }]} selectable>{shown.detail}</Text> : null}
        </View>
      }
    >
      {glyph}
      <Words verb={verb} object={subject} />
    </Opening>
  );
}

/** An answer as the row shows it: a recommended pick says so, each one of a multi-select too; a skipped one says that. */
function answerWords(item: QuestionItem | undefined, answer: string | null): string {
  if (!answer?.trim()) return "No answer provided";
  const recommended = item?.recommended == null ? undefined : item.options[item.recommended]?.label;
  const mark = (label: string) => (label === recommended ? `${label} (Recommended)` : label);
  const labels = new Set(item?.options.map((option) => option.label));
  const picks = item?.multiSelect && !labels.has(answer) ? answer.split(", ") : [answer];
  return picks.every((pick) => labels.has(pick)) ? picks.map(mark).join(", ") : answer;
}

/**
 * A question, or a round of them: "Asking a question · waiting" while it waits; answered, "Asked a question" or
 * "Asked 3 questions", with the round's title, opening to each question and its answer; unanswered once the turn moved on, withdrawn.
 */
export function QuestionRow({ item, turn }: { item: Extract<Item, { kind: "question" }>; turn: Turn | undefined }) {
  const waiting = !item.withdrawn && (turn?.status === "running" || turn?.held === true || (item.held === true && item.answer === null));
  const toParent = item.to === "parent";
  const round: PendingQuestion | undefined = item.request;
  const items = round?.items ?? [];
  const count = Math.max(items.length, 1);
  const title = round?.title ? ` · ${round.title}` : "";
  const asked = toParent ? `${PARENT} answered${title}` : `Asked ${count === 1 ? "a question" : `${count} questions`}${title}`;
  const glyph = <Glyph g="?" />;
  if (item.answer === null) {
    const asking = toParent ? `Asking ${PARENT}` : count === 1 ? "Asking a question" : "Asking questions";
    return <Line>{glyph}<Words verb={waiting ? `${asking} · waiting` : `${toParent ? `Asked ${PARENT}${title}` : asked} · ${WITHDRAWN}`} live={waiting} /></Line>;
  }
  const answers = item.answers;
  const pairs = items.length > 0 ? items.map((each, at) => ({ text: each.text, given: answerWords(each, answers ? (answers[at] ?? null) : at === 0 ? item.answer : null) })) : [{ text: item.question, given: item.answer }];
  return (
    <Opening
      keep={item.id}
      label={asked}
      detail={
        <View style={{ gap: 12, paddingTop: 4 }}>
          {pairs.map((pair, at) => (
            <View key={at} style={{ gap: 4 }}>
              <Text style={s.row} selectable>{pair.text}</Text>
              <Text style={[s.row, { color: color.rowObject }]} selectable>{pair.given}</Text>
              <Files files={item.files?.[at]} />
            </View>
          ))}
        </View>
      }
    >
      {glyph}
      <Words verb={asked} />
    </Opening>
  );
}

/** An answer's files by name. */
function Files({ files }: { files?: SentFile[] | null }) {
  const shown = files?.filter((file) => !file.pasted) ?? [];
  return shown.length ? <Text style={s.small}>{shown.map((file) => file.name).join(", ")}</Text> : null;
}
