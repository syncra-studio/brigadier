// A tool call and a `!` command, after the desktop's components/thread/tool.tsx and session/bang-row.tsx.
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PendingApproval } from "../../../../app/shared/cards";
import type { Item, Progress, StepKind, Turn } from "../../../../app/shared/thread";
import { actionWords, shellEnding, toolObject, VERBS } from "../../../../app/shared/words";
import { running, type Group } from "../../../../app/shared/lines";
import { thread } from "../../mac/mac";
import { sheet } from "../../sheets/Sheets";
import { Check, Mcp, Stop } from "../../../../app/ui/src/icons";
import { color, fontWeight, radius, space, spacing, text } from "../../theme";
import { Box, Capped, ErrorLine, Line, Opening, s, StepIcon, useKept, Words } from "./parts";
import { GroupLine } from "./work";

type Tool = Extract<Item, { kind: "tool" }>;

/** Inside the step it allowed: "Allowed by you", and the agent's reason when it gave one [D173]. */
export function Allowed({ approval }: { approval: PendingApproval }) {
  return (
    <Text style={[s.row, st.allowed]} selectable>
      Allowed by you{approval.reason ? <Text style={{ color: color.rowForeground }}> · {approval.reason}</Text> : null}
    </Text>
  );
}

/** A tool item's row, its skill's own steps under it. */
export function ToolItem({ item, turn, bare }: { item: Tool; turn: Turn | undefined; bare: boolean }) {
  return (
    <ToolRow
      keep={item.id}
      kind={item.step}
      name={item.name}
      input={item.input}
      output={item.output}
      progress={item.progress}
      exitCode={item.exitCode}
      line={item.command}
      bare={bare}
      server={item.server}
      approval={item.approval}
      steps={item.log?.length ? <SkillSteps id={item.id} log={item.log} counts={item.logSteps ?? []} turn={turn} /> : undefined}
      description={item.description}
    />
  );
}

/** A skill's own steps under its row as one group: "Ran 16 commands", its running step in its place [D227]. */
function SkillSteps({ id, log, counts, turn }: { id: string; log: Item[]; counts: Group["steps"]; turn: Turn | undefined }) {
  const key = `${id}:steps`;
  const [open, setOpen] = useKept(key);
  const group: Group = { id: key, turnId: turn?.id ?? "", kind: "group", steps: counts, span: [0, 0] };
  const ended = log.filter((step) => !running(step)).map((step) => ({ id: step.id, item: step, turn, step: true }));
  return <GroupLine item={group} turn={turn} open={open} steps={ended} live={log.findLast(running)} members={log} onToggle={() => setOpen(!open)} />;
}

/**
 * One tool call: "Ran pnpm test", "Reading blocks.ts", by its kind. A finished call opens: a command to its Shell box,
 * any other tool to its input and output. A failed tool reads "— failed"; a stopped one "Stopped …"; a queued one "Waiting to run …".
 */
export function ToolRow({
  keep,
  kind = "other",
  name,
  input,
  output,
  progress,
  exitCode,
  line,
  bare = false,
  server,
  approval,
  steps,
  description,
}: {
  keep: string;
  kind?: StepKind;
  name: string;
  input: string;
  output: string;
  progress: Progress;
  exitCode: number | null;
  line?: string | null;
  bare?: boolean;
  server?: string | null;
  approval?: PendingApproval;
  steps?: ReactNode;
  description?: string;
}) {
  const command = kind === "run" || Boolean(line);
  const skill = kind === "skill";
  const object = toolObject(kind, name, input, server);
  const said = command && description ? description : null;
  const shown = said ?? object;
  const colon = said ? ":" : "";
  const live = progress === "running" || progress === "pending";
  const [doing, done, waiting] = VERBS[kind];
  const [verb, what] =
    progress === "running" && server
      ? [`${object}:`, actionWords(name)]
      : progress === "pending"
        ? [`Waiting to ${waiting}${colon}`, shown]
        : progress === "cancelled"
          ? [`Stopped${colon}`, command ? shown : `${doing.toLowerCase()} ${object}`]
          : bare && command
            ? [line || object, null]
            : [`${live ? doing : done}${colon}`, progress === "failed" && !command ? `${object} — failed` : shown];
  const label = what ? `${verb} ${what}` : verb;
  const head = (
    <>
      <StepIcon kind={bare && command ? "run" : kind} icon={progress === "cancelled" ? Stop : server ? Mcp : undefined} />
      <Words verb={verb} object={what} live={progress === "running"} />
    </>
  );
  // A running step opens only when it's a command: its output shows as it comes. A running skill's steps show under it.
  if (live && !command) {
    return (
      <View>
        <Line>{head}</Line>
        {steps && <View style={st.under}>{steps}</View>}
      </View>
    );
  }
  if (skill && !steps && !output) return <Line>{head}</Line>;
  return (
    <Opening
      keep={keep}
      label={label}
      detail={
        <>
          {approval && <Allowed approval={approval} />}
          {skill ? (
            <>
              {steps && <View style={st.under}>{steps}</View>}
              {output ? <Box title="Output"><Capped keep={`${keep}:out`} text={output} style={st.boxText} /></Box> : null}
            </>
          ) : command ? (
            <ShellBox keep={keep} command={line || object} output={output} progress={progress} exitCode={exitCode} />
          ) : (
            <ToolDetail keep={keep} name={server ? `${object}: ${actionWords(name)}` : name} what={server ? actionWords(name) : "Input"} input={input} output={output} failed={progress === "failed"} />
          )}
        </>
      }
    >
      {head}
    </Opening>
  );
}

/** A command's box: "Shell", the command (two lines until tapped), its newest output, how it ended. */
export function ShellBox({ keep, command, output, progress, exitCode }: { keep: string; command: string; output: string; progress: Progress; exitCode: number | null }) {
  const [whole, setWhole] = useKept(`${keep}:command`);
  const ending = shellEnding(progress, exitCode);
  return (
    <View style={st.shell}>
      <Text style={st.shellTitle}>Shell</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`$ ${command}`} accessibilityState={{ expanded: whole, disabled: whole }} disabled={whole} onPress={() => setWhole(true)} style={st.command}>
        <Text style={s.code} numberOfLines={whole ? undefined : 2} selectable={whole}>
          <Text style={{ color: color.mutedForeground }}>$ </Text>
          {command}
        </Text>
      </Pressable>
      <View style={st.output}>
        {output ? <Capped keep={keep} text={output} tail style={st.outputText} /> : <Text style={[s.code, { color: color.mutedForeground }]}>No output</Text>}
      </View>
      {ending && (
        <View style={st.ending}>
          {ending === "Success" && <Check className="size-icon-sm text-muted-foreground" />}
          <Text style={[text.sm, { color: color.mutedForeground }]}>{ending}</Text>
        </View>
      )}
    </View>
  );
}

/** `what`: its input's title, an MCP tool's own words ("search jira issues"). */
function ToolDetail({ keep, name, what, input, output, failed }: { keep: string; name: string; what: string; input: string; output: string; failed: boolean }) {
  return (
    <View style={st.toolDetail}>
      {failed && <ErrorLine error={`${name} failed.`} />}
      {input ? <Box title={what}><Capped keep={`${keep}:in`} text={input} style={st.boxText} /></Box> : null}
      {output ? <Box title="Output"><Capped keep={`${keep}:out`} text={output} style={st.boxText} /></Box> : !failed && <Text style={[text.sm, { color: color.mutedForeground }]}>Tool returned no content</Text>}
    </View>
  );
}

/** A `!` command the user ran [D316]: as a command's row; its output and Stop in a sheet, where the Mac has Open in terminal. */
export function ShellRow({ item }: { item: Extract<Item, { kind: "shell" }> }) {
  const output = () => {
    const id = thread.get()?.id;
    if (id) sheet.set({ id, kind: "shell", cmd: item.cmd, command: item.command });
  };
  return (
    <View>
      <ToolRow keep={item.id} kind="run" name="" input={item.command} output={item.output} progress={item.progress} exitCode={item.exitCode} line={item.command} />
      {item.error ? <Text style={[text.sm, { color: color.destructive, paddingLeft: space(6) }]}>{item.error}</Text> : null}
      <View style={st.actions}>
        <Pressable accessibilityRole="button" onPress={output} hitSlop={8} style={({ pressed }) => [st.ghost, pressed && { backgroundColor: color.fill }]}>
          <Text style={st.ghostText}>{item.progress === "running" ? "Output · Stop" : "Output"}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const st = StyleSheet.create({
  under: { gap: space(1), paddingVertical: space(1), paddingLeft: space(6) },
  allowed: { paddingTop: space(1), color: color.mutedForeground },
  // The desktop's ToolBox words.
  boxText: { color: color.actionHover },
  shell: { marginTop: space(1), overflow: "hidden", borderRadius: radius.shell, borderWidth: 1, borderColor: color.fillActive, backgroundColor: color.fill },
  shellTitle: { ...text.label, color: color.shellForeground, paddingHorizontal: space(2), paddingVertical: space(1) },
  command: { paddingHorizontal: space(2), paddingTop: space(2) },
  output: { padding: space(2) },
  outputText: { fontWeight: fontWeight.medium, color: color.shellForeground },
  ending: { flexDirection: "row", alignItems: "center", gap: space(1), alignSelf: "flex-end", paddingHorizontal: space(3), paddingVertical: space(1.5) },
  toolDetail: { gap: space(1), paddingTop: space(1) },
  actions: { flexDirection: "row", gap: space(1), paddingLeft: space(5) },
  // The desktop's ghost xs button.
  ghost: { height: spacing.controlXs, justifyContent: "center", paddingHorizontal: space(2), borderRadius: radius.capsule },
  ghostText: { ...text.xs, fontWeight: fontWeight.medium, color: color.foreground },
});
