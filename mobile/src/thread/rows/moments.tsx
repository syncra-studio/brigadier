// Sessions started and forked, images, mockups, Overnight and messages to other sessions, after the desktop's
// components/thread/{started,forked-from,image}.tsx, session/{side,fork}.tsx, mockup/{live,row}.tsx,
// sessions/overnight-row.tsx and peers/{live,rows}.tsx.
import { type ReactNode, useSyncExternalStore } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { exchangeWords, HOPS_STOPPED, peerExchange, peerOf, RATE_STOPPED, sessionSendWords, UNSURE } from "../../../../app/shared/peers";
import { type Item, MORNING_WORDS } from "../../../../app/shared/thread";
import { duration, FORKED_FROM, forkedAfter, forkedSource, hhmm, IMAGE_WORDS, type MockupMoment, mockupName, mockupWords, STARTED_STATUS, startedStatus, startedWords, startError, startFailed, tooBigToCopy } from "../../../../app/shared/words";
import { BranchAlt, Chat, Check, Clock, ImageSquare, Moon, Shuffle, Sun, XCircleFilled } from "../../../../app/ui/src/icons";
import { lists } from "../../mac/mac";
import { color, fontWeight, radius, space, spacing, text } from "../../theme";
import { ThreadImage } from "../Image";
import { Markdown } from "../Markdown";
import { Divider, ErrorLine, Glyph, Line, Live, Opening, s } from "./parts";

const rowsNow = () => lists.get().rows;
const useRows = () => useSyncExternalStore(lists.subscribe, rowsNow);

/**
 * A session this one's message started [D204, D206]: "Starting a new session", then "Started a new session from
 * main · Add a retry · Working", or "Couldn’t start the session · …". Open and Put back are the Mac's.
 */
export function StartedLine({ item }: { item: Extract<Item, { kind: "started" }> }) {
  const row = useRows().find((each) => each.id === item.session);
  if (item.state === "failed") return <ErrorLine error={startFailed(item.title ?? "", startError(item))} />;
  const title = row?.title || item.title || "";
  const words = startedWords(item.state === "starting", item.base);
  // A deleted session shows no status [D204].
  const status = item.state === "started" && row ? startedStatus(row) : undefined;
  // A no-break space before each dot, so a wrapped line never starts at one.
  const line = title ? `${words} · ${title}` : words;
  if (item.state === "starting") return <Divider live>{line}</Divider>;
  return (
    <Divider>
      {line}
      {status && (
        <>
          {" · "}
          <Text style={status === "working" ? { color: color.liveText } : undefined}>{STARTED_STATUS[status]}</Text>
        </>
      )}
    </Divider>
  );
}

/** The quiet line where a fork starts: "Forked from ‹source› · works in a new worktree"; a gone source reads "another session" [D48]. */
export function ForkedLine({ item }: { item: Extract<Item, { kind: "forked" }> }) {
  const source = useRows().find((each) => each.id === item.source);
  return (
    <View>
      <Line>
        <View style={s.glyphSm}><BranchAlt className="size-icon-sm shrink-0 text-row-foreground" /></View>
        <Text style={[s.row, s.shrink]} numberOfLines={1}>
          {FORKED_FROM} {source ? <Text style={{ color: color.foreground }}>{source.title}</Text> : forkedSource(item.where === null)}
          {forkedAfter(item.where, item.summary)}
        </Text>
      </Line>
      {/* The desktop's ⓘ: the phone has no hover, so its words show under the line. */}
      {item.leftOut.length > 0 && <Text style={[s.small, { paddingLeft: space(5.5) }]}>{tooBigToCopy(item.leftOut)}</Text>}
    </View>
  );
}

/** An image the agent makes [D289]: "Creating image" over a square while it's made, then the picture in its place. */
export function ImageRow({ item }: { item: Extract<Item, { kind: "image" }> }) {
  if (item.progress === "failed") return <ErrorLine error={item.error === "usageLimitExceeded" ? IMAGE_WORDS.limit : IMAGE_WORDS.failed} />;
  if (item.progress !== "done") {
    return (
      <View style={{ gap: space(2) }}>
        <Live style={text.sm}>{IMAGE_WORDS.making}</Live>
        <View accessibilityRole="image" accessibilityLabel={IMAGE_WORDS.making} style={st.picture} />
      </View>
    );
  }
  if (!item.attachment || !item.name) return <Text style={[text.sm, { color: color.mutedForeground }]}>{IMAGE_WORDS.missing}</Text>;
  return <ThreadImage attachment={item.attachment} label={item.prompt ?? "Image"} style={st.picture} />;
}

/**
 * The lead's row for its mockup worker's mockup [D2055, D560]: "Mockup · drawing 3 variants", "Mockup · round 1
 * ready", "You → mockup · 3 notes on A and B · round 2 drawing". Its live read, title and Open are the Mac's.
 */
export function MockupRow({ item }: { item: Extract<Item, { kind: "mockup" }> }) {
  const moment: MockupMoment = item.round
    ? { kind: "notes", count: item.count, on: item.on ?? [], round: item.round }
    : item.ready
      ? { kind: "ready", round: item.ready, open: false }
      : { kind: "drawing", count: item.count };
  const [lead, rest] = mockupWords(moment, mockupName());
  return (
    <Line>
      <View style={s.glyphSm}><ImageSquare className="size-icon-sm shrink-0 text-row-foreground" /></View>
      <Text style={[s.row, { color: color.foreground, fontWeight: fontWeight.medium }]}>{lead}</Text>
      <Text style={[s.row, s.shrink]} numberOfLines={1}>· {rest}</Text>
    </Line>
  );
}

type Overnight = Extract<Item, { kind: "overnight" }>;
type Report = Extract<Overnight, { moment: "report" }>;

/** A report part's icon, as the desktop's overnight-row: 2 down, a medium icon. */
const MARK = "size-icon-md shrink-0";

/** Overnight's moments in the thread: its start, and the morning's report. */
export function OvernightRow({ item }: { item: Overnight }) {
  return item.moment === "started" ? <Divider icon={Moon}>Overnight since {hhmm(item.at)}</Divider> : <Morning item={item} />;
}

/** A part of the card: its mark, its words, opening to its proof; what can be done about it is the Mac's, said quietly. */
function Part({ mark, title, line, more, after, keep }: { mark: ReactNode; title: string; line?: string; more?: string | null; after?: string | null; keep: string }) {
  const body = (
    <>
      <View style={st.mark}>{mark}</View>
      <View style={st.rowText}>
        <Text style={[text.label, { fontWeight: fontWeight.medium, color: color.foreground }]}>{title}</Text>
        {line ? <Text style={[text.xs, { color: color.quietForeground }]}>{line}</Text> : null}
        {after ? <Text style={[text.xs, { color: color.rowObject }]}>{after}</Text> : null}
      </View>
    </>
  );
  if (!more) return <View style={st.part}>{body}</View>;
  return (
    <Opening keep={keep} label={title} detail={<View style={st.more}><Markdown text={more} style={{ ...text.label, color: color.mutedForeground }} /></View>}>
      <View style={[st.part, st.grow]}>{body}</View>
    </Opening>
  );
}

/** Rows with a hairline between them, inset 16, as the desktop's settings-rows. */
const Rows = ({ children }: { children: ReactNode[] }) => (
  <>
    {children.map((child, at) => (
      <View key={at}>
        {child}
        {at < children.length - 1 && <View style={st.rule} />}
      </View>
    ))}
  </>
);

/** A list of the card. */
function List({ title, count, children }: { title: string; count: number; children: ReactNode[] }) {
  return (
    <View>
      <Text style={[text.label, { color: color.mutedForeground, paddingHorizontal: space(4), paddingTop: space(3), paddingBottom: space(2) }]}>{title} {count}</Text>
      <Rows>{children}</Rows>
    </View>
  );
}

/** The morning: what is done and how it's known, what isn't, and each decision taken for the user. Review changes is the Mac's. */
function Morning({ item }: { item: Report }) {
  const sections = [
    item.done.length > 0 && (
      <List key="done" title={MORNING_WORDS.done} count={item.done.length}>
        {item.done.map((each, at) => <Part key={at} keep={`${item.id}:done:${at}`} mark={<Check className={`${MARK} text-success`} />} title={each.title} line={each.proof} more={each.more} />)}
      </List>
    ),
    item.left.length > 0 && (
      <List key="left" title={MORNING_WORDS.left} count={item.left.length}>
        {item.left.map((each, at) => <Part key={at} keep={`${item.id}:left:${at}`} mark={<XCircleFilled className={`${MARK} text-warning`} />} title={each.title} line={each.why} after={each.next} />)}
      </List>
    ),
    item.decided.length > 0 && (
      <List key="decided" title={MORNING_WORDS.decided} count={item.decided.length}>
        {item.decided.map((each, at) => <Part key={at} keep={`${item.id}:decided:${at}`} mark={<Shuffle className={`${MARK} text-muted-foreground`} />} title={each.title} line={each.why} after={each.other} />)}
      </List>
    ),
  ].filter(Boolean);
  return (
    <View>
      <Divider icon={Sun}>{item.back === false ? "Ended" : "Back"} at {hhmm(item.at)}, after {duration(item.ms)}</Divider>
      <View style={st.card}>
        <View style={st.head}>
          <View style={{ gap: space(1) }}>
            <Text style={[text["2xl"], { color: color.foreground }]} accessibilityRole="header">Good morning</Text>
            <Text style={[text.sm, { color: color.timelineTitle }]}>{item.summary}</Text>
          </View>
          <View style={st.facts}>
            {item.url ? (
              <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(item.url!)} style={st.try}>
                <Text style={[text.sm, { fontWeight: fontWeight.medium, color: color.foreground }]}>Try it</Text>
              </Pressable>
            ) : null}
            <Text style={[text.xs, { color: color.mutedForeground }]}>{item.facts.join(" · ")}</Text>
          </View>
        </View>
        {sections.length > 0 && <View style={st.rule} />}
        <Rows>{sections}</Rows>
      </View>
    </View>
  );
}

type Peer = Extract<Item, { kind: "peer" }>;

/**
 * A message this session's agent sent another [D2034, D3014]: "Messaged Docs: …", or with a wait "Sent message to
 * Docs, waited for its reply", opening to the whole message. Send anyway, and opening a session by its name, are the Mac's.
 */
export function PeerRow({ item }: { item: Peer }) {
  const to = peerOf(item.to, useRows());
  if (item.state === "stopped") {
    return <Line><Glyph><Chat className="size-4 shrink-0 text-row-foreground" /></Glyph><Text style={[s.row, s.shrink]} numberOfLines={1}>{item.why === "rate" ? RATE_STOPPED : HOPS_STOPPED}</Text></Line>;
  }
  let head: ReactNode;
  let why: string | undefined;
  if (!item.wait || item.state === "refused") {
    const state = item.state === "dropped" ? "refused" : item.state;
    why = item.why ?? (state === "uncertain" ? UNSURE : undefined);
    const sent = state === "sent" && item.text;
    head = (
      <>
        <Glyph><Chat className="size-4 shrink-0 text-row-foreground" /></Glyph>
        <Text style={[s.row, s.shrink]} numberOfLines={1}>
          <Text style={state === "sending" ? { color: color.liveText } : undefined}>{sessionSendWords(state)}</Text>
          <Text style={s.object}>{to.title}</Text>
          {sent ? ": " : null}
          {sent ? <Text style={s.object}>{item.text.split("\n", 1)[0]}</Text> : null}
        </Text>
      </>
    );
  } else {
    const exchange = peerExchange(item, to);
    const { parts, status, waiting } = exchangeWords(exchange);
    const Icon = waiting ? Clock : Chat;
    const reasons = exchange.sends.flatMap((send) => (send.state.type === "refused" || send.state.type === "dropped" ? [send.state.reason] : []));
    why = reasons.length > 0 ? reasons.join("\n") : undefined;
    head = (
      <>
        <Glyph><Icon className="size-4 shrink-0 text-row-foreground" /></Glyph>
        <Text style={[s.row, s.shrink]} numberOfLines={1}>
          {parts.map((part, at) => (typeof part === "string" ? <Text key={at} style={status === "inProgress" ? { color: color.liveText } : undefined}>{part}</Text> : <Text key={at} style={s.object}>{part.title}</Text>))}
        </Text>
      </>
    );
  }
  // The desktop's tooltip: the phone has no hover, so why it didn't go shows under the line.
  const reason = why ? <Text style={[s.small, { paddingLeft: space(6) }]}>{why}</Text> : null;
  if (!item.text) return <View><Line>{head}</Line>{reason}</View>;
  return (
    <View>
      <Opening keep={item.id} label={item.text.split("\n", 1)[0]!} detail={<Markdown text={item.text} style={{ ...text.sm, color: color.rowForeground }} />}>
        {head}
      </Opening>
      {reason}
    </View>
  );
}

const st = StyleSheet.create({
  // A made image's place: 400 wide at most, square, as the desktop's max-w-100.
  picture: { width: "100%", maxWidth: space(100), aspectRatio: 1, borderRadius: radius.image, backgroundColor: color.fill },
  card: { marginTop: space(5), borderRadius: radius.overlay, backgroundColor: color.card, borderWidth: 1, borderColor: color.divider, overflow: "hidden" },
  head: { gap: space(3), paddingHorizontal: space(4), paddingTop: space(6), paddingBottom: space(5) },
  facts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: space(2) },
  try: { height: spacing.controlSm, justifyContent: "center", borderRadius: radius.capsule, backgroundColor: color.fill, paddingHorizontal: space(2.5) },
  // settings-rows: a hairline under each but the last.
  rule: { height: 1, marginHorizontal: space(4), backgroundColor: color.divider },
  part: { flexDirection: "row", alignItems: "flex-start", gap: space(3), paddingHorizontal: space(4), paddingVertical: space(3) },
  mark: { marginTop: space(0.5) },
  rowText: { flex: 1, gap: space(1) },
  more: { paddingLeft: space(11), paddingRight: space(4), paddingBottom: space(3) },
  grow: { flex: 1 },
});
