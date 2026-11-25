import { useMemo, useRef, useState, useSyncExternalStore } from "react";

import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger, MenuRow } from "../components/menu";
import { TooltipIconButton } from "../components/icon-button";
import { threadSource } from "../daemon";
import { Link, Mcp, Paperclip, Plus, ToolsSkills } from "../icons";
import { Plugin } from "../icons/settings";
import { run } from "../onboarding/api";
import { attachInto, chipInto } from "../session/files";
import type { Item as PluginItem } from "../settings/plugins";
import { openSettings } from "../settings/shell";
import { openTab } from "../shell/tab-store";
import type { Item } from "../thread/item";
import { CardSection } from "./card";
import { Line, Rows } from "./source/rows";

type Source = { kind: "link"; url: string } | { kind: "server" | "skill"; name: string };

const URLS = /https?:\/\/[^\s<>()"'`\]]+/g;
const NONE: readonly Item[] = [];

/**
 * What the session drew on, from its thread's rows [D153 D154]: the links it fetched, the ones its searches found and
 * the ones its answers cite, then the plugins it called (an MCP server's tools, a skill), each once, first seen first.
 * shortcut: only the rows the view holds (the newest 2000 and any paged in); have Rust keep the list if older ones must count.
 */
function sourcesOf(items: readonly Item[]): Source[] {
  const links = new Set<string>();
  const plugins = new Map<string, "server" | "skill">();
  const add = (text: string) => text.match(URLS)?.forEach((url) => links.add(url.replace(/[.,;:!?]+$/, "")));
  for (const item of items) {
    if (item.kind === "message" && item.role === "assistant") add(item.text);
    if (item.kind !== "tool") continue;
    // Brigadier's own tools aren't a plugin.
    if (item.server && item.server !== "brigadier") plugins.set(item.server, "server");
    else if (!item.server && item.step === "skill" && item.name) plugins.set(item.name, "skill");
    if (item.step === "web") add(/^https?:\/\//.test(item.input) ? item.input : item.output);
  }
  return [...[...links].map((url) => ({ kind: "link" as const, url })), ...[...plugins].map(([name, kind]) => ({ kind, name }))];
}

/** "example.com/docs/x": a link without its scheme, www and trailing slash. */
const shown = (url: string) => url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

/**
 * Sources [D146 D153 D154 D155]: a row a link, opening in a browser tab, and a row a plugin the session
 * called, opening Settings › Plugins; folded as Attachments [D139, D151]. Its + uses a plugin (an @ chip in the
 * composer) or attaches files through the composer's own attach. None when there's nothing to list.
 */
export function SourcesCard({ owner }: { owner: string }) {
  const session = useSyncExternalStore(threadSource.subscribe, threadSource.get);
  const items = session?.id === owner ? session.items : NONE;
  const sources = useMemo(() => sourcesOf(items), [items]);
  const [plugins, setPlugins] = useState<PluginItem[] | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  if (sources.length === 0) return null;
  const add = (
    <DropdownMenu modal={false} onOpenChange={(open) => open && void run(["plugins"]).then((page) => setPlugins(page.items.filter((each: PluginItem) => each.on)))}>
      <DropdownMenuTrigger render={<TooltipIconButton tooltip="Add" size="icon-xs" className="text-muted-foreground hover:text-foreground" />}>
        <Plus />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <MenuRow icon={<Plugin />} title="Use plugins" />
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {plugins?.length === 0 && <DropdownMenuItem disabled>No plugins on</DropdownMenuItem>}
            {plugins?.map((each) => (
              <DropdownMenuItem key={each.key} onClick={() => chipInto(owner, { kind: "mention", id: each.key, type: "plugin", label: each.name })}>
                <MenuRow icon={each.kind === "server" ? <Mcp /> : <ToolsSkills />} title={each.name} />
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={() => picker.current?.click()}>
          <MenuRow icon={<Paperclip />} title="Attach files" />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  return (
    <CardSection title="Sources" fold="sources" count={sources.length} end={add}>
      <Rows items={sources} fold={3}>
        {(source) =>
          source.kind === "link" ? (
            <Line key={source.url} icon={<Link />} title={source.url} onClick={() => openTab(owner, "browser", source.url)}>
              {shown(source.url)}
            </Line>
          ) : (
            <Line key={source.name} icon={source.kind === "server" ? <Mcp /> : <ToolsSkills />} onClick={() => openSettings("plugins")}>
              {source.name}
            </Line>
          )
        }
      </Rows>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          attachInto(owner, [...(event.currentTarget.files ?? [])]);
          event.currentTarget.value = "";
        }}
      />
    </CardSection>
  );
}
