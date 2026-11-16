import type { ReactNode } from "react";

import { Badge } from "../components/badge";
import { CopyButton } from "../components/copy-button";
import { Chat } from "../icons";

/**
 * A reply's card [D477]: a fenced `brigadier-message` block holds JSON that Brigadier draws as its own card. JSON that
 * doesn't parse or doesn't fit draws nothing here, so the fence stays a code block. Questions go to the question card
 * through the agent's question tool, never a reply card [D484].
 */
type Message = { to: string; state?: string; text: string; quote?: { from: string; text: string } };

const said = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";
const maybe = (value: unknown) => value === undefined || typeof value === "string";
const isMessage = (m: Record<string, any> | undefined): m is Message =>
  !!m && said(m.to) && said(m.text) && maybe(m.state) && (m.quote === undefined || (said(m.quote?.from) && said(m.quote?.text)));

/** The card a fence draws, or null when it isn't one. */
export function replyCard(language: string, json: string): ReactNode {
  if (language !== "brigadier-message") return null;
  let spec: Record<string, any> | undefined;
  try {
    spec = JSON.parse(json);
  } catch {
    return null;
  }
  return isMessage(spec) ? <MessageCard {...spec} /> : null;
}

const FRAME = "my-3 rounded-thread border border-border bg-code-surface first:mt-0 last:mb-0";

/** A message for someone else: where it goes, whether it went, their words it answers, and copy for the message alone. */
function MessageCard({ to, state = "draft", text, quote }: Message) {
  return (
    <div className={FRAME}>
      <div className="flex h-control-md items-center gap-1.5 ps-3 pe-1.5 text-xs text-muted-foreground">
        <Chat className="size-icon-sm" />
        <span className="font-medium text-foreground">{to}</span>
        <Badge variant={state === "posted" ? "success" : "secondary"} className="ms-1">
          {state}
        </Badge>
        <CopyButton text={text} tooltip="Copy" copiedTooltip="Copied" size="icon-xs" className="ms-auto" />
      </div>
      {quote && (
        <div className="mx-3 mb-2 border-s-2 border-quote-edge ps-3 text-sm text-muted-foreground">
          <div className="text-xs font-medium">{quote.from} wrote</div>
          <div className="whitespace-pre-wrap">{quote.text}</div>
        </div>
      )}
      <div className="px-3 pb-3 leading-relaxed break-words whitespace-pre-wrap">{text}</div>
    </div>
  );
}
