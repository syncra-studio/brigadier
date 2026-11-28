// Notices, lines across the thread, compaction and the limit's switch, after the desktop's components/thread/{body,cards,line}.tsx and accounts/limit.tsx.
import type { ComponentType } from "react";
import { useSyncExternalStore } from "react";
import { Text, View } from "react-native";
import type { Item, Progress } from "../../../../app/shared/thread";
import { COMPACTION, FAILED_CAUSE, lineWords, NOTICE_WORDS, switchWords, TURN_FAILED } from "../../../../app/shared/words";
import { ArrowRotateCw, ExclamationMarkCircle, type IconProps, Info, PauseCircle, Plug, ShieldExclamation, Sparkle, Stop, TextShorterConcise, Warning } from "../../../../app/ui/src/icons";
import { lists, thread } from "../../mac/mac";
import { color, space } from "../../theme";
import { Divider, ErrorState, Glyph, s } from "./parts";

/** Something the app or agent wants seen after its icon, the desktop's NoticeRow; an error in red, announced as it comes [D120]. */
function NoticeRow({ level, text }: { level: "info" | "warning" | "error"; text: string }) {
  const error = level === "error";
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: space(2) }} accessibilityRole={error ? "alert" : undefined}>
      <Glyph>{error ? <ExclamationMarkCircle className="size-4 text-destructive" /> : level === "warning" ? <Warning className="size-4 text-warning" /> : <Info className="size-4 text-row-foreground" />}</Glyph>
      <Text style={[s.row, s.shrink, error && { color: color.destructive }]}>{text}</Text>
    </View>
  );
}

/** A notice; its Retry, Sign in and Open Providers are the Mac's. */
export function NoticeItem({ item }: { item: Extract<Item, { kind: "notice" }> }) {
  if (!("reason" in item)) return <NoticeRow level={item.level} text={item.text} />;
  switch (item.reason) {
    case "blocked":
      return <Divider icon={ShieldExclamation} tip={item.text || undefined} inline>{NOTICE_WORDS.blocked}</Divider>;
    case "failed":
      // Brigadier carried it on once the network was back: a quiet line, the error's words its tip [D339].
      if (item.resumed) return <Divider icon={ArrowRotateCw} tip={item.text || undefined}>{NOTICE_WORDS.resumed}</Divider>;
      return <ErrorState summary={item.cause ? FAILED_CAUSE[item.cause] : TURN_FAILED[item.why]} details={item.text} />;
    case "untrusted":
      return <NoticeRow level="info" text={NOTICE_WORDS.untrusted} />;
    case "sign-in":
      // A library server's is a quiet line; an agent's is an error.
      return item.plugin ? <Divider icon={Plug}>{item.text}</Divider> : <NoticeRow level="error" text={item.text} />;
  }
}

/** The agent shortening its context, as a divider across the column; one not yet started reads as under way (D186). */
export function Compaction({ progress: reported = "done" }: { progress?: Progress }) {
  const progress = reported === "pending" ? "running" : reported;
  return <Divider icon={TextShorterConcise} iconGap={space(3)} live={progress === "running"}>{COMPACTION[progress]}</Divider>;
}

type LineItem = Extract<Item, { kind: "line" }>;

const ICONS: Record<LineItem["reason"], ComponentType<IconProps>> = {
  "limit-reset": ArrowRotateCw,
  model: Sparkle,
  stopped: Stop,
  paused: PauseCircle,
  interrupted: Stop,
  "review-ended": ShieldExclamation,
  stalled: Stop,
  retried: ArrowRotateCw,
};

const rowsNow = () => lists.get().rows;

/** Rust's `line` row in words: what changed, and the rest on its ⓘ; a session that stopped it by its title. Continue is the Mac's. */
export function ChangeLine({ item }: { item: LineItem }) {
  const rows = useSyncExternalStore(lists.subscribe, rowsNow);
  const lead = item.reason === "stopped" && item.by === "lead" ? rows.find((row) => row.id === item.from) : undefined;
  const { words, tip } = lineWords(item, lead ? lead.title : null);
  return <Divider icon={ICONS[item.reason]} tip={tip} live={item.reason === "model" && item.why === "changed" && item.live === true}>{words}</Divider>;
}

type Switch = Extract<Item, { kind: "switch" }>;

/**
 * A usage limit, or a refused resume, and the switch past it: one divider whose state Rust changes in place [D51,
 * D132]. Its one-click switch and Try again are the Mac's; the words are its.
 */
export function SwitchRow({ item: change }: { item: Switch }) {
  const rows = useSyncExternalStore(lists.subscribe, rowsNow);
  const open = useSyncExternalStore(thread.subscribe, () => thread.get()?.id);
  // At its limit, or past an automatic switch that couldn't happen: its carry-on at the reset, as the session's row says.
  const live = change.state === "limit" || change.state === "failed";
  const carries = live ? rows.find((row) => row.id === open)?.reset : null;
  const from = change.from || change.backend || (change.reason === "unresumable" ? "The agent" : "this account");
  const { status, words = "", tip } = switchWords(change, change.state, from, carries);
  if (status !== undefined) return <Divider icon={Warning} iconGap={space(1.5)} tip={tip || undefined}>{words ? `${status} ${words}` : status}</Divider>;
  return <Divider tip={tip || undefined} live={change.state === "switching"}>{words}</Divider>;
}
