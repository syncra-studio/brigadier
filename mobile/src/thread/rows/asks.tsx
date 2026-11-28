// Approvals and questions in the thread, after the desktop's components/thread/cards.tsx, and what an approval asks,
// after composer/approval.tsx's describe and decision-parts.tsx's ToolBox, ActionFileList and CodeSpans.
import { type ComponentType, Fragment, type ReactNode, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { answerWords, approvalWords, ASKED, type AskWords, askWords, PARENT, type PendingApproval, type PendingQuestion, questionWords } from "../../../../app/shared/cards";
import type { ApprovalAction, Item, SentFile, Turn } from "../../../../app/shared/thread";
import { Chat, Commit, Cursor, Dock, Globe, type IconProps, Key, PencilSquare, QuestionMarkCircle, Sparkle, Tools } from "../../../../app/ui/src/icons";
import { color, fontWeight, mono, radius, space, text } from "../../theme";
import { Line, Opening, s, StepIcon, Words } from "./parts";

/** A card's words with their backticked names as code; `exact` (a command, a tool's input) keeps the backticks as written. */
export function CodeSpans({ text: words, exact = false }: { text: string; exact?: boolean }) {
  return words.split(/`([^`\n]+)`/).map((part, index) =>
    index % 2 === 0 || exact ? <Fragment key={index}>{index % 2 === 0 ? part : `\`${part}\``}</Fragment> : <Text key={index} style={st.code}>{part}</Text>,
  );
}

/** A quiet box of exact text, the desktop's card ToolBox: mono unless `prose`; `clamp` shows three lines until Expand. */
export function CardBox({ prose = false, clamp = false, children }: { prose?: boolean; clamp?: boolean; children: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  // Measured whole once, before it's cut: a cut text reports only the lines it shows.
  const [clamped, setClamped] = useState<boolean | null>(null);
  return (
    <View style={st.box}>
      <Text
        style={[prose ? text.sm : [{ fontFamily: mono }, text.code], { color: color.toolBoxText }]}
        numberOfLines={clamp && clamped && !expanded ? 3 : undefined}
        onTextLayout={clamp && clamped === null ? (event) => setClamped(event.nativeEvent.lines.length > 3) : undefined}
        selectable
      >
        {children}
      </Text>
      {clamp && (clamped || expanded) && (
        <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)} hitSlop={8} style={st.expand}>
          <Text style={st.expandText}>{expanded ? "Collapse" : "Expand"}</Text>
        </Pressable>
      )}
    </View>
  );
}

/** Files a card asks about, the desktop's ActionFileList: the folder dim, the name bright, `trailing` at the end. */
function FileList({ files }: { files: { path: string; trailing?: ReactNode }[] }) {
  return (
    <View style={{ paddingHorizontal: space(4), paddingVertical: space(2) }}>
      <View style={st.files}>
        {files.map(({ path, trailing }) => {
          const slash = path.lastIndexOf("/");
          return (
            <View key={path} style={st.file}>
              <Text style={st.path} numberOfLines={1}>
                {slash > 0 && <Text style={{ color: color.toolbarForeground }}>{path.slice(0, slash + 1)}</Text>}
                {path.slice(slash + 1)}
              </Text>
              {trailing}
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** What an approval asks, compactly: the shared words, and the exact thing asked about as the desktop's card draws it. */
export function describe(approval: PendingApproval): AskWords & { body?: ReactNode } {
  const { action, command, cwd, paths = [], host, input, body } = approval;
  const words = askWords(approval);
  const prose = body ? <CardBox prose><CodeSpans text={body} /></CardBox> : undefined;
  switch (action) {
    case "command":
      return {
        ...words,
        body: command ? (
          <CardBox clamp>
            <CodeSpans exact text={command} />
            {cwd ? <Text style={{ color: color.cardFaint }}>{`\n${ASKED.cwd(cwd)}`}</Text> : null}
            {paths.length > 0 && <Text style={{ color: color.cardFaint }}>{`\n${ASKED.paths(paths)}`}</Text>}
          </CardBox>
        ) : undefined,
      };
    case "edit":
      return { ...words, body: paths.length > 0 ? <FileList files={paths.map((path) => ({ path }))} /> : undefined };
    case "network":
      return { ...words, body: host ? <Text style={st.note}>{ASKED.host(host)}</Text> : undefined };
    case "land":
      return {
        ...words,
        body: approval.files && (
          <FileList
            files={approval.files.map((file) => ({
              path: file.path,
              trailing: (
                <Text style={[text.xs, { fontWeight: fontWeight.normal, fontVariant: ["tabular-nums"], color: color.foreground }]}>
                  {file.binary ? <Text style={{ color: color.toolbarForeground }}>binary</Text> : <><Text style={{ color: color.success }}>+{file.insertions}</Text> <Text style={{ color: color.destructive }}>−{file.deletions}</Text></>}
                </Text>
              ),
            }))}
          />
        ),
      };
    case "plan":
    case "message":
    case "browser":
    case "computer":
      return { ...words, body: prose };
    default:
      return { ...words, body: prose ?? (input ? <CardBox clamp><CodeSpans exact text={input} /></CardBox> : undefined) };
  }
}

/** What an approval asks to do, as the old app's approval kinds drew it. */
const ACTIONS: Record<ApprovalAction, ComponentType<IconProps>> = {
  command: Dock,
  edit: PencilSquare,
  network: Globe,
  permission: Key,
  plan: Sparkle,
  land: Commit,
  message: Chat,
  browser: Globe,
  computer: Cursor,
  other: Tools,
};

// shortcut: the phone doesn't know a worker's parent's title here, so a request it answers names the desktop's default.
const parentOf = (to: string | undefined) => (to === "parent" ? PARENT : undefined);

/** The opened row: what was asked, the exact thing, the line under it, as the desktop's row detail. */
const Asked = ({ children }: { children: ReactNode }) => <View style={{ gap: space(1.5), paddingTop: space(2), paddingBottom: space(1) }}>{children}</View>;

/**
 * An approval, read like a question: "Asking for approval · waiting", then "Asked for approval · allowed" or
 * "· denied", which opens to what was asked. A plan denied was sent back [D394]. Undecided once the turn moved on: withdrawn.
 */
export function ApprovalRow({ item, turn }: { item: Extract<Item, { kind: "approval" }>; turn: Turn | undefined }) {
  const { request, decision } = item;
  const subject = request.command || request.host || request.paths?.join(", ") || request.input || undefined;
  const waiting = turn?.status === "running" || turn?.held === true;
  const verb = approvalWords(decision, request.action, waiting, parentOf(item.to), item.by === "review");
  const icon = <StepIcon icon={ACTIONS[request.action] ?? ACTIONS.other} />;
  if (decision === null || decision === "withdrawn") return <Line>{icon}<Words verb={verb} object={subject} live={waiting && decision === null} /></Line>;
  const shown = describe(request);
  return (
    <Opening
      keep={item.id}
      label={subject ? `${verb} ${subject}` : verb}
      detail={
        <Asked>
          <Text style={s.row} selectable>{shown.title}</Text>
          {shown.body}
          {shown.detail ? <Text style={[s.code, { color: color.liveTextQuiet }]} selectable>{shown.detail}</Text> : null}
        </Asked>
      }
    >
      {icon}
      <Words verb={verb} object={subject} />
    </Opening>
  );
}

/**
 * A question, or a round of them: "Asking a question · waiting" while it waits; answered, "Asked a question" or
 * "Asked 3 questions", with the round's title, opening to each question and its answer; unanswered once the turn moved on, withdrawn.
 */
export function QuestionRow({ item, turn }: { item: Extract<Item, { kind: "question" }>; turn: Turn | undefined }) {
  const waiting = !item.withdrawn && (turn?.status === "running" || turn?.held === true || (item.held === true && item.answer === null));
  const round: PendingQuestion | undefined = item.request;
  const items = round?.items ?? [];
  const verb = questionWords(item.answer !== null, waiting, Math.max(items.length, 1), round?.title, parentOf(item.to));
  const icon = <StepIcon icon={QuestionMarkCircle} />;
  if (item.answer === null) return <Line>{icon}<Words verb={verb} live={waiting} /></Line>;
  const answers = item.answers;
  const pairs = items.length > 0 ? items.map((each, at) => ({ text: each.text, given: answerWords(each, answers ? (answers[at] ?? null) : at === 0 ? item.answer : null) })) : [{ text: item.question, given: item.answer }];
  return (
    <Opening
      keep={item.id}
      label={verb}
      detail={
        <View style={{ gap: space(3), paddingTop: space(2), paddingBottom: space(1) }}>
          {pairs.map((pair, at) => (
            <View key={at} style={{ gap: space(1) }}>
              <Text style={s.row} selectable>{pair.text}</Text>
              <Text style={[s.row, { color: color.liveTextQuiet }]} selectable>{pair.given}</Text>
              <Files files={item.files?.[at]} />
            </View>
          ))}
        </View>
      }
    >
      {icon}
      <Words verb={verb} />
    </Opening>
  );
}

/** An answer's files by name; the desktop's tiles open them, which the phone's thread doesn't. */
function Files({ files }: { files?: SentFile[] | null }) {
  const shown = files?.filter((file) => !file.pasted) ?? [];
  return shown.length ? <Text style={s.small}>{shown.map((file) => file.name).join(", ")}</Text> : null;
}

const st = StyleSheet.create({
  code: { fontFamily: mono, backgroundColor: color.muted, borderRadius: radius.control },
  box: { marginHorizontal: space(3), borderRadius: radius.control, backgroundColor: color.codeSurface, paddingHorizontal: space(3), paddingVertical: space(2) },
  expand: { alignSelf: "flex-end", borderRadius: radius.iconButton, paddingHorizontal: space(2), paddingVertical: space(0.5) },
  expandText: { ...text.code, lineHeight: space(4.5), color: color.toolbarForeground },
  files: { borderRadius: radius.iconButton, borderWidth: 1, borderColor: color.border, backgroundColor: color.fileList },
  file: { flexDirection: "row", alignItems: "center", gap: space(2.5), padding: space(1.5) },
  path: { ...text.sm, fontWeight: fontWeight.medium, color: color.foreground, flex: 1 },
  note: { ...text.sm, paddingHorizontal: space(4), color: color.cardNote },
});
