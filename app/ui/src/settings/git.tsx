import { useEffect, useState } from "react";

import { ModelPicker, type ModelChoice, type ModelGroup } from "../components/composer/model-picker";
import { SelectTrigger } from "../components/select";
import { SettingsCard } from "../components/settings-card";
import { SettingsRow } from "../components/settings-row";
import { useDaemon } from "../daemon";
import { errorText, run, setProfile, useAgents, useProfile } from "../onboarding/api";
import { asGroups } from "../session/model";
import { SettingsPage, SettingsSection } from "./parts";

/** The Git page's rows, for the page and for Settings search. */
export const GIT_ROWS = {
  writer: { label: "Write with", description: "The model that writes a pull request’s title and message, and its commit’s, when you leave them empty" },
} as const;

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
 * "Write with": one model from Rust's catalog of each agent's models, saved by Rust once any is known [D1224, D2022]. A
 * pick shows at once and goes back with Rust's words if refused [D30].
 */
function WriterRow() {
  const profile = useProfile().value;
  const saved = profile?.git_writer ?? null;
  const [groups, setGroups] = useState<ModelGroup[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const online = Boolean(useDaemon().daemon);
  const agents = useAgents().list;
  useEffect(() => {
    if (!online) return;
    let live = true;
    setError(null);
    run(["models"]).then((reply) => {
      if (live) setGroups(asGroups(reply.groups));
    }, (cause) => {
      if (live) setError(errorText(cause));
    });
    return () => { live = false; };
  }, [online, agents]);
  // None saved yet (no agent was ready): Rust saves its first choice now that the models are known.
  const unsaved = profile !== undefined && saved === null;
  useEffect(() => {
    if (groups && unsaved) void setProfile([], {}).catch((cause) => setError(errorText(cause)));
  }, [groups, unsaved]);
  const save = (writer: { backend: string; model: string }) => {
    setError(null);
    setProfile(["--git-writer", JSON.stringify(writer)], { git_writer: writer }).catch((cause) => setError(errorText(cause)));
  };
  const usable = groups?.filter((group) => !group.unavailable && group.models.length > 0) ?? [];
  const offered = saved !== null && usable.some((group) => group.provider === saved.backend && group.models.some((model) => model.id === saved.model));
  // A saved model made unavailable stays saved; the session's own agent writes meanwhile.
  const gone = saved !== null && groups !== null && !offered;
  const value: ModelChoice | null = saved && { provider: saved.backend, model: saved.model, effort: null };
  const name = saved ? (groups?.find((group) => group.provider === saved.backend)?.models.find((model) => model.id === saved.model)?.name ?? saved.model) : groups ? "No models yet" : "";
  return (
    <SettingsRow label={GIT_ROWS.writer.label} description={gone ? "Not available now, so the session's own agent writes them on its light model" : GIT_ROWS.writer.description} error={error}>
      {usable.length > 0 && value ? (
        <ModelPicker
          groups={usable}
          value={value}
          onChange={(choice) => save({ backend: choice.provider, model: choice.model })}
          asksSwitch={false}
          efforts={false}
          trigger={({ children, ...props }) => (
            <SelectTrigger {...props} label={GIT_ROWS.writer.label}>
              {children}
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
