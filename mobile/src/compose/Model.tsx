// The session's model pill and its sheet, as the desktop's session/model.tsx, model-picker.tsx and model-columns.tsx:
// the session's own agent's models only, as a phone may set no other [allow.rs `set`]; a worker's shown but fixed [D293].
import { useEffect, useState, useSyncExternalStore } from "react";
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { asGroups, choiceOf, effortOf, favorites, isOld as old, loadModels, type Model, type ModelChoice, type ModelGroup, type ModelRow, setArgs, star } from "../../../app/shared/session/model";
import { failure } from "../../../app/shared/session/run";
import { MenuLabel, Sheet as Frame } from "../sheets/Sheet";
import { color, opacity, radius, space, spacing, text, touch } from "../theme";
import { Bolt, Check, ChevronDown, MagnifyingGlassSmSearch, Star, StarFilled } from "../../../app/ui/src/icons";
import { ProviderMark } from "./KindIcons";
import { fuzzyMatch, MatchedText } from "./Menus";
import { Pill } from "./Pill";
import type { Runner } from "../../../app/shared/session/run";
import { forMac, newId } from "./state";
import { afterTurn, couldntSwitch, effortLabel, MODEL_WORDS, noFast, noMatch, notSetUp, showOlder } from "../../../app/shared/session/composer";

// shortcut: the shared stars sit in the phone's localStorage, state.ts's in-memory one, so they last till the app quits; upgrade with a storage package.

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
  const effort = value.effort ? effortLabel(value.effort) : model && model.efforts.length > 0 ? MODEL_WORDS.defaultEffort : null;
  const fast = value.fast === true && Boolean(model?.fast);
  return (
    <>
      {error ? <Text style={st.error} numberOfLines={2}>{error}</Text> : null}
      {picked && row?.running ? <SwitchAfter key={row.setup_op ?? ""} id={id} name={groups?.find((group) => group.provider === picked.backend)?.label ?? picked.backend} now={picked.now === true} onError={setError} /> : null}
      <Pill label={`Model: ${model?.name ?? value.model}${fast ? ", Fast" : ""}${effort ? `, ${effort}` : ""}`} open={open} disabled={!connected || !groups || Boolean(row?.worker)} onPress={show} style={{ maxWidth: 200 }}>
        <ProviderMark mark={groups?.find((group) => group.provider === value.provider)?.mark} />
        <Text style={st.pillText} numberOfLines={1}>{model?.name ?? value.model}</Text>
        {fast ? <Bolt className="size-icon-xs text-glyph-5" /> : null}
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
      onError(couldntSwitch(failure(reply)));
    });
  };
  if (now || asked) return <Text style={st.muted} numberOfLines={1}>{afterTurn(name, true)}</Text>;
  return (
    <View style={st.switch}>
      <Text style={st.muted} numberOfLines={1}>{afterTurn(name, false)}</Text>
      <Pressable accessibilityRole="button" onPress={go} hitSlop={space(3)}>
        <Text style={st.link}>{MODEL_WORDS.switchNow}</Text>
      </Pressable>
    </View>
  );
}

/**
 * The agent's models, as the desktop's model-columns.tsx stacked in a sheet: a search over them, the starred ones first,
 * older ones behind Show N more, a check on the one in use; its effort levels; Fast in the footer. A model or a level
 * picks and closes; Fast and a star keep it open. A new model keeps the effort when it has that level, else takes its
 * own default. One agent only, so no rail: its Favorites and name head its rows.
 */
function Sheet({ group, value, onPick, onClose }: { group: ModelGroup | undefined; value: ModelChoice; onPick: (choice: ModelChoice) => void; onClose: () => void }) {
  const stars = useSyncExternalStore(favorites.subscribe, favorites.get);
  const [older, setOlder] = useState(false);
  const [query, setQuery] = useState("");
  const needle = query.trim();
  const models = group?.models ?? [];
  const keyOf = (model: Model) => `${group?.provider}/${model.id}`;
  const inUse = (model: Model) => group?.provider === value.provider && model.id === value.model;
  const isOld = (model: Model) => old(model, inUse(model), stars.includes(keyOf(model)));
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
    const effort = effortOf(model, group!.provider, value, inUse(model), also.effort);
    onPick({ provider: group!.provider, model: model.id, effort, ...(model.fast && (also.fast ?? value.fast) ? { fast: true } : {}) });
    if (!stay) onClose();
  };
  const row = (model: Model, mixed: boolean) => {
    const on = stars.includes(keyOf(model));
    return (
      <Pressable key={model.id} accessibilityRole="radio" accessibilityState={{ checked: inUse(model) }} onPress={() => pick(model)} style={({ pressed }) => [st.item, pressed && { backgroundColor: color.fill }]}>
        <ProviderMark mark={group?.mark} />
        <Text style={st.name} numberOfLines={2}>
          {needle ? <MatchedText words={model.name} query={needle} /> : model.name}
        </Text>
        {inUse(model) ? <Check aria-label={MODEL_WORDS.inUse} className="size-icon-sm text-foreground" /> : null}
        {model.legacy && mixed ? <Text style={st.faint}>{MODEL_WORDS.older}</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel={on ? MODEL_WORDS.unstar : MODEL_WORDS.star} accessibilityState={{ selected: on }} onPress={() => star(keyOf(model))} hitSlop={space(3)} style={st.star}>
          {on ? <StarFilled className="size-icon-sm text-glyph-5" /> : <Star className="size-icon-sm text-muted-foreground" />}
        </Pressable>
      </Pressable>
    );
  };
  const fastOn = Boolean(value.fast && used?.fast);
  return (
    <Frame title={MODEL_WORDS.title} onClose={onClose}>
      {!group || group.unavailable ? (
        <View style={st.notSetUp}>
          {group ? <View style={{ opacity: opacity.pickerDim }}><ProviderMark mark={group.mark} size={spacing.iconMark} /></View> : null}
          <Text style={[st.label, st.dim, { textAlign: "center" }]}>{group ? notSetUp(group.label, group.unavailable) : MODEL_WORDS.noneListed}</Text>
        </View>
      ) : (
        <>
          <View>
            <View style={st.search}>
              <MagnifyingGlassSmSearch className="size-icon-md text-muted-foreground" />
              <TextInput value={query} onChangeText={setQuery} placeholder={MODEL_WORDS.search} placeholderTextColor={color.placeholder} accessibilityLabel={MODEL_WORDS.search} autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" style={st.searchText} />
            </View>
            <View style={st.list}>
              {needle ? (
                <>
                  {found.map((model) => row(model, true))}
                  {found.length === 0 ? <Text style={st.note}>{noMatch(needle)}</Text> : null}
                </>
              ) : (
                <>
                  {starred.length > 0 ? <MenuLabel>{MODEL_WORDS.favorites}</MenuLabel> : null}
                  {starred.map((model) => row(model, true))}
                  {starred.length > 0 ? <MenuLabel>{group.label}</MenuLabel> : null}
                  {shown.map((model) => row(model, false))}
                  {hidden > 0 ? (
                    <Pressable accessibilityRole="button" onPress={() => setOlder(!older)} style={({ pressed }) => [st.item, pressed && { backgroundColor: color.fill }]}>
                      <View style={older && { transform: [{ rotate: "180deg" }] }}>
                        <ChevronDown className="size-icon-md text-muted-foreground" />
                      </View>
                      <Text style={[st.label, st.dim]}>{showOlder(older, hidden)}</Text>
                    </Pressable>
                  ) : null}
                  {models.length === 0 ? <Text style={st.note}>{MODEL_WORDS.noneListed}</Text> : null}
                </>
              )}
            </View>
          </View>
          {used ? (
            <View>
              <View style={st.head}>
                <Text style={[st.label, st.dim]}>{MODEL_WORDS.effort}</Text>
              </View>
              <Text style={st.inHand}>{used.name}</Text>
              <View style={st.list}>
                {used.efforts.length === 0 ? <Text style={st.note}>{MODEL_WORDS.noEfforts}</Text> : null}
                {used.efforts.map((level) => (
                  <Pressable key={level} accessibilityRole="radio" accessibilityState={{ checked: value.effort === level }} onPress={() => pick(used, { effort: level })} style={({ pressed }) => [st.item, pressed && { backgroundColor: color.fill }]}>
                    <Text style={[st.label, { flex: 1 }]} numberOfLines={1}>{effortLabel(level)}</Text>
                    {value.effort === level ? <Check aria-hidden className="size-icon-sm text-foreground" /> : level === used.defaultEffort ? <Text style={st.faint}>{MODEL_WORDS.defaultEffort}</Text> : null}
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}
          {used ? (
            <View style={st.footer}>
              <Bolt className={fastOn ? "size-icon-sm text-glyph-5" : "size-icon-sm text-placeholder"} />
              <View style={{ flex: 1 }}>
                <Text style={[st.label, !used.fast && { color: color.placeholder }]}>{MODEL_WORDS.fast}</Text>
                {/* The desktop's tip on Fast, which a phone has no hover for. */}
                <Text style={st.faint}>{used.fast ?? noFast(used.name)}</Text>
              </View>
              <Switch accessibilityLabel={MODEL_WORDS.fast} value={fastOn} disabled={!used.fast} onValueChange={(fast) => pick(used, { fast }, true)} trackColor={{ true: color.toggleOn, false: color.fillHover }} ios_backgroundColor={color.fillHover} thumbColor={color.foreground} style={!used.fast && { opacity: opacity.switchDisabled }} />
            </View>
          ) : null}
        </>
      )}
    </Frame>
  );
}

// The desktop's itemBase rows (min-h-menu-item, gap-2, ps-2 pe-2, text-label) a finger tall; its columns' h-10 heads
// with a divider under them, its notes px-2 py-1.5, its footer on fill-faint over a divider.
const st = StyleSheet.create({
  pillText: { ...text.sm, color: color.foreground, flexShrink: 1 },
  effort: { ...text.sm, color: color.mutedForeground, flexShrink: 0 },
  switch: { flexDirection: "row", alignItems: "center", gap: space(2), flexShrink: 1 },
  muted: { ...text.sm, color: color.mutedForeground, flexShrink: 1 },
  link: { ...text.sm, color: color.link },
  error: { ...text.xs, color: color.destructive, flexShrink: 1 },
  label: { ...text.label, color: color.foreground, flexShrink: 1 },
  dim: { color: color.mutedForeground },
  faint: { ...text.xs, color: color.placeholder },
  search: { flexDirection: "row", alignItems: "center", gap: space(2), height: touch, borderBottomWidth: 1, borderBottomColor: color.divider },
  searchText: { ...text.label, color: color.foreground, flex: 1, padding: 0 },
  list: { gap: 1, padding: space(1) },
  item: { flexDirection: "row", alignItems: "center", gap: space(2), minHeight: touch, paddingHorizontal: space(2), borderRadius: radius.menuItem },
  name: { ...text.label, color: color.foreground, flexShrink: 1, paddingVertical: space(1) },
  star: { marginStart: "auto" },
  note: { ...text.label, color: color.mutedForeground, paddingHorizontal: space(2), paddingVertical: space(1.5) },
  head: { height: space(10), justifyContent: "center", borderBottomWidth: 1, borderBottomColor: color.divider },
  inHand: { ...text.xs, color: color.placeholder, paddingHorizontal: space(3), paddingTop: space(2) },
  footer: { flexDirection: "row", alignItems: "center", gap: space(2), paddingHorizontal: space(3), paddingVertical: space(2.5), borderTopWidth: 1, borderTopColor: color.divider, backgroundColor: color.fillFaint },
  notSetUp: { alignItems: "center", gap: space(3), paddingHorizontal: space(4) },
});
