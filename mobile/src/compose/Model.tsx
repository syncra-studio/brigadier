// The session's model pill and its sheet, as the desktop's session/model.tsx and composer/model-columns.tsx: the
// session's own agent's models only, as a phone may set no other [allow.rs `set`].
import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, View } from "react-native";
import { asGroups, choiceOf, loadModels, type Model, type ModelChoice, type ModelGroup, type ModelRow, setArgs } from "../../vendor/brigadier-shared/session/model";
import { failure } from "../../vendor/brigadier-shared/session/run";
import { Button } from "../Button";
import { color, text } from "../theme";
import type { Runner } from "../../vendor/brigadier-shared/session/run";
import { forMac, newId } from "./state";

/** "xhigh" → "Extra high", "medium" → "Medium". */
export const effortLabel = (effort: string) => (effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1));

// The Mac answers `models --fresh` at most once a minute for each phone.
let freshAt = 0;

/** A runner that fails on a refusal, as loadModels wants. */
const strict = (run: Runner) => (args: string[]) => run(args).then((reply) => (reply.ok ? reply : Promise.reject(failure(reply))));

/** The pill under the field, and "‹Agent› after this turn · Switch now" while another agent waits for the turn's end [D557]. */
export function ModelPill({ id, row, connected }: { id: string; row: ModelRow | undefined; connected: boolean }) {
  const { models: lists, run } = forMac();
  const [groups, setGroups] = useState<ModelGroup[] | null>(lists.last());
  if (groups) lists.keep(groups);
  const [pending, setPending] = useState<{ op: string; choice: ModelChoice } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (connected) void run(["models", "--session", id]).then((reply) => reply.ok && setGroups((now) => now ?? asGroups(reply.groups)));
  }, [id, connected]);
  // Settled once Rust's row has taken it.
  if (pending && row?.setup_op === pending.op) setPending(null);
  const value = pending?.choice ?? choiceOf(row);
  if (!value) return null;

  const show = () => {
    setOpen(true);
    if (Date.now() - freshAt < 60_000) return;
    freshAt = Date.now();
    loadModels(strict(run), id, { list: (list, fresh) => setGroups((now) => (fresh || now === null ? list : now)), failed: (cause) => setError(String(cause)) });
  };
  const change = (choice: ModelChoice) => {
    const op = newId();
    setPending({ op, choice });
    setError(null);
    void run(setArgs(id, choice, op)).then((reply) => {
      if (reply.ok) return;
      // Only this pick's refusal undoes it; a newer pick stands.
      setPending((now) => (now?.op === op ? null : now));
      setError(failure(reply));
    });
  };
  const picked = row?.picked;
  return (
    <View style={st.row}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Model: ${words(groups, value)}`} disabled={!connected || !groups} onPress={show} style={({ pressed }) => [st.pill, (pressed || !connected) && { opacity: 0.6 }]}>
        <Text style={st.pillText} numberOfLines={1}>{words(groups, value)}</Text>
      </Pressable>
      {picked && row?.running ? <SwitchAfter key={row.setup_op ?? ""} id={id} name={groups?.find((group) => group.provider === picked.backend)?.label ?? picked.backend} now={picked.now === true} onError={setError} /> : null}
      {error ? <Text style={st.error} numberOfLines={2}>{error}</Text> : null}
      {open && groups ? <Sheet group={groups.find((group) => group.provider === row?.backend)} value={value} onPick={change} onClose={() => setOpen(false)} /> : null}
    </View>
  );
}

/** Model, ⚡ on Fast, effort: the pill's words. */
function words(groups: ModelGroup[] | null, value: ModelChoice): string {
  const model = groups?.find((group) => group.provider === value.provider)?.models.find((each) => each.id === value.model);
  const effort = value.effort ? effortLabel(value.effort) : model && model.efforts.length > 0 ? "Default" : null;
  return [model?.name ?? value.model, value.fast && model?.fast ? "⚡" : null, effort].filter(Boolean).join(" ");
}

function SwitchAfter({ id, name, now, onError }: { id: string; name: string; now: boolean; onError: (error: string) => void }) {
  const { run } = forMac();
  const [asked, setAsked] = useState(false);
  const go = () => {
    setAsked(true);
    void run(["set", id, "--op", newId(), "--now"]).then((reply) => {
      if (reply.ok) return;
      setAsked(false);
      onError(`Couldn't switch now: ${failure(reply)}`);
    });
  };
  if (now || asked) return <Text style={st.muted} numberOfLines={1}>Switching to {name}…</Text>;
  return (
    <View style={st.switch}>
      <Text style={st.muted} numberOfLines={1}>{name} after this turn</Text>
      <Pressable accessibilityRole="button" onPress={go} hitSlop={8}>
        <Text style={st.link}>Switch now</Text>
      </Pressable>
    </View>
  );
}

/**
 * The agent's models, older ones behind Show more, the one in use's effort levels and Fast. A model or a level picks
 * and closes; Fast keeps it open. A new model keeps the effort when it has that level, else takes its own default.
 */
function Sheet({ group, value, onPick, onClose }: { group: ModelGroup | undefined; value: ModelChoice; onPick: (choice: ModelChoice) => void; onClose: () => void }) {
  const [older, setOlder] = useState(false);
  const models = group?.models ?? [];
  const inUse = (model: Model) => group?.provider === value.provider && model.id === value.model;
  const shown = models.filter((model) => older || !model.legacy || inUse(model));
  const used = models.find(inUse);
  const pick = (model: Model, also: { effort?: string; fast?: boolean } = {}, stay = false) => {
    const effort = also.effort ?? (inUse(model) ? value.effort : value.effort && model.efforts.includes(value.effort) ? value.effort : (model.defaultEffort ?? null));
    onPick({ provider: group!.provider, model: model.id, effort, ...(model.fast && (also.fast ?? value.fast) ? { fast: true } : {}) });
    if (!stay) onClose();
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView style={st.page} contentContainerStyle={{ padding: 24, gap: 8 }}>
        <Text style={st.title}>Model</Text>
        {!group || group.unavailable ? (
          <Text style={st.muted}>{group ? `${group.label} isn't ${group.unavailable === "install" ? "installed" : "signed in"} on your Mac.` : "No models listed for this agent."}</Text>
        ) : (
          <>
            {shown.map((model) => (
              <Pressable key={model.id} accessibilityRole="radio" accessibilityState={{ checked: inUse(model) }} onPress={() => pick(model)} style={[st.option, inUse(model) && st.on]}>
                <Text style={st.optionText}>{model.name}</Text>
                {model.legacy ? <Text style={st.muted}>Older</Text> : null}
              </Pressable>
            ))}
            {!older && models.some((model) => model.legacy && !inUse(model)) ? <Button title="Show more" secondary onPress={() => setOlder(true)} /> : null}
            {used && used.efforts.length > 0 ? (
              <>
                <Text style={st.heading}>Effort</Text>
                {used.efforts.map((level) => (
                  <Pressable key={level} accessibilityRole="radio" accessibilityState={{ checked: value.effort === level }} onPress={() => pick(used, { effort: level })} style={[st.option, value.effort === level && st.on]}>
                    <Text style={st.optionText}>{effortLabel(level)}</Text>
                    {level === used.defaultEffort ? <Text style={st.muted}>Default</Text> : null}
                  </Pressable>
                ))}
              </>
            ) : null}
            {used ? (
              <View style={[st.option, { marginTop: 16 }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[st.optionText, !used.fast && st.muted]}>Fast</Text>
                  <Text style={st.muted}>{used.fast ?? `${used.name} has no fast tier`}</Text>
                </View>
                <Switch accessibilityLabel="Fast" value={Boolean(value.fast && used.fast)} disabled={!used.fast} onValueChange={(fast) => pick(used, { fast }, true)} />
              </View>
            ) : null}
          </>
        )}
        <View style={{ height: 16 }} />
        <Button title="Done" secondary onPress={onClose} />
      </ScrollView>
    </Modal>
  );
}

const st = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1, flexWrap: "wrap" },
  pill: { borderRadius: 999, backgroundColor: color.fill, paddingHorizontal: 12, paddingVertical: 6, maxWidth: 220 },
  pillText: { ...text.sm, color: color.foreground },
  switch: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  muted: { ...text.sm, color: color.mutedForeground, flexShrink: 1 },
  link: { ...text.sm, color: color.link },
  error: { ...text.sm, color: color.destructive, flexShrink: 1 },
  page: { flex: 1, backgroundColor: color.background },
  title: { ...text.pageTitle, color: color.foreground, marginBottom: 8 },
  heading: { ...text.sm, color: color.mutedForeground, marginTop: 16 },
  option: { flexDirection: "row", alignItems: "center", gap: 8, borderRadius: 12, backgroundColor: color.fill, paddingHorizontal: 14, paddingVertical: 12 },
  on: { borderWidth: 1, borderColor: color.foreground },
  optionText: { ...text.base, color: color.foreground, flex: 1 },
});
