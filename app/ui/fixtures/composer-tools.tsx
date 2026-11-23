// Mockup only: the composer's Tools in its / and + menus, switched on as pills beside + (variant C, the pick). Fake
// data, the menus drawn open over the real composer parts. ?v=real is the real thing, live: a session's `/` and +
// menus and its tool pills on fake commands, the chips kept here only (no daemon). Not the app.
import "../src/theme.css";
import "./fixtures.css";

import { type ReactNode, useRef } from "react";
import { createRoot } from "react-dom/client";

import { Check, Paperclip } from "../src/icons";
import { cx } from "../src/components/cx";
import { PlusButton, SharedComposer } from "../src/components/composer/composer";
import { CommandRow, ComposerMenu, ComposerMenuOption, KIND_HEADINGS, MenuHeading, MentionRow, type SlashCommand } from "../src/components/composer/menus";
import { ComposerField, type ComposerFieldHandle } from "../src/components/composer/field";
import { SendButton } from "../src/components/composer/send-button";
import { useComposerCommands } from "../src/session/commands";
import type { Runner } from "../src/session/composer";
import { toolOf, TOOLS, ToolPill } from "../src/components/composer/tools";
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
function Composer({ menu, children, pills }: { menu?: ReactNode; children?: ReactNode; pills?: ReactNode }) {
  return (
    <SharedComposer
      plus={
        <>
          <PlusButton />
          {pills}
        </>
      }
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

/** A tool's row, as the session's `/` list makes it (session/commands.tsx). */
const ToolRow = ({ id, on }: { id: string; on: boolean }) => {
  const tool = toolOf(id)!;
  return <CommandRow command={{ id, kind: "tool", label: tool.name, description: tool.line, instant: true, hint: on && <Check className="text-foreground" /> }} query="" />;
};

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

/** C: a tool is switched on rather than written: a pill beside +, ✓ in the menus, the text left as typed. */
function VariantC() {
  const on = new Set(["browser", "workers"]);
  return {
    slash: (
      <ComposerMenu label="Commands">
        <MenuHeading>{KIND_HEADINGS.command}</MenuHeading>
        <SlashCommands list={COMMANDS} />
        <MenuHeading>{KIND_HEADINGS.tool}</MenuHeading>
        {TOOLS.map((each) => (
          <ComposerMenuOption key={each.id} selected={each.id === "computer"}>
            <ToolRow id={each.id} on={on.has(each.id)} />
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
        {TOOLS.map((each) => (
          <Item key={each.id} highlighted={each.id === "image"}>
            <ToolRow id={each.id} on={on.has(each.id)} />
          </Item>
        ))}
        <PlusRest />
      </PlusPanel>
    ),
    picked: (
      <Composer
        pills={[...on].map((id) => (
          <ToolPill key={id} id={id} />
        ))}
      >
        Check the signup flow on staging and split the three forms{" "}
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
  args[0] === "commands" ? { ok: true, commands: [...COMMANDS, ...SKILLS].map((each) => ({ name: each.label.slice(1), kind: each.kind, description: each.description, instant: each.instant })) } : { ok: false, error: "disconnected" };

/** The session's own menus and pills, as session/composer.tsx mounts them. */
function Real() {
  const field = useRef<ComposerFieldHandle>(null);
  const { commands, plus } = useComposerCommands({ owner: OWNER, run, field, onFiles: () => {} });
  return (
    <main className="flex min-h-screen flex-col justify-end py-8">
      <SharedComposer
        plus={plus}
        send={<SendButton empty running={false} canStop={false} onSend={() => {}} onStop={() => {}} />}
      >
        <ComposerField ref={field} placeholder="Do anything" commands={commands} autoFocus />
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
