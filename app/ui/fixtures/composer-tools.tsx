// Mockup only: the composer's Tools in its / and + menus, picked as chips inline in the text as commands are. Fake
// data, the menus drawn open over the real composer parts. ?v=real is the real thing, live: a session's `/` and +
// menus on fake commands, Send showing the draft Rust would get (no daemon); a chip's click sets the hash its page would. Not the app.
import "../src/theme.css";
import "./fixtures.css";

import { type ReactNode, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { Paperclip } from "../src/icons";
import { cx } from "../src/components/cx";
import { PlusButton, SharedComposer } from "../src/components/composer/composer";
import { CommandRow, ComposerMenu, ComposerMenuOption, KIND_HEADINGS, MenuHeading, MentionRow, type SlashCommand } from "../src/components/composer/menus";
import { ComposerChip } from "../src/components/composer/chip";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import { SendButton } from "../src/components/composer/send-button";
import { useComposerCommands } from "../src/session/commands";
import type { Runner } from "../src/session/composer";
import { TOOL_COMMANDS } from "../src/components/composer/tools";
import { DropdownMenuLabel, itemClasses, menuSurface, MenuRow } from "../src/components/menu";

const COMMANDS: SlashCommand[] = [
  { id: "compact", kind: "command", label: "/compact", description: "Save the context so far", instant: true },
  { id: "review", kind: "command", label: "/review", description: "Review the changes", instant: false },
];
const SKILLS: SlashCommand[] = [
  { id: "docs", kind: "skill", label: "/docs", description: "Write the docs for a change", instant: false },
  { id: "kit", kind: "skill", label: "/kit", description: "Port a component to the kit", instant: false },
];
const CHATS = [
  { id: "c1", type: "chat" as const, label: "Fix the queue's drag order", hint: "2h" },
  { id: "c2", type: "chat" as const, label: "Composer slice 3", hint: "yesterday" },
];

/** The field, as it shows a draft: the composer's own text size and padding. */
const Field = ({ children }: { children: ReactNode }) => <div className="min-h-composer px-2 py-2.5 text-base break-words whitespace-pre-wrap">{children}</div>;

/** The composer as a session mounts it: + and Send in the footer, `menu` drawn open over the card. */
function Composer({ menu, children }: { menu?: ReactNode; children?: ReactNode }) {
  return (
    <SharedComposer
      plus={<PlusButton />}
      send={<SendButton empty={!children} running={false} canStop={false} onSend={() => {}} onStop={() => {}} />}
    >
      {menu}
      <Field>{children ?? <span className="text-placeholder">Do anything</span>}</Field>
    </SharedComposer>
  );
}

/** The + menu, drawn open: the card's width, just above it. */
const PlusPanel = ({ children }: { children: ReactNode }) => (
  <div className={cx(menuSurface, "absolute start-0 bottom-full mb-1 flex max-h-command-list w-full flex-col overflow-y-auto")}>{children}</div>
);
const Item = ({ highlighted, children }: { highlighted?: boolean; children: ReactNode }) => (
  <div className={itemClasses} data-highlighted={highlighted || undefined}>
    {children}
  </div>
);

/** A tool's chip in the text, as picking it leaves it. */
const ToolChip = ({ id }: { id: string }) => <ComposerChip chip={{ kind: "command", id, type: "tool", label: `/${id}` }} />;

const PlusAddRows = () => (
  <>
    <DropdownMenuLabel variant="heading">Add</DropdownMenuLabel>
    <Item>
      <MenuRow icon={<Paperclip />} title="Files" />
    </Item>
  </>
);
const PlusRest = () => (
  <>
    <DropdownMenuLabel variant="heading">{KIND_HEADINGS.skill}</DropdownMenuLabel>
    {SKILLS.map((command) => (
      <Item key={command.id}>
        <CommandRow command={command} query="" />
      </Item>
    ))}
    <DropdownMenuLabel variant="heading">Chats</DropdownMenuLabel>
    {CHATS.map((chat) => (
      <Item key={chat.id}>
        <MentionRow item={chat} query="" />
      </Item>
    ))}
  </>
);

const SlashCommands = ({ list }: { list: SlashCommand[] }) =>
  list.map((command) => (
    <ComposerMenuOption key={command.id} selected={false}>
      <CommandRow command={command} query="" />
    </ComposerMenuOption>
  ));

/** A tool is a chip in the text, picked or typed as `/browser`; taking the chip out drops it. */
function VariantC() {
  return {
    slash: (
      <ComposerMenu label="Commands">
        <MenuHeading>{KIND_HEADINGS.command}</MenuHeading>
        <SlashCommands list={COMMANDS} />
        <MenuHeading>{KIND_HEADINGS.tool}</MenuHeading>
        {TOOL_COMMANDS.map((each) => (
          <ComposerMenuOption key={each.id} selected={each.id === "computer"}>
            <CommandRow command={each} query="" />
          </ComposerMenuOption>
        ))}
        <MenuHeading>{KIND_HEADINGS.skill}</MenuHeading>
        <SlashCommands list={SKILLS} />
      </ComposerMenu>
    ),
    plus: (
      <PlusPanel>
        <PlusAddRows />
        <DropdownMenuLabel variant="heading">{KIND_HEADINGS.tool}</DropdownMenuLabel>
        {TOOL_COMMANDS.map((each) => (
          <Item key={each.id} highlighted={each.id === "image"}>
            <CommandRow command={each} query="" />
          </Item>
        ))}
        <PlusRest />
      </PlusPanel>
    ),
    picked: (
      <Composer>
        Check the signup flow on staging with <ToolChip id="browser" /> and split the three forms <ToolChip id="workers" />{" "}
      </Composer>
    ),
  };
}


function Stage({ title, tall = false, children }: { title: string; tall?: boolean; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="mx-auto w-full max-w-reading px-4 text-label text-muted-foreground">{title}</h2>
      <div className={cx("flex flex-col justify-end", tall && "mockup-stage")}>{children}</div>
    </section>
  );
}

const OWNER = "s-fixture";
/** Rust's stand-in for the agent's `/` list. */
const run: Runner = async (args) =>
  args[0] === "commands"
    ? {
        ok: true,
        commands: [
          ...[...COMMANDS, ...SKILLS].map((each) => ({ name: each.label.slice(1), kind: each.kind, description: each.description, instant: each.instant })),
          { name: "Steady", kind: "mcp", description: "Standups and check-ins", instant: false },
          { name: "mcp__b-Steady__standup", kind: "prompt", description: "Write today's standup", instant: false },
        ],
      }
    : { ok: false, error: "disconnected" };

/** The session's own menus, as session/composer.tsx mounts them; Send shows the parts it would hand Rust. */
function Real() {
  const field = useRef<ComposerFieldHandle>(null);
  const [sent, setSent] = useState<string | null>(null);
  const { commands, plus, onOpen } = useComposerCommands({ owner: OWNER, run, field, onFiles: () => {} });
  const send = () => {
    setSent(JSON.stringify(field.current?.parts() ?? [], null, 1));
    field.current?.set([]);
  };
  return (
    <main className="flex min-h-screen flex-col justify-end py-8">
      {sent && <pre className="mx-auto w-full max-w-reading px-4 text-xs whitespace-pre-wrap text-muted-foreground">{sent}</pre>}
      <SharedComposer plus={plus} send={<SendButton empty={false} running={false} canStop={false} onSend={send} onStop={() => {}} />}>
        <ComposerField ref={field} placeholder="Do anything" commands={commands} onOpen={onOpen} onSubmit={send} autoFocus />
      </SharedComposer>
    </main>
  );
}

function Page() {
  if (new URLSearchParams(location.search).get("v") === "real") return <Real />;
  const { slash, plus, picked } = VariantC();
  return (
    <main className="flex flex-col gap-10 py-8">
      <Stage title="Typing / in the field" tall>
        <Composer menu={slash}>/</Composer>
      </Stage>
      <Stage title="Clicking +" tall>
        <Composer menu={plus} />
      </Stage>
      <Stage title="Two tools picked">{picked}</Stage>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
