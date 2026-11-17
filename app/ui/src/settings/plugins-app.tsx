import { Button } from "../components/button";
import { Input } from "../components/input";
import { Radio, RadioGroup } from "../components/radio";
import { RowText, SettingsCard } from "../components/settings-card";

/** A service that signs in only through the user's own app [D591]; `agent` the one that has it as its own plugin, offered first [D608]. */
export type App = { link: string; steps: string[]; agent?: string | null };
/** The pick: the agent's own plugin, or the user's app by its Client ID. */
export type AppPick = { agent: boolean; clientId: string };

/** Install's first part for such a service: where the agent has it, its plugin or your own app; then your app's steps and its Client ID. */
export function OwnApp({ name, app, value, onChange }: { name: string; app: App; value: AppPick; onChange: (next: AppPick) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {app.agent && (
        <RadioGroup aria-label={`How agents reach ${name}`} value={value.agent ? "agent" : "app"} onValueChange={(next) => onChange({ ...value, agent: next === "agent" })}>
          <SettingsCard>
            <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
              <Radio value="agent" className="mt-0.5" />
              <RowText title={`Use ${app.agent}'s ${name}`} line={`Already signed in. Works in ${app.agent} chats and workers, nothing to create.`} />
            </label>
            <label className="flex cursor-pointer items-start gap-3 px-4 py-3">
              <Radio value="app" className="mt-0.5" />
              <RowText title={`Create your own ${name} app`} line="Works with every agent. A few clicks to set up." />
            </label>
          </SettingsCard>
        </RadioGroup>
      )}
      {!value.agent && (
        <>
          <ol className="flex list-decimal flex-col gap-2 ps-5 text-label marker:text-quiet-foreground">
            {app.steps.map((step, at) => (
              <li key={at}>
                {step}
                {at === 0 && (
                  <div className="mt-2">
                    <Button variant="soft" size="sm" onClick={() => window.brigadier?.openLink(app.link)}>
                      Create your {name} app
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
          <Input aria-label="Client ID" placeholder="Client ID" value={value.clientId} onChange={(event) => onChange({ ...value, clientId: event.target.value })} className="h-8 font-mono text-xs" />
        </>
      )}
    </div>
  );
}
