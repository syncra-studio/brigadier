// The session's model pill and its sheet, as the desktop's session/model.tsx, model-picker.tsx and model-columns.tsx:
// the session's own agent's models only, as a phone may set no other [allow.rs `set`]; a worker's shown but fixed [D293].
import { useEffect, useState, useSyncExternalStore } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { asGroups, choiceOf, loadModels, type Model, type ModelChoice, type ModelGroup, type ModelRow, setArgs } from "../../vendor/brigadier-shared/session/model";
import { failure } from "../../vendor/brigadier-shared/session/run";
import { store } from "../../vendor/brigadier-shared/store";
import { Button } from "../Button";
import { color, size, text } from "../theme";
import { Glyph } from "./Glyph";
import { fuzzyMatch, MatchedText } from "./Menus";
import { Pill } from "./Pill";
import type { Runner } from "../../vendor/brigadier-shared/session/run";
import { forMac, newId } from "./state";

/** "xhigh" → "Extra high", "medium" → "Medium". */
export const effortLabel = (effort: string) => (effort === "xhigh" ? "Extra high" : effort.charAt(0).toUpperCase() + effort.slice(1));

const FAVORITES = "favorite-models";
/** The starred models, "agent/model", as the desktop's model-keys.ts keeps them. */
// shortcut: the phone's localStorage is state.ts's in-memory one, so stars last till the app quits; upgrade with a storage package.
const favorites = store<readonly string[]>(JSON.parse(localStorage.getItem(FAVORITES) ?? "[]"));
function star(key: string) {
  const now = favorites.get();
  favorites.set(now.includes(key) ? now.filter((each) => each !== key) : [...now, key]);
  localStorage.setItem(FAVORITES, JSON.stringify(favorites.get()));
}

// The Mac answers `models --fresh` at most once a minute for each phone.
let freshAt = 0;

/** A runner that fails on a refusal, as loadModels wants. */
const strict = (run: Runner) => (args: string[]) => run(args).then((reply) => (reply.ok ? reply : Promise.reject(failure(reply))));

/** The pill in the footer, and "‹Agent› after this turn · Switch now" while another agent waits for the turn's end [D557]. */
export function ModelPill({ id, row, connected, open: opened = false }: { id: string; row: ModelRow | undefined; connected: boolean; /** Open at first (a sample screen). */ open?: boolean }) {
  const { models: lists, run } = forMac();
  const [groups, setGroups] = useState<ModelGroup[] | null>(lists.last());
  if (groups) lists.keep(groups);
  const [pending, setPending] = useState<{ op: string; choice: ModelChoice } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(opened);
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
  const model = groups?.find((group) => group.provider === value.provider)?.models.find((each) => each.id === value.model);
  const effort = value.effort ? effortLabel(value.effort) : model && model.efforts.length > 0 ? "Default" : null;
  const fast = value.fast === true && Boolean(model?.fast);
  return (
    <>
      {error ? <Text style={st.error} numberOfLines={2}>{error}</Text> : null}
      {picked && row?.running ? <SwitchAfter key={row.setup_op ?? ""} id={id} name={groups?.find((group) => group.provider === picked.backend)?.label ?? picked.backend} now={picked.now === true} onError={setError} /> : null}
      <Pill label={`Model: ${model?.name ?? value.model}${fast ? ", Fast" : ""}${effort ? `, ${effort}` : ""}`} open={open} disabled={!connected || !groups || Boolean(row?.worker)} onPress={show} style={{ maxWidth: 200 }}>
        <Text style={st.pillText} numberOfLines={1}>{model?.name ?? value.model}</Text>
        {fast ? <Glyph name="bolt" size={size.iconXs} color={color.glyph5} /> : null}
        {effort ? <Text style={st.effort} numberOfLines={1}>{effort}</Text> : null}
      </Pill>
      {open && groups ? <Sheet group={groups.find((group) => group.provider === row?.backend)} value={value} onPick={change} onClose={() => setOpen(false)} /> : null}
    </>
  );
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
      <Pressable accessibilityRole="button" onPress={go} hitSlop={12}>
        <Text style={st.link}>Switch now</Text>
      </Pressable>
    </View>
  );
}

/**
 * The agent's models: a search over them, the starred ones first, older ones behind Show N more, a check on the one in
 * use; its effort levels and Fast. A model or a level picks and closes; Fast and a star keep it open. A new model keeps
 * the effort when it has that level, else takes its own default.
 */
function Sheet({ group, value, onPick, onClose }: { group: ModelGroup | undefined; value: ModelChoice; onPick: (choice: ModelChoice) => void; onClose: () => void }) {
  const stars = useSyncExternalStore(favorites.subscribe, favorites.get);
  const [older, setOlder] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim();
  const models = group?.models ?? [];
  const keyOf = (model: Model) => `${group?.provider}/${model.id}`;
  const inUse = (model: Model) => group?.provider === value.provider && model.id === value.model;
  const isOld = (model: Model) => model.legacy === true && !inUse(model) && !stars.includes(keyOf(model));
  const found = needle
    ? models
        .map((model) => ({ model, rank: fuzzyMatch(model.name, needle)?.rank }))
        .filter((each) => each.rank !== undefined)
        .sort((a, b) => a.rank! - b.rank!)
        .map((each) => each.model)
    : [];
  const starred = models.filter((model) => stars.includes(keyOf(model)));
  const listed = [...models].sort((a, b) => Number(a.legacy ?? false) - Number(b.legacy ?? false));
  const hidden = listed.filter(isOld).length;
  const shown = older ? listed : listed.filter((model) => !isOld(model));
  const used = models.find(inUse);
  const pick = (model: Model, also: { effort?: string; fast?: boolean } = {}, stay = false) => {
    const effort = also.effort ?? (inUse(model) ? value.effort : value.effort && model.efforts.includes(value.effort) ? value.effort : (model.defaultEffort ?? null));
    onPick({ provider: group!.provider, model: model.id, effort, ...(model.fast && (also.fast ?? value.fast) ? { fast: true } : {}) });
    if (!stay) onClose();
  };
  const row = (model: Model, mixed: boolean) => {
    const on = stars.includes(keyOf(model));
    return (
      <Pressable key={model.id} accessibilityRole="radio" accessibilityState={{ checked: inUse(model) }} onPress={() => pick(model)} style={({ pressed }) => [st.option, pressed && { backgroundColor: color.fill }]}>
        <Text style={st.optionText} numberOfLines={2}>
          {needle ? <MatchedText words={model.name} query={needle} /> : model.name}
        </Text>
        {inUse(model) ? <Glyph name="check" size={size.iconSm} label="In use" /> : null}
        {model.legacy && mixed ? <Text style={st.faint}>Older</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={on ? "Remove from favorites" : "Add to favorites"} accessibilityState={{ selected: on }} onPress={() => star(keyOf(model))} hitSlop={12} style={{ marginLeft: "auto" }}>
          <Glyph name={on ? "starFilled" : "star"} color={on ? color.glyph5 : color.mutedForeground} />
        </Pressable>
      </Pressable>
    );
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <ScrollView style={st.page} contentContainerStyle={{ padding: 24, gap: 2 }} keyboardShouldPersistTaps="handled">
        <Text style={st.title}>Model</Text>
        {!group || group.unavailable ? (
          <Text style={st.muted}>{group ? (group.unavailable === "install" ? `${group.label} isn't installed. Install it and its models show here.` : `${group.label} isn't signed in. Sign in and its models show here.`) : "No models listed yet"}</Text>
        ) : (
          <>
            <View style={st.search}>
              <Glyph name="search" color={color.mutedForeground} />
              <TextInput value={query} onChangeText={setQuery} placeholder="Search all models" placeholderTextColor={color.placeholder} accessibilityLabel="Search all models" autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" style={st.searchText} />
            </View>
            {needle ? (
              <>
                {found.map((model) => row(model, true))}
                {found.length === 0 ? <Text style={st.note}>No models match “{needle}”</Text> : null}
              </>
            ) : (
              <>
                {starred.length > 0 ? <Text style={st.heading}>Favorites</Text> : null}
                {starred.map((model) => row(model, true))}
                {starred.length > 0 ? <Text style={st.heading}>{group.label}</Text> : null}
                {shown.map((model) => row(model, false))}
                {hidden > 0 ? (
                  <Pressable accessibilityRole="button" onPress={() => setOlder(!older)} style={({ pressed }) => [st.option, pressed && { backgroundColor: color.fill }]}>
                    <View style={older && { transform: [{ rotate: "180deg" }] }}>
                      <Glyph name="chevronDown" color={color.mutedForeground} />
                    </View>
                    <Text style={st.muted}>{older ? "Show less" : `Show ${hidden} more`}</Text>
                  </Pressable>
                ) : null}
                {models.length === 0 ? <Text style={st.note}>No models listed yet</Text> : null}
              </>
            )}
            {used ? (
              <>
                <Text style={st.heading}>Effort</Text>
                <Text style={st.faint}>{used.name}</Text>
                {used.efforts.length === 0 ? <Text style={st.note}>No effort levels</Text> : null}
                {used.efforts.map((level) => (
                  <Pressable key={level} accessibilityRole="radio" accessibilityState={{ checked: value.effort === level }} onPress={() => pick(used, { effort: level })} style={({ pressed }) => [st.option, pressed && { backgroundColor: color.fill }]}>
                    <Text style={st.optionText}>{effortLabel(level)}</Text>
                    {value.effort === level ? <Glyph name="check" size={size.iconSm} /> : level === used.defaultEffort ? <Text style={st.faint}>Default</Text> : null}
                  </Pressable>
                ))}
                <View style={[st.option, st.fast]}>
                  <Glyph name="bolt" size={size.iconSm} color={value.fast && used.fast ? color.glyph5 : color.placeholder} />
                  <View style={{ flex: 1 }}>
                    <Text style={[st.optionText, !used.fast && { color: color.placeholder }]}>Fast</Text>
                    <Text style={st.muted}>{used.fast ?? `${used.name} has no fast tier`}</Text>
                  </View>
                  <Switch accessibilityLabel="Fast" value={Boolean(value.fast && used.fast)} disabled={!used.fast} onValueChange={(fast) => pick(used, { fast }, true)} />
                </View>
              </>
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
  pillText: { ...text.sm, color: color.foreground, flexShrink: 1 },
  effort: { ...text.sm, color: color.mutedForeground, flexShrink: 0 },
  switch: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 1 },
  muted: { ...text.sm, color: color.mutedForeground, flexShrink: 1 },
  faint: { ...text.xs, color: color.placeholder },
  link: { ...text.sm, color: color.link },
  error: { ...text.xs, color: color.destructive, flexShrink: 1 },
  page: { flex: 1, backgroundColor: color.background },
  title: { ...text.pageTitle, color: color.foreground, marginBottom: 8 },
  heading: { ...text.label, color: color.mutedForeground, marginTop: 16, marginBottom: 4 },
  note: { ...text.label, color: color.mutedForeground, paddingVertical: 8 },
  search: { flexDirection: "row", alignItems: "center", gap: 8, height: size.touch, paddingHorizontal: 12, marginBottom: 8, borderRadius: size.radiusControl, backgroundColor: color.fill },
  searchText: { ...text.sm, color: color.foreground, flex: 1, padding: 0 },
  option: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.touch, borderRadius: size.radiusControl, paddingHorizontal: 8 },
  fast: { marginTop: 12, borderTopWidth: 1, borderTopColor: color.border, borderRadius: 0, paddingTop: 8 },
  optionText: { ...text.sm, color: color.foreground, flexShrink: 1 },
});
