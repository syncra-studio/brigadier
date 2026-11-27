// A tool call and a `!` command, after the desktop's components/thread/tool.tsx and session/bang-row.tsx.
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { PendingApproval } from "../../../vendor/brigadier-shared/cards";
import type { Item, Progress, StepKind, Turn } from "../../../vendor/brigadier-shared/thread";
import { connectorName, VERBS } from "../../../vendor/brigadier-shared/words";
import { running, type Group } from "../lines";
import { color } from "../../theme";
import { Box, Capped, ErrorLine, Glyph, Line, Opening, s, useKept, Words } from "./parts";
import { GroupLine } from "./work";

type Tool = Extract<Item, { kind: "tool" }>;

/** What a step acted on: a command, a path, a query; another tool's own name, an MCP tool's server ("Atlassian"). */
export const toolObject = (kind: StepKind, name: string, input: string, server?: string | null) =>
  kind === "skill" ? skillObject(name, input) : kind === "other" ? (server ? connectorName(server) : name) : input || name;

/** A skill by its name and what it was given: "code-review on" a PR by its number or repo and number [D211, D227]. */
const skillObject = (name: string, input: string) => `${name || "a skill"}${input ? ` on ${target(input)}` : ""}`;

/** Short arguments naming a PR or issue by link or number read as it alone; any others as given. */
function target(input: string) {
  const words = input.trim().split(/\s+/);
  if (words.length > 3) return input;
  const link = words.map((word) => /([\w.-]+)\/(?:pull|issues)\/(\d+)/.exec(word)).find(Boolean);
  const number = words.find((word) => /^#?\d+$/.test(word));
  return link ? `${link[1]}#${link[2]}` : number ? `#${number.replace("#", "")}` : input;
}

/** An MCP tool's name as words: "searchJiraIssues" is "search jira issues". */
const actionWords = (name: string) =>
  name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .toLowerCase()
    .trim();

/** Inside the step it allowed: "Allowed by you", and the agent's reason when it gave one [D173]. */
export function Allowed({ approval }: { approval: PendingApproval }) {
  return (
    <Text style={[s.row, { color: color.mutedForeground }]}>
      Allowed by you{approval.reason ? <Text style={{ color: color.row }}> · {approval.reason}</Text> : null}
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
      <Glyph g={progress === "cancelled" ? "■" : progress === "failed" ? "✕" : command ? "$" : "·"} tone={progress === "failed" ? color.destructive : undefined} />
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
              {output ? <Box title="Output"><Capped keep={`${keep}:out`} text={output} /></Box> : null}
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
  const ending =
    progress === "cancelled" ? "Stopped" : progress === "failed" && exitCode === null ? "Failed" : exitCode ? `Exit code ${exitCode}` : progress === "done" ? "Success" : null;
  return (
    <View style={st.shell}>
      <Text style={[s.small, { color: color.foreground }]}>Shell</Text>
      <Pressable accessibilityRole="button" accessibilityLabel={`$ ${command}`} accessibilityState={{ expanded: whole, disabled: whole }} disabled={whole} onPress={() => setWhole(true)}>
        <Text style={s.code} numberOfLines={whole ? undefined : 2} selectable={whole}>
          <Text style={{ color: color.mutedForeground }}>$ </Text>
          {command}
        </Text>
      </Pressable>
      {output ? <Capped keep={keep} text={output} tail style={{ color: color.mutedForeground }} /> : <Text style={[s.code, { color: color.mutedForeground }]}>No output</Text>}
      {ending && <Text style={[s.small, { alignSelf: "flex-end" }]}>{ending === "Success" ? "✓ " : ""}{ending}</Text>}
    </View>
  );
}

/** `what`: its input's title, an MCP tool's own words ("search jira issues"). */
function ToolDetail({ keep, name, what, input, output, failed }: { keep: string; name: string; what: string; input: string; output: string; failed: boolean }) {
  return (
    <View style={{ gap: 4 }}>
      {failed && <ErrorLine error={`${name} failed.`} />}
      {input ? <Box title={what}><Capped keep={`${keep}:in`} text={input} /></Box> : null}
      {output ? <Box title="Output"><Capped keep={`${keep}:out`} text={output} /></Box> : !failed && <Text style={[s.row, { color: color.mutedForeground }]}>Tool returned no content</Text>}
    </View>
  );
}

/** A `!` command the user ran [D316]: as a command's row; Stop and Open in terminal are the Mac's. */
export function ShellRow({ item }: { item: Extract<Item, { kind: "shell" }> }) {
  return (
    <View>
      <ToolRow keep={item.id} kind="run" name="" input={item.command} output={item.output} progress={item.progress} exitCode={item.exitCode} line={item.command} />
      {item.error ? <Text style={[s.row, { color: color.destructive, paddingLeft: 24 }]}>{item.error}</Text> : null}
    </View>
  );
}

const st = StyleSheet.create({
  under: { paddingLeft: 24, paddingTop: 4 },
  shell: { gap: 6, marginTop: 4, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: color.fill, backgroundColor: color.fill, padding: 8 },
});
