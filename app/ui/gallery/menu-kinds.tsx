// D139 review: the `@` and `/` menus as they were (Current) beside the proposed look (Proposed). Frozen, the same items.
import type { ReactNode } from "react";

import { MentionIcon } from "../src/components/composer/attachments";
import { ComposerMenu, ComposerMenuOption, MatchedText, MenuHeading } from "../src/components/composer/menus";
import { MenuRow } from "../src/components/menu";
import { Sparkle, Terminal } from "../src/icons";
import { COMMANDS, FrozenCommands, FrozenMentions, search } from "./aids";
import { Row, Section, State } from "./parts";

/** The menu's panel where it sits, just above a card's top edge. */
function Panel({ children, short = false }: { children: ReactNode; short?: boolean }) {
  return (
    <div className={short ? "relative h-16 w-110" : "relative h-84 w-110"}>
      <div className="absolute inset-x-0 bottom-0">{children}</div>
    </div>
  );
}

/** Current: the files ranked with no heading, grey icons, a chat's age in mono. */
function CurrentMentions({ query }: { query: string }) {
  const items = search(query).flatMap((group) => group.items);
  return (
    <ComposerMenu label="Mentions">
      {items.map((item, index) => (
        <ComposerMenuOption key={item.id} selected={index === 0}>
          <MenuRow
            icon={<MentionIcon type={item.type} label={item.label} />}
            title={<MatchedText text={item.name ?? item.label} query={query} />}
            detail={item.detail}
            hint={item.hint}
            mono
          />
        </ComposerMenuOption>
      ))}
    </ComposerMenu>
  );
}

/** Current: one grey terminal icon for every command, a sparkle for skills, only Skills headed. */
function CurrentCommands() {
  return (
    <ComposerMenu label="Slash commands">
      {COMMANDS.map((command, index) => (
        <div key={command.id} className="contents">
          {command.kind === "skill" && COMMANDS[index - 1]?.kind !== "skill" && <MenuHeading>Skills</MenuHeading>}
          <ComposerMenuOption selected={index === 0} disabled={command.disabled}>
            <MenuRow icon={command.kind === "skill" ? <Sparkle /> : <Terminal />} title={command.label} detail={command.description} hint={command.hint} />
          </ComposerMenuOption>
        </div>
      ))}
    </ComposerMenu>
  );
}

export function MenuKindsGallery() {
  return (
    <Section title="Menus · Current | Proposed">
      <Row name="@ menu">
        <State label="Current · @s">
          <Panel>
            <CurrentMentions query="s" />
          </Panel>
        </State>
        <State label="Proposed · @s">
          <Panel>
            <FrozenMentions query="s" />
          </Panel>
        </State>
        <State label="Proposed · nothing typed">
          <Panel>
            <FrozenMentions query="" />
          </Panel>
        </State>
        <State label="Proposed · searching, no results">
          <div className="flex flex-col gap-3">
            <Panel short>
              <FrozenMentions query="zzz" searching />
            </Panel>
            <Panel short>
              <FrozenMentions query="zzz" />
            </Panel>
          </div>
        </State>
      </Row>
      <Row name="/ menu">
        <State label="Current">
          <Panel>
            <CurrentCommands />
          </Panel>
        </State>
        <State label="Proposed">
          <Panel>
            <FrozenCommands query="" />
          </Panel>
        </State>
      </Row>
    </Section>
  );
}
