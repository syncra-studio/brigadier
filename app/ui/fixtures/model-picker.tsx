// Mockup only: the model picker as a menu of three columns, "In the footer" (round 2's B, ?v=b), drawn by the app's own
// parts since it was wired in (src/components/composer/model-columns.tsx), over fake agents, models and limits: in a
// chat, a new chat, Settings, Fork and a side chat. Not the app; ?v=real is the app itself on a fake daemon.
import "../src/theme.css";
import "./fixtures.css";

import { type ComponentProps, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { COLUMN, ContextRing, PlusButton, SharedComposer } from "../src/components/composer/composer";
import { favorites } from "../src/components/composer/model-keys";
import { type ModelChoice, ModelPicker } from "../src/components/composer/model-picker";
import { ModelPill } from "../src/components/composer/model-pill";
import { type PermissionLevel, PermissionPicker } from "../src/components/composer/pickers";
import { SendButton } from "../src/components/composer/send-button";
import { cx } from "../src/components/cx";
import { Button } from "../src/components/button";
import { Segmented } from "../src/components/segmented";
import { SelectTrigger } from "../src/components/select";
import { SettingsCard } from "../src/components/settings-card";
import { SettingsRow } from "../src/components/settings-row";
import { Switch } from "../src/components/switch";
import { UserBubble } from "../src/components/thread/message";
import { showToast, Toaster } from "../src/components/toast";
import { BranchAlt } from "../src/icons";
import { groups, type Ready } from "./model-picker-fake";
import { openReal } from "./model-picker-real";

if (favorites.get().length === 0) favorites.set(["claude/opus", "claude/sonnet", "codex/sol"]);

type Place = "chat" | "new" | "side" | "settings" | "fork";
const PLACES: { value: Place; label: string }[] = [
  { value: "chat", label: "Chat" },
  { value: "new", label: "New chat" },
  { value: "side", label: "Side chat" },
  { value: "settings", label: "Settings" },
  { value: "fork", label: "Fork" },
];
const asked = new URLSearchParams(location.search).get("at");

function Page() {
  const [ready, setReady] = useState<Ready>("ready");
  const [offline, setOffline] = useState(false);
  const [place, setPlace] = useState<Place>(PLACES.find((each) => each.value === asked)?.value ?? "chat");
  const list = groups(ready);
  const [value, setValue] = useState<ModelChoice>({ provider: "claude", model: "opus", effort: "high", fast: true });
  const [writer, setWriter] = useState<ModelChoice>({ provider: "claude", model: "haiku", effort: null });
  const [level, setLevel] = useState<PermissionLevel>("auto");
  // Open as the page comes, where there is a composer.
  const [asks, setAsks] = useState(0);
  useEffect(() => setAsks(1), []);
  const anchor = useRef<HTMLSpanElement>(null);
  const picker = { groups: list, value, onChange: setValue, onSetUp: (provider: string) => showToast(`Set up ${provider} opens here`) };
  const select = (label: string): ComponentProps<typeof ModelPicker>["trigger"] => ({ children, ...props }) => <SelectTrigger {...props} label={label}>{children}</SelectTrigger>;
  const composer = (asksSwitch: boolean) => (
    <SharedComposer
      plus={<PlusButton />}
      level={<PermissionPicker value={level} onChange={setLevel} />}
      ring={<ContextRing usedTokens={45_000} windowTokens={258_000} />}
      model={<ModelPill {...picker} asksSwitch={asksSwitch} disabled={offline} asked={asks} />}
      send={<SendButton empty running={false} canStop={false} onSend={() => {}} onStop={() => {}} />}
    >
      <div role="textbox" tabIndex={0} contentEditable suppressContentEditableWarning aria-label="Message" className="min-h-composer px-2 py-2.5 text-base outline-none" />
    </SharedComposer>
  );
  const thread = (
    <div className="min-h-0 w-full flex-1 overflow-hidden px-scrollbar">
      <div className={cx(COLUMN, "flex flex-col gap-4 py-6 text-chat")}>
        <UserBubble keep="u1" text="Why does the tab test fail now and then?" />
        <p>It reads the strip before the closing tab has gone. It now waits for that.</p>
        {place === "fork" && (
          <div>
            <span ref={anchor} className="inline-flex">
              <Button variant="soft" size="sm" onClick={() => setAsks((n) => n + 1)}>
                <BranchAlt aria-hidden />
                Fork with another agent
              </Button>
            </span>
            <ModelPicker {...picker} asksSwitch={false} asked={asks} anchor={anchor} />
          </div>
        )}
      </div>
    </div>
  );
  return (
    <main className="flex h-screen min-h-160 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-divider px-4 py-2 text-xs text-muted-foreground">
        Mockup:
        <Segmented label="Place" value={place} onChange={setPlace} options={PLACES} />
        OpenCode is
        <Segmented label="OpenCode" value={ready} onChange={setReady} options={[{ value: "ready", label: "Ready" }, { value: "sign-in", label: "Not signed in" }, { value: "install", label: "Not installed" }]} />
        <label className="flex items-center gap-1.5">
          Offline
          <Switch aria-label="Offline" checked={offline} onCheckedChange={setOffline} />
        </label>
      </div>
      {place === "settings" ? (
        <div className="mx-auto w-full max-w-reading p-6">
          <SettingsCard>
            <SettingsRow label="Start with" description="Routing and rules: a model with its effort">
              <ModelPicker {...picker} asksSwitch={false} trigger={select("Start with")} />
            </SettingsRow>
            <SettingsRow label="Write with" description="Git: a model alone, so two columns">
              <ModelPicker {...picker} value={writer} onChange={setWriter} efforts={false} asksSwitch={false} trigger={select("Write with")} />
            </SettingsRow>
          </SettingsCard>
        </div>
      ) : place === "new" ? (
        <div className="flex min-h-0 flex-1 flex-col justify-end pb-24">
          {composer(false)}
        </div>
      ) : place === "side" ? (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1" />
          <div className="flex w-96 shrink-0 flex-col border-s border-divider">
            {thread}
            {composer(true)}
          </div>
        </div>
      ) : (
        <>
          {thread}
          {place === "chat" && composer(true)}
        </>
      )}
      <Toaster />
    </main>
  );
}

const variant = new URLSearchParams(location.search).get("v") ?? "b";
if (variant === "real") void openReal();
else createRoot(document.getElementById("root")!).render(variant === "b" ? <Page /> : <p className="p-4 text-label">This variant was dropped. Its round keeps its screenshot.</p>);
