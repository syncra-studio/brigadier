import { useRef, useState } from "react";

import { Button } from "../components/button";
import { effortLabel, type ModelChoice, type ModelGroup, ModelPicker } from "../components/composer/model-picker";
import { named } from "../components/composer/model-keys";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger, DropdownMenuTrigger } from "../components/menu";
import { SettingsCard } from "../components/settings-card";
import { Plus, X } from "../icons";
import { SettingsSection } from "./parts";
import { Note, ROUTING_ROWS, type Rule } from "./routing";

const NOTHING: ModelChoice = { provider: "", model: "", effort: null };

/** Every effort an agent's models list (every agent's, for `groups` of all), in their order. */
const effortsOf = (groups: readonly ModelGroup[]) => [...new Set(groups.flatMap((group) => group.models.flatMap((model) => model.efforts)))];

/** "Never use Opus 5.5", "Never go above High effort", "… on Claude". */
export function ruleTitle(rule: Rule, groups: readonly ModelGroup[]): string {
  if (rule.never === "model") return `Never use ${named(groups, rule.agent, rule.model)}`;
  const group = groups.find((each) => each.provider === rule.agent);
  return `Never go above ${effortLabel(rule.effort)} effort${group ? ` on ${group.short ?? group.label}` : ""}`;
}

/**
 * Rules, the old app's card: each rule a row with × to remove it. Add rule opens a menu: "Never use a model…" (the
 * shared model picker) or "Never above an effort…" (every agent's efforts, or one agent's). No words to rewrite:
 * every rule is exact [D338, D341]. `note`, under the card, is where they can't reach (Rust's words, spec §7).
 */
export function Rules({ rules, groups, note, onSave }: { rules: readonly Rule[]; groups: ModelGroup[]; note: string; onSave: (rules: Rule[]) => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const [asked, setAsked] = useState(0);
  const [picked, setPicked] = useState<ModelChoice>(NOTHING);
  const set = groups.filter((group) => !group.unavailable && group.models.length > 0);
  const add = (rule: Rule) => {
    if (!rules.some((other) => ruleTitle(other, groups) === ruleTitle(rule, groups))) onSave([...rules, rule]);
  };
  const scopes = [{ agent: null, label: "Every agent", efforts: effortsOf(set) }, ...set.map((group) => ({ agent: group.provider, label: group.label, efforts: effortsOf([group]) }))];
  return (
    <SettingsSection
      title={ROUTING_ROWS.rules.label}
      setting={ROUTING_ROWS.rules.label}
      description={ROUTING_ROWS.rules.description}
      actions={
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button ref={button} variant="soft" size="sm" data-slot="add-rule" />}>
            <Plus aria-hidden />
            Add rule
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setAsked((count) => count + 1)}>Never use a model…</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Never above an effort…</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {scopes.map((scope) => (
                  <DropdownMenuSub key={scope.label}>
                    <DropdownMenuSubTrigger>{scope.label}</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {scope.efforts.map((effort) => (
                        <DropdownMenuItem key={effort} onClick={() => add({ never: "above", effort, agent: scope.agent })}>
                          {effortLabel(effort)}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <ModelPicker
        groups={groups}
        value={picked}
        asked={asked}
        anchor={button}
        asksSwitch={false}
        efforts={false}
        onChange={(choice) => {
          setPicked(choice);
          add({ never: "model", agent: choice.provider, model: choice.model });
        }}
        onClose={() => setPicked(NOTHING)}
      />
      {rules.length > 0 && (
        <SettingsCard inset data-slot="routing-rules">
          {rules.map((rule) => {
            const title = ruleTitle(rule, groups);
            return (
              <div key={title} data-slot="routing-rule" className="flex items-center gap-3 py-3.5">
                <span className="min-w-0 flex-1 truncate text-label text-foreground">{title}</span>
                <button
                  type="button"
                  aria-label={`Remove “${title}”`}
                  onClick={() => onSave(rules.filter((other) => other !== rule))}
                  className="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
                >
                  <X aria-hidden className="size-3.75" />
                </button>
              </div>
            );
          })}
        </SettingsCard>
      )}
      <Note>{note}</Note>
    </SettingsSection>
  );
}
