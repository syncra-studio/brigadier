// Notices, lines across the thread, compaction and the limit's switch, after the desktop's components/thread/{body,cards,line}.tsx.
import { Text } from "react-native";
import type { Item, Progress } from "../../../../app/shared/thread";
import { COMPACTION, duration, FAILED_CAUSE, hhmm, TURN_FAILED } from "../../../../app/shared/words";
import { ArrowRotateCw, ExclamationMarkCircle, Info, PauseCircle, Plug, ShieldExclamation, Sparkle, Stop, TextShorterConcise, Warning } from "../../../../app/ui/src/icons";
import { color } from "../../theme";
import { Divider, ErrorState, s } from "./parts";

/** Something the app or agent wants seen, after its mark; an error in red, announced as it comes [D120]. */
function NoticeRow({ level, text }: { level: "info" | "warning" | "error"; text: string }) {
  const error = level === "error";
  return (
    <Text style={[s.row, error && { color: color.destructive }]} accessibilityRole={error ? "alert" : undefined}>
      {error ? <ExclamationMarkCircle className="size-4 text-destructive" /> : level === "warning" ? <Warning className="size-4 text-warning" /> : <Info className="size-4 text-row-foreground" />}
      {"  "}
      {text}
    </Text>
  );
}

export function NoticeItem({ item }: { item: Extract<Item, { kind: "notice" }> }) {
  if (!("reason" in item)) return <NoticeRow level={item.level} text={item.text} />;
  switch (item.reason) {
    case "blocked":
      return <Divider icon={ShieldExclamation} tip={item.text || undefined}>The agent’s safety checks held this reply back</Divider>;
    case "failed":
      // Brigadier carried it on once the network was back: a quiet line, the error's words its tip [D339].
      if (item.resumed) return <Divider icon={ArrowRotateCw} tip={item.text || undefined}>Connection lost · tried again once it was back</Divider>;
      return <ErrorState summary={item.cause ? FAILED_CAUSE[item.cause] : TURN_FAILED[item.why]} details={item.text} />;
    case "untrusted":
      return <NoticeRow level="info" text="This folder is no longer trusted, so this turn runs under Ask." />;
    case "sign-in":
      // A library server's is a quiet line; an agent's is an error. Their Sign in and Open Providers are the Mac's.
      return item.plugin ? <Divider icon={Plug}>{item.text}</Divider> : <NoticeRow level="error" text={item.text} />;
  }
}

/** The agent shortening its context, as a divider across the column; one not yet started reads as under way (D186). */
export function Compaction({ progress: reported = "done" }: { progress?: Progress }) {
  const progress = reported === "pending" ? "running" : reported;
  return <Divider icon={TextShorterConcise}>{COMPACTION[progress]}</Divider>;
}

/** Rust's `line` row in words: what changed, and the rest on its ⓘ. */
export function ChangeLine({ item }: { item: Extract<Item, { kind: "line" }> }) {
  switch (item.reason) {
    case "limit-reset":
      return <Divider icon={ArrowRotateCw}>Usage limit reset · {item.carried ? `carried on at ${hhmm(item.carried)}` : hhmm(item.at)}</Divider>;
    case "model":
      return item.why === "changed" ? (
        <Divider icon={Sparkle} tip={`${item.from ? `From ${item.from}. ` : ""}Answers may read differently from here on.`}>{item.live ? `Switching model to ${item.to}…` : `Switched model to ${item.to}`}</Divider>
      ) : (
        <Divider icon={Sparkle} tip={item.from ? `The agent sent this request on from ${item.from}.` : "The agent sent this request on to another model."}>This request went to {item.to}</Divider>
      );
    case "stopped":
      // shortcut: the session that stopped it is named from the Mac's rows, which the phone doesn't have: "Stopped".
      if (item.by === "lead") return <Divider icon={Stop}>{item.ms === null ? "Stopped" : `Stopped after ${duration(item.ms)}`}</Divider>;
      return <Divider icon={Stop}>{item.ms === null ? "You stopped" : `You stopped after ${duration(item.ms)}`}</Divider>;
    case "paused":
      return <Divider icon={PauseCircle}>{item.ms === null ? "You paused" : `You paused after ${duration(item.ms)}`}</Divider>;
    case "interrupted":
      return <Divider icon={Stop}>Interrupted · the run stopped before it finished</Divider>;
    case "review-ended":
      return <Divider tip="It turned down too many actions in a row. Say more about the task, or change the permission level, to go on." icon={ShieldExclamation}>The automatic reviewer ended this turn</Divider>;
    case "stalled":
      // Its Continue is the Mac's.
      return <Divider icon={Stop}>Stopped: this task keeps filling its context without making progress</Divider>;
    case "retried":
      return <Divider icon={ArrowRotateCw}>Sent again · the previous attempt was replaced</Divider>;
  }
}

type Switch = Extract<Item, { kind: "switch" }>;

/**
 * A usage limit, or a refused resume, and the switch past it: one divider whose state Rust changes in place [D51,
 * D132]. Its one-click switch and Try again are the Mac's; the words are its.
 */
export function SwitchRow({ item: change }: { item: Switch }) {
  const from = change.from || change.backend || (change.reason === "unresumable" ? "The agent" : "this account");
  const to = change.model ? `${change.to} · ${change.model}` : (change.to ?? "");
  const refused = change.reason === "unresumable";
  const hit = refused ? `${from} couldn’t resume this conversation` : change.reason === "credits" ? `Out of credits on ${from}` : `Usage limit on ${from}`;
  const back = change.reason !== "usage-limit" ? "" : change.resets && change.resets > Date.now() ? ` · try again at ${hhmm(change.resets)}` : " · try again later";
  switch (change.state) {
    case "limit":
      return <Divider icon={Warning}>{hit + back}</Divider>;
    case "switching":
      return <Divider>{refused ? `Starting a new conversation on ${to}…` : to ? `Switching to ${to}…` : "Switching…"}</Divider>;
    case "switched":
      if (!change.to) return <Divider>{change.text}</Divider>;
      if (change.reason === "picked") return <Divider>Switched to {to}</Divider>;
      if (change.moved) return <Divider tip={hit}>{change.moved}</Divider>;
      return <Divider tip={hit}>{refused ? `Continued in a new conversation on ${to}` : `Switched ${change.automatic ? "automatically " : ""}to ${to}`}</Divider>;
    case "failed":
      if (change.automatic) return <Divider icon={Warning} tip={change.error || undefined}>{hit + back} {to ? `· couldn’t switch to ${to}` : "· couldn’t switch automatically"}</Divider>;
      return <Divider tip={change.error || undefined}>Couldn’t switch to {to} · the thread is unchanged</Divider>;
    case "over":
      return <Divider icon={Warning}>{hit}</Divider>;
  }
}
