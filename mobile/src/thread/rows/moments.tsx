// Sessions started and forked, images, mockups, Overnight and messages to other sessions, after the desktop's
// components/thread/{started,forked-from,image}.tsx, session/{side,fork}.tsx, mockup/{live,row}.tsx,
// sessions/overnight-row.tsx and peers/{live,rows,words}.ts(x).
import type { ReactNode } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import type { Item } from "../../../vendor/brigadier-shared/thread";
import { duration, hhmm } from "../../../vendor/brigadier-shared/words";
import { color, text } from "../../theme";
import { Markdown } from "../Markdown";
import { Divider, ErrorLine, Glyph, Line, Opening, s, Words } from "./parts";

// shortcut: the phone has no session rows here, so a session these rows name reads as the desktop's gone one.
const UNKNOWN_SESSION = "a session";

/**
 * A session this one's message started [D204, D206]: "Starting a new session", then "Started a new session from
 * main · Add a retry", or "Couldn’t start the session · …". Its live status, Open and Put back are the Mac's.
 */
export function StartedLine({ item }: { item: Extract<Item, { kind: "started" }> }) {
  const title = item.title ?? "";
  if (item.state === "failed") {
    const left = item.left?.length ? ` · left behind: ${item.left.join(", ")}` : "";
    return <ErrorLine error={`Couldn’t start the session · ${title ? `${title} · ` : ""}${item.error ?? "Refused"}${left}`} />;
  }
  const words = item.state === "starting" ? "Starting a new session" : item.base ? `Started a new session from ${item.base}` : "Started a new session";
  // A no-break space before each dot, so a wrapped line never starts at one.
  return <Divider>{title ? `${words} · ${title}` : words}</Divider>;
}

/** The quiet line where a fork starts: "Forked from another session · works in a new worktree" [D48]. */
export function ForkedLine({ item }: { item: Extract<Item, { kind: "forked" }> }) {
  const words = `Forked from another ${item.where === null ? "chat" : "session"}${item.where === "worktree" ? " · works in a new worktree" : ""}${item.summary ? " · started from a summary" : ""}`;
  return (
    <View>
      <Line><Glyph g="⑂" /><Words verb={words} /></Line>
      {item.leftOut.length > 0 && <Text style={[s.small, { paddingLeft: 24 }]}>Too big to copy: {item.leftOut.join(", ")}</Text>}
    </View>
  );
}

/** An image the agent makes [D289]: "Creating image" over a square while it's made, then the picture in its place. */
export function ImageRow({ item }: { item: Extract<Item, { kind: "image" }> }) {
  if (item.progress === "failed") return <ErrorLine error={item.error === "usageLimitExceeded" ? "Couldn't create the image: its usage limit was reached." : "Couldn't create the image."} />;
  const making = item.progress !== "done";
  const named = item.name || item.prompt;
  // shortcut: no image bytes until the attachment read lands (P3c)
  return (
    <View style={{ gap: 8 }}>
      {making && <Text style={[s.row, { color: color.foreground }]}>Creating image</Text>}
      {named ? <Text style={s.small}>{named}</Text> : null}
      <View accessibilityRole="image" accessibilityLabel={making ? "Creating image" : (item.prompt ?? item.name ?? "Image")} style={st.picture} />
    </View>
  );
}

/** "Plan card mockup", so a chat's several are told apart; "Mockup" till its title is read. */
const notes = (n: number) => (n === 1 ? "1 note" : `${n} notes`);
const listed = (names: string[]) => (names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`);

/**
 * The lead's row for its mockup worker's mockup [D2055, D560]: "Mockup · drawing 3 variants", "Mockup · round 1
 * ready", "You → mockup · 3 notes on A and B · round 2 drawing". Its live read and Open are the Mac's.
 */
export function MockupRow({ item }: { item: Extract<Item, { kind: "mockup" }> }) {
  const name = "Mockup";
  const [lead, rest] = item.round
    ? [`You → mockup`, `${notes(item.count)} on ${listed(item.on ?? [])} · round ${item.round} drawing`]
    : item.ready
      ? [name, `round ${item.ready} ready`]
      : [name, item.count === 1 ? "drawing 1 variant" : `drawing ${item.count} variants`];
  return (
    <Line>
      <Glyph g="▣" />
      <Text style={[s.row, s.shrink]}><Text style={{ color: color.foreground, fontWeight: "500" }}>{lead}</Text> · {rest}</Text>
    </Line>
  );
}

type Overnight = Extract<Item, { kind: "overnight" }>;
type Report = Extract<Overnight, { moment: "report" }>;

/** Overnight's moments in the thread: its start, and the morning's report. */
export function OvernightRow({ item }: { item: Overnight }) {
  return item.moment === "started" ? <Divider>☾ Overnight since {hhmm(item.at)}</Divider> : <Morning item={item} />;
}

/** A part of the report: its mark, its words, opening to its proof; what can be done about it is the Mac's, said quietly. */
function Part({ mark, tone, title, line, more, after, keep }: { mark: string; tone: string; title: string; line?: string; more?: string | null; after?: string | null; keep: string }) {
  const body = (
    <>
      <Text style={[st.mark, { color: tone }]}>{mark}</Text>
      <View style={st.grow}>
        <Text style={[text.sm, { color: color.foreground }]}>{title}</Text>
        {line ? <Text style={[text.sm, { color: color.mutedForeground }]}>{line}</Text> : null}
        {after ? <Text style={[s.small, { color: color.rowObject }]}>{after}</Text> : null}
      </View>
    </>
  );
  if (!more) return <View style={st.part}>{body}</View>;
  return (
    <Opening keep={keep} label={title} detail={<View style={{ paddingLeft: 44, paddingRight: 16, paddingBottom: 12 }}><Markdown text={more} style={{ ...text.sm, color: color.mutedForeground }} /></View>}>
      <View style={[st.part, st.grow]}>{body}</View>
    </Opening>
  );
}

function List({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <View style={st.list}>
      <Text style={[s.small, { paddingHorizontal: 16, paddingTop: 12, paddingBottom: 8 }]}>{title} {count}</Text>
      {children}
    </View>
  );
}

/** The morning: what is done and how it's known, what isn't, and each decision taken for the user. Review changes is the Mac's. */
function Morning({ item }: { item: Report }) {
  return (
    <View>
      <Divider>☀ {item.back === false ? "Ended" : "Back"} at {hhmm(item.at)}, after {duration(item.ms)}</Divider>
      <View style={st.card}>
        <View style={{ gap: 12, paddingHorizontal: 16, paddingTop: 24, paddingBottom: 20 }}>
          <View style={{ gap: 4 }}>
            <Text style={[text.pageTitle, { fontSize: 24, color: color.foreground }]} accessibilityRole="header">Good morning</Text>
            <Text style={[text.sm, { color: color.foreground }]}>{item.summary}</Text>
          </View>
          <View style={st.facts}>
            {item.url ? (
              <Pressable accessibilityRole="link" accessibilityLabel="Try it" onPress={() => void Linking.openURL(item.url!)} style={st.try}>
                <Text style={[text.sm, { color: color.foreground }]}>Try it</Text>
              </Pressable>
            ) : null}
            <Text style={s.small}>{item.facts.join(" · ")}</Text>
          </View>
        </View>
        {item.done.length > 0 && (
          <List title="Done, with proof" count={item.done.length}>
            {item.done.map((each, at) => <Part key={at} keep={`${item.id}:done:${at}`} mark="✓" tone={color.success} title={each.title} line={each.proof} more={each.more} />)}
          </List>
        )}
        {item.left.length > 0 && (
          <List title="Not done" count={item.left.length}>
            {item.left.map((each, at) => <Part key={at} keep={`${item.id}:left:${at}`} mark="✕" tone={color.warning} title={each.title} line={each.why} after={each.next} />)}
          </List>
        )}
        {item.decided.length > 0 && (
          <List title="Decided for you" count={item.decided.length}>
            {item.decided.map((each, at) => <Part key={at} keep={`${item.id}:decided:${at}`} mark="⇄" tone={color.mutedForeground} title={each.title} line={each.why} after={each.other} />)}
          </List>
        )}
      </View>
    </View>
  );
}

type Peer = Extract<Item, { kind: "peer" }>;

/** Proposed: why a message reads uncertain. */
const UNSURE = "Its session didn’t confirm it, so it wasn’t sent again.";

const SEND_WORDS = { sending: "Messaging ", sent: "Messaged ", refused: "Couldn’t send message to ", uncertain: "Couldn’t confirm message to " } as const;

/**
 * A message this session's agent sent another [D2034, D3014]: "Messaged a session: …", or with a wait "Sent message
 * to a session, waited for its reply"; opening to the whole message. Send anyway at the hop limit is the Mac's.
 */
export function PeerRow({ item }: { item: Peer }) {
  if (item.state === "stopped") return <Line><Glyph g="✉" /><Words verb={item.why === "rate" ? "Stopped at 20 messages a minute" : "Stopped after 8 hops"} /></Line>;
  let words: string;
  let why: string | null = null;
  let live = false;
  if (!item.wait || item.state === "refused") {
    const state = item.state === "dropped" ? "refused" : item.state;
    words = `${SEND_WORDS[state]}${UNKNOWN_SESSION}${state === "sent" && item.text ? `: ${item.text.split("\n", 1)[0]}` : ""}`;
    why = item.why ?? (state === "uncertain" ? UNSURE : null);
    live = state === "sending";
  } else if (item.state === "sending") {
    words = `Sending message to ${UNKNOWN_SESSION}`;
    live = true;
  } else if (item.waited === undefined) {
    words = `Waiting for ${UNKNOWN_SESSION} to reply`;
    live = true;
  } else {
    // One send, then how its wait went: "Sent message to a session, waited for its reply".
    const failed = item.state === "dropped" || item.state === "uncertain";
    const sent = failed ? `Couldn’t send message to ${UNKNOWN_SESSION}` : `Sent message to ${UNKNOWN_SESSION}`;
    const waited = item.waited === "replied" ? "waited for its reply" : "waited; no reply yet";
    words = `${sent}, ${waited}`;
    why = failed ? (item.why ?? UNSURE) : null;
  }
  const head = (
    <>
      <Glyph g={live && words.startsWith("Waiting") ? "◷" : "✉"} />
      <Words verb={words} live={live} />
    </>
  );
  const reason = why ? <Text style={[s.small, { paddingLeft: 24 }]}>{why}</Text> : null;
  if (!item.text) return <View><Line>{head}</Line>{reason}</View>;
  return (
    <View>
      <Opening keep={item.id} label={words} detail={<View style={{ paddingLeft: 24 }}><Markdown text={item.text} style={{ ...text.sm, color: color.row }} /></View>}>
        {head}
      </Opening>
      {reason}
    </View>
  );
}

const st = StyleSheet.create({
  picture: { width: "100%", maxWidth: 280, aspectRatio: 1, borderRadius: 12, backgroundColor: color.fill },
  card: { marginTop: 20, borderRadius: 16, backgroundColor: color.surfaceUnder, borderWidth: StyleSheet.hairlineWidth, borderColor: color.border, overflow: "hidden" },
  facts: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 },
  try: { borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, borderColor: color.mutedForeground, paddingHorizontal: 12, paddingVertical: 6 },
  list: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: color.border },
  part: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 12 },
  mark: { width: 16, fontSize: 15, lineHeight: 20, textAlign: "center" },
  grow: { flex: 1 },
});
