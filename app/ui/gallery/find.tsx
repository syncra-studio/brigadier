// Find in the conversation (find.tsx): the bar in each state, frozen, and a live thread to try it on (⌘F, ⌘G).
import type { ComponentProps } from "react";

import { FindBar } from "../src/thread/find-bar";
import type { Item, Session } from "../src/thread/item";
import { Thread, type Source } from "../src/thread/thread";
import { Row, Section, State } from "./parts";

const noop = () => {};
const NOW = Date.now();

function Bar(props: Partial<ComponentProps<typeof FindBar>>) {
  return (
    <div className="relative isolate h-14 w-108 rounded-surface bg-background">
      <FindBar query="" label={null} older={null} none onQuery={noop} onStep={noop} onClose={noop} {...props} />
    </div>
  );
}

const user = (n: number, turnId: string, text: string): Item => ({ id: `m${n}`, n, turnId, kind: "message", role: "user", text, streaming: false, sentAt: NOW });
const answer = (n: number, turnId: string, text: string): Item => ({ id: `m${n}`, n, turnId, kind: "message", role: "assistant", text, streaming: false, final: true, sentAt: NOW });
const tool = (n: number, step: "search" | "read", name: string, input: string): Item => ({ id: `s${n}`, n, turnId: "t1", kind: "tool", step, name, input, output: "", progress: "done", exitCode: 0 });
const SESSION: Session = {
  id: "find",
  title: "",
  turns: [
    { id: "t1", status: "done", startedAt: NOW - 42_000, endedAt: NOW },
    { id: "t2", status: "done", startedAt: NOW - 9_000, endedAt: NOW },
  ],
  items: [
    user(1, "t1", "Where is the socket opened?"),
    { id: "g2", n: 2, turnId: "t1", kind: "group", steps: [{ kind: "search", n: 1 }, { kind: "read", n: 2 }], span: [3, 5] },
    tool(3, "search", "rg", "socket src/net"),
    tool(4, "read", "Read", "src/net/socket.rs"),
    tool(5, "read", "Read", "src/net/listen.rs"),
    answer(6, "t1", "The socket opens in `listen()`:\n\n```rust\nlet socket = TcpListener::bind(addr)?;\nsocket.set_nonblocking(true)?;\n```\n\nEach connection then gets its own socket from `accept()`."),
    user(7, "t2", "And who closes the socket?"),
    answer(8, "t2", "Nothing closes it by hand: the socket closes when it is dropped, at the end of `serve()`."),
  ],
  work: [{ turnId: "t1", ms: 42_000, folded: [2, 5] }],
};
const SOURCE: Source = { subscribe: () => noop, get: () => SESSION };

export function FindGallery() {
  return (
    <Section title="Find in conversation">
      <Row name="Bar">
        <State label="Empty">
          <Bar />
        </State>
        <State label="Matches">
          <Bar query="socket" label="2 / 7 results" none={false} />
        </State>
        <State label="One">
          <Bar query="accept" label="1 / 1 result" none={false} />
        </State>
        <State label="Many">
          <Bar query="e" label="3 / 250+ results" none={false} />
        </State>
        <State label="None">
          <Bar query="websocket" label="0 results" />
        </State>
      </Row>
      <Row name="Older history not counted">
        <State label="Searching">
          <Bar query="socket" label="2 / 7 results" none={false} older="searching" />
        </State>
        <State label="Not searched (offline or error)">
          <Bar query="socket" label="0 results" older="failed" />
        </State>
      </Row>
      <Row name="Live: click in the thread, then ⌘F (try “socket”: two matches sit in the folded work)">
        <div className="h-96 w-full max-w-reading overflow-clip rounded-surface border border-border bg-background">
          <Thread source={SOURCE} />
        </div>
      </Row>
    </Section>
  );
}
