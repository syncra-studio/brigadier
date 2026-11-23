// Mockup only: a "Tools" section in the composer's / and + menus, picked into the message. ?v=a, b or c. Fake data,
// the menus drawn open over the real composer parts. Not the app.
import "../src/theme.css";
import "./fixtures.css";

import type { ComponentType, ReactNode } from "react";
import { createRoot } from "react-dom/client";

import { Check, Desktop, Paperclip, X } from "../src/icons";
import { Globe } from "../src/icons/thread";
import { Grid, ImageSquare, Search } from "../src/icons/tab";
import { TeamGlyph } from "../src/icons/worker-glyphs";
import { cx } from "../src/components/cx";
import { ComposerPill, PlusButton, SharedComposer } from "../src/components/composer/composer";
import { CommandRow, ComposerMenu, ComposerMenuOption, KIND_HEADINGS, MenuHeading, MentionRow, type SlashCommand } from "../src/components/composer/menus";
import { SendButton } from "../src/components/composer/send-button";
import { DropdownMenuLabel, itemClasses, menuSurface, MenuRow } from "../src/components/menu";

type Tool = { id: string; name: string; slash: string; line: string; Icon: ComponentType<{ className?: string }> };

const TOOLS: Tool[] = [
  { id: "computer", name: "Computer use", slash: "/computer-use", line: "Use the apps on your Mac", Icon: Desktop },
  { id: "browser", name: "Browser", slash: "/browser", line: "Open pages, click and type in Brigadier's browser", Icon: Globe },
  { id: "mockup", name: "Mockup", slash: "/mockup", line: "Draw 3 looks to pick from before building", Icon: Grid },
  { id: "image", name: "Image", slash: "/image", line: "Make or edit a picture", Icon: ImageSquare },
  { id: "research", name: "Web research", slash: "/research", line: "Search and read the web, with sources", Icon: Search },
  { id: "workers", name: "Workers", slash: "/workers", line: "Split the job across workers in parallel", Icon: TeamGlyph },
];
const tool = (id: string) => TOOLS.find((each) => each.id === id)!;

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

/** A tool's colour, beside a command's blue, a skill's magenta and an MCP prompt's cyan. */
const TONE = "text-success";

const ToolIcon = ({ id, className }: { id: string; className?: string }) => {
  const { Icon } = tool(id);
  return <Icon className={cx(TONE, className)} />;
};

/** A tool in the text, as a command's chip is: its icon and name in its colour. */
const ToolChip = ({ id, slash }: { id: string; slash?: boolean }) => (
  <span data-slot="composer-chip" className={TONE}>
    <ToolIcon id={id} className="mr-0.5 inline-block size-icon-sm align-icon" />
    {slash ? tool(id).slash : tool(id).name}
  </span>
);

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

const ToolRow = ({ id, slash, end }: { id: string; slash?: boolean; end?: ReactNode }) => (
  <MenuRow icon={<ToolIcon id={id} />} title={slash ? tool(id).slash : tool(id).name} detail={tool(id).line} hint={end} />
);

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

/** A: Tools is one more section, in both menus, after Commands and after Files; a pick is its name as a chip. */
function VariantA() {
  return {
    slash: (
      <ComposerMenu label="Commands">
        <MenuHeading>{KIND_HEADINGS.command}</MenuHeading>
        <SlashCommands list={COMMANDS} />
        <MenuHeading>Tools</MenuHeading>
        {TOOLS.map((each) => (
          <ComposerMenuOption key={each.id} selected={each.id === "browser"}>
            <ToolRow id={each.id} />
          </ComposerMenuOption>
        ))}
        <MenuHeading>{KIND_HEADINGS.skill}</MenuHeading>
        <SlashCommands list={SKILLS} />
      </ComposerMenu>
    ),
    plus: (
      <PlusPanel>
        <PlusAddRows />
        <DropdownMenuLabel variant="heading">Tools</DropdownMenuLabel>
        {TOOLS.map((each) => (
          <Item key={each.id} highlighted={each.id === "workers"}>
            <ToolRow id={each.id} />
          </Item>
        ))}
        <PlusRest />
      </PlusPanel>
    ),
    picked: (
      <Composer>
        Check the signup flow on staging in the <ToolChip id="browser" />, and use <ToolChip id="workers" /> for the three forms{" "}
      </Composer>
    ),
  };
}

/** B: Tools come first, as slash words you can also type (/browser); the + menu opens on a grid of them. */
function VariantB() {
  return {
    slash: (
      <ComposerMenu label="Commands">
        <MenuHeading>Tools</MenuHeading>
        {TOOLS.map((each) => (
          <ComposerMenuOption key={each.id} selected={each.id === "browser"}>
            <ToolRow id={each.id} slash />
          </ComposerMenuOption>
        ))}
        <MenuHeading>{KIND_HEADINGS.command}</MenuHeading>
        <SlashCommands list={COMMANDS} />
        <MenuHeading>{KIND_HEADINGS.skill}</MenuHeading>
        <SlashCommands list={SKILLS} />
      </ComposerMenu>
    ),
    plus: (
      <PlusPanel>
        <DropdownMenuLabel variant="heading">Tools</DropdownMenuLabel>
        <div className="grid grid-cols-3 gap-1 pb-1">
          {TOOLS.map((each) => (
            <div
              key={each.id}
              data-highlighted={each.id === "workers" || undefined}
              className="flex cursor-pointer flex-col items-center gap-1.5 rounded-menu-item py-3 text-label highlighted:bg-fill hover:bg-fill"
            >
              <ToolIcon id={each.id} className="size-icon-lg" />
              {each.name}
            </div>
          ))}
        </div>
        <PlusAddRows />
        <PlusRest />
      </PlusPanel>
    ),
    picked: (
      <Composer>
        Check the signup flow on staging with <ToolChip id="browser" slash /> and split the three forms with <ToolChip id="workers" slash />{" "}
      </Composer>
    ),
  };
}

/** C: a tool is switched on rather than written: a pill beside +, ✓ in the menus, the text left as typed. */
function VariantC() {
  const on = new Set(["browser", "workers"]);
  const check = (id: string) => on.has(id) && <Check className="text-foreground" />;
  return {
    slash: (
      <ComposerMenu label="Commands">
        <MenuHeading>{KIND_HEADINGS.command}</MenuHeading>
        <SlashCommands list={COMMANDS} />
        <MenuHeading>Tools</MenuHeading>
        {TOOLS.map((each) => (
          <ComposerMenuOption key={each.id} selected={each.id === "computer"}>
            <ToolRow id={each.id} end={check(each.id)} />
          </ComposerMenuOption>
        ))}
        <MenuHeading>{KIND_HEADINGS.skill}</MenuHeading>
        <SlashCommands list={SKILLS} />
      </ComposerMenu>
    ),
    plus: (
      <PlusPanel>
        <PlusAddRows />
        <DropdownMenuLabel variant="heading">Tools</DropdownMenuLabel>
        {TOOLS.map((each) => (
          <Item key={each.id} highlighted={each.id === "image"}>
            <ToolRow id={each.id} end={check(each.id)} />
          </Item>
        ))}
        <PlusRest />
      </PlusPanel>
    ),
    picked: (
      <Composer
        pills={[...on].map((id) => (
          <ComposerPill key={id} className="text-foreground">
            <ToolIcon id={id} />
            {tool(id).name}
            <X className="text-muted-foreground" />
          </ComposerPill>
        ))}
      >
        Check the signup flow on staging and split the three forms{" "}
      </Composer>
    ),
  };
}

const VARIANTS = { a: VariantA, b: VariantB, c: VariantC };

function Stage({ title, tall = false, children }: { title: string; tall?: boolean; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="mx-auto w-full max-w-reading px-4 text-label text-muted-foreground">{title}</h2>
      <div className={cx("flex flex-col justify-end", tall && "mockup-stage")}>{children}</div>
    </section>
  );
}

function Page() {
  const key = (new URLSearchParams(location.search).get("v") ?? "a") as keyof typeof VARIANTS;
  const { slash, plus, picked } = (VARIANTS[key] ?? VariantA)();
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
