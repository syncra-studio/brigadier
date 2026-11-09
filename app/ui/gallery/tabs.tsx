// The tab bar and toolbar [D360, D361]: each state side by side, fixed, and the first one live on Home's own tabs.
import type { ReactNode } from "react";

import { TabBar } from "../src/shell/tab-bar";
import { HOME, seedTabs, type Tab } from "../src/shell/tab-store";
import { TabbedMain } from "../src/shell/tab-views";
import type { SessionRow } from "../src/sidebar/words";
import { Section } from "./parts";

const row = (id: string, title: string, change: Partial<SessionRow> = {}): SessionRow => ({ id, title, state: "idle", mark: null, resets: null, sent: 0, finished: 0, project: null, ...change });
const tab = (id: string, kind: Tab["kind"]): Tab => ({ id, kind, opener: "chat" });

seedTabs("g-many", { tabs: [tab("a", "new"), tab("b", "terminal"), tab("c", "terminal")], active: "b" });
seedTabs("g-full", { tabs: Array.from({ length: 14 }, (_, at) => tab(`f${at}`, "terminal")), active: "f3" });
seedTabs("g-new", { tabs: [tab("n", "new")], active: "n" });
seedTabs("g-term", { tabs: [tab("t", "terminal")], active: "t" });

function Bar({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <div className="flex flex-col overflow-clip rounded-surface border border-border bg-chrome">{children}</div>
    </div>
  );
}

export function TabsGallery() {
  return (
    <Section title="Tab bar and toolbar">
      <Bar label="Home, live: + and ⌘T use the gallery's own data">
        <TabBar owner={HOME} offline={false} />
      </Bar>
      <Bar label="A no-project chat">
        <TabBar owner="g-chat" offline={false} row={row("g-chat", "Plan the weekend trip")} />
      </Bar>
      <Bar label="A session in a project, working, several tabs">
        <TabBar owner="g-many" offline={false} row={row("g-many", "Fix the login redirect", { project: "p", mark: "working", state: "working" })} />
      </Bar>
      <Bar label="More tabs than fit: they shrink, then scroll, with the rule before the toolbar">
        <TabBar owner="g-full" offline={false} row={row("g-full", "A session with many tabs")} />
      </Bar>
      <Bar label="Couldn't send: the amber mark leads the tab">
        <TabBar owner="g-amber" offline={false} row={row("g-amber", "Rename the settings page", { mark: "amber", state: "undelivered" })} />
      </Bar>
      <Bar label="Archived: no ⋯, no rename, no terminal">
        <TabBar owner="g-arch" offline={false} row={row("g-arch", "An old session", { archived: 1 })} />
      </Bar>
      <Bar label="Disconnected">
        <TabBar owner="g-off" offline row={row("g-off", "Waiting for the daemon")} />
      </Bar>
      <Bar label="The New tab chooser, drawn">
        <div className="flex h-64 flex-col">
          <TabBar owner="g-new" offline={false} row={row("g-new", "A session")} />
          <TabbedMain owner="g-new" archived={false}>
            <div />
          </TabbedMain>
        </div>
      </Bar>
      <Bar label="A Terminal tab, drawn only">
        <div className="flex h-48 flex-col">
          <TabBar owner="g-term" offline={false} row={row("g-term", "A session")} />
          <TabbedMain owner="g-term" archived={false}>
            <div />
          </TabbedMain>
        </div>
      </Bar>
    </Section>
  );
}
