import { useEffect, useState } from "react";

import { ModelPicker, type ModelChoice, type ModelGroup } from "../components/composer/model-picker";
import { SelectTrigger } from "../components/select";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { errorText, run, setProfile, useProfile } from "../onboarding/api";
import { asGroups } from "../session/model";
import { SettingsPage, SettingsSection } from "./parts";

/** The Git page's rows, for the page and for Settings search. */
export const GIT_ROWS = {
  writer: { label: "Write with", description: "The model that writes a commit message when you commit from the card without one" },
} as const;

const AUTOMATIC_HINT = "A fast, light model Brigadier picks for each message. When an agent is out of quota, another one writes.";

/** Git, the old app's page with its one row [D1224, D2004]. */
export function GitPage() {
  return (
    <SettingsPage title="Git">
      <SettingsSection title="Writing">
        <SettingsCard>
          <WriterRow />
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}

/**
 * "Write with": Automatic (Rust's rule: the session's cheapest model, else its own) or a model from Rust's catalog of
 * each agent's models [D1224, D2022]. A pick shows at once and goes back with Rust's words if refused [D30].
 */
function WriterRow() {
  const saved = useProfile().value?.git_writer ?? null;
  const [groups, setGroups] = useState<ModelGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    run(["models"]).then((reply) => setGroups(asGroups(reply.groups)), (cause) => setError(errorText(cause)));
  }, []);
  const save = (writer: { backend: string; model: string } | null) => {
    setError(null);
    setProfile(["--git-writer", JSON.stringify(writer)], { git_writer: writer }).catch((cause) => setError(errorText(cause)));
  };
  const usable = groups?.filter((group) => !group.unavailable && group.models.length > 0) ?? [];
  const offered = saved !== null && usable.some((group) => group.provider === saved.backend && group.models.some((model) => model.id === saved.model));
  // A saved model made unavailable stays saved; Rust's Automatic writes meanwhile.
  const gone = saved !== null && groups !== null && !offered;
  const first = usable[0];
  const value: ModelChoice | null = saved ? { provider: saved.backend, model: saved.model, effort: null } : first ? { provider: first.provider, model: first.models[0]!.id, effort: null } : null;
  const name = saved ? (groups?.flatMap((group) => group.models).find((model) => model.id === saved.model)?.name ?? saved.model) : "Automatic";
  return (
    <SettingsRow label={GIT_ROWS.writer.label} description={gone ? "Not available now, so Automatic writes them" : GIT_ROWS.writer.description} error={error}>
      {groups && value ? (
        <ModelPicker
          groups={groups}
          value={value}
          onChange={(choice) => save({ backend: choice.provider, model: choice.model })}
          asksSwitch={false}
          efforts={false}
          automatic={{ chosen: saved === null, label: "Automatic", hint: AUTOMATIC_HINT, onChoose: () => save(null), onTurnOff: () => save({ backend: value.provider, model: value.model }) }}
          trigger={(props) => (
            <SelectTrigger {...props} label={GIT_ROWS.writer.label}>
              {name}
            </SelectTrigger>
          )}
        />
      ) : (
        <SelectTrigger label={GIT_ROWS.writer.label} disabled>
          {name}
        </SelectTrigger>
      )}
    </SettingsRow>
  );
}
