// D134 proposals: three ways the `@` and `/` menus could tell files, folders, chats, commands, skills and MCP prompts apart. Frozen, the same items in each.
import type { ReactNode } from "react";

import { MentionIcon } from "../src/components/composer/attachments";
import { ComposerMenu, ComposerMenuOption, MenuHeading } from "../src/components/composer/menus";
import { MenuRow } from "../src/components/menu";
import { CodeSquareSlash, Mcp, Sparkle, Terminal, ToolsSkills } from "../src/icons";
import { Row, Section, State } from "./parts";

type Kind = "file" | "folder" | "chat" | "command" | "skill" | "mcp";
type Item = { kind: Kind; name: string; path?: string; detail?: string; age?: string; preview?: string; source?: string };

const MENTIONS: Item[] = [
  { kind: "file", name: "field.tsx", path: "app/ui/src/components/composer" },
  { kind: "file", name: "PLAN.md", path: "docs" },
  { kind: "folder", name: "composer", path: "app/ui/src/components" },
  { kind: "chat", name: "Fix the queue's drag order", age: "2h", preview: "The drop now eases into its slot" },
  { kind: "chat", name: "Composer slice 3", age: "yesterday", preview: "Menus, chips and attachments" },
];
const COMMANDS: Item[] = [
  { kind: "command", name: "/compact", detail: "Save the context so far" },
  { kind: "command", name: "/review", detail: "Review the changes" },
  { kind: "skill", name: "/docs", detail: "Write the docs for a change" },
  { kind: "skill", name: "/kit", detail: "Port a component to the kit" },
  { kind: "mcp", name: "/issues:triage", detail: "Sort the new issues", source: "issues" },
];

const TAG: Record<Kind, string> = { file: "File", folder: "Folder", chat: "Chat", command: "Command", skill: "Skill", mcp: "MCP" };
const HEADING: Record<Kind, string> = { file: "Files", folder: "Folders", chat: "Chats", command: "Commands", skill: "Skills", mcp: "MCP prompts" };

function icon(item: Item): ReactNode {
  if (item.kind === "command") return <CodeSquareSlash />;
  if (item.kind === "skill") return <ToolsSkills />;
  if (item.kind === "mcp") return <Mcp />;
  return <MentionIcon type={item.kind} label={item.name} />;
}

/** The menu's panel where it sits, just above a card's top edge. */
function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="relative h-84 w-110">
      <div className="absolute inset-x-0 bottom-0">
        <ComposerMenu label={label}>{children}</ComposerMenu>
      </div>
    </div>
  );
}

/** A: one ranked list, each row with its kind's icon and a grey kind tag at its end. */
function Tagged({ items, label }: { items: Item[]; label: string }) {
  return (
    <Panel label={label}>
      {items.map((item, index) => (
        <ComposerMenuOption key={item.name} selected={index === 0}>
          <MenuRow icon={icon(item)} title={item.name} detail={item.path ?? item.detail} hint={TAG[item.kind]} />
        </ComposerMenuOption>
      ))}
    </Panel>
  );
}

/** B: a heading with its icon over each kind, the rows under it. */
function Headed({ items, label }: { items: Item[]; label: string }) {
  const kinds = [...new Set(items.map((item) => item.kind))];
  let at = 0;
  return (
    <Panel label={label}>
      {kinds.map((kind) => (
        <div key={kind} className="contents">
          <MenuHeading>
            <span className="flex items-center gap-1.5">
              <span className="flex size-icon-sm items-center svg:size-icon-sm">{icon(items.find((item) => item.kind === kind)!)}</span>
              {HEADING[kind]}
              {kind === "mcp" && <span className="text-faint-foreground">· {items.find((item) => item.kind === kind)?.source}</span>}
            </span>
          </MenuHeading>
          {items
            .filter((item) => item.kind === kind)
            .map((item) => (
              <ComposerMenuOption key={item.name} selected={at++ === 0}>
                <MenuRow icon={icon(item)} title={item.name} detail={item.path ?? item.detail} hint={item.age} />
              </ComposerMenuOption>
            ))}
        </div>
      ))}
    </Panel>
  );
}

/** C: two lines: a file's folder in mono, a chat's age and last words, a command's kind and line. */
function TwoLine({ items, label }: { items: Item[]; label: string }) {
  const second = (item: Item): ReactNode => {
    if (item.path) return <span className="font-mono">{item.path}</span>;
    if (item.kind === "chat") return `${item.age} · ${item.preview}`;
    if (item.kind === "mcp") return `MCP · ${item.source} · ${item.detail}`;
    return `${TAG[item.kind]} · ${item.detail}`;
  };
  return (
    <Panel label={label}>
      {items.map((item, index) => (
        <ComposerMenuOption key={item.name} selected={index === 0}>
          <MenuRow icon={icon(item)} title={item.name} detail={second(item)} twoLine />
        </ComposerMenuOption>
      ))}
    </Panel>
  );
}

/** Today: the rows look alike (for comparison). */
function Today({ items, label }: { items: Item[]; label: string }) {
  return (
    <Panel label={label}>
      {items.map((item, index) => (
        <ComposerMenuOption key={item.name} selected={index === 0}>
          <MenuRow
            icon={
              item.kind === "skill" ? <Sparkle /> : item.kind === "command" || item.kind === "mcp" ? <Terminal /> : <MentionIcon type={item.kind} label={item.name} />
            }
            title={item.name}
            detail={item.path ?? item.detail}
            hint={item.age}
            mono
          />
        </ComposerMenuOption>
      ))}
    </Panel>
  );
}

export function MenuKindsGallery() {
  const variants = [
    { name: "Today (for comparison)", View: Today },
    { name: "A · kind icon and a grey kind tag", View: Tagged },
    { name: "B · a heading per kind (recommended)", View: Headed },
    { name: "C · two lines per row", View: TwoLine },
  ];
  return (
    <Section title="Menus · telling the kinds apart (proposals)">
      {variants.map(({ name, View }) => (
        <Row key={name} name={name}>
          <State label="@ menu">
            <View items={MENTIONS} label="Mentions" />
          </State>
          <State label="/ menu">
            <View items={COMMANDS} label="Slash commands" />
          </State>
        </Row>
      ))}
    </Section>
  );
}
