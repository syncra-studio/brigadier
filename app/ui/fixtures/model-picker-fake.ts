// Mockup only: the model picker's fake agents, models and limits (model-picker.tsx). Not the app.
import claude from "../../../crates/core/src/adapters/claude/claude.svg?raw";
import codex from "../../../crates/core/src/adapters/codex/codex.svg?raw";
import opencode from "../../../crates/core/src/adapters/opencode/opencode.svg?raw";
import type { Model, ModelGroup } from "../src/components/composer/model-picker";

const HOUR = 3_600_000;
export const NOW = Date.now();
const FULL = ["low", "medium", "high", "xhigh", "max"];
const FAST = "About 1.5x the speed, uses your plan faster";
const model = (id: string, name: string, more: Partial<Model> = {}): Model => ({ id, name, efforts: FULL, defaultEffort: "high", fast: null, ...more });
const OPEN = ["GLM 5.2", "Kimi K3", "Qwen 4 Coder", "DeepSeek V4", "MiniMax M3", "Grok Code 2", "Devstral 3", "Llama 5 Maverick", "Gemini 3.5 Pro", "Gemini 3.5 Flash", "GPT-6.1 Terra", "Sonnet 5.5", "Haiku 5.5", "Mistral Large 4", "Nova Premier 2", "Command B", "Phi 6", "Gemma 4", "Granite 5", "Hermes 5", "Nemotron 4", "Ernie 6"];

export type Ready = "ready" | "sign-in" | "install";
export const groups = (ready: Ready): ModelGroup[] => [
  {
    provider: "claude", label: "Claude Code", short: "Claude", mark: claude,
    models: [
      model("opus", "Opus 5.5", { fast: FAST }),
      model("fable", "Fable 5.2"),
      model("sonnet", "Sonnet 5.5", { defaultEffort: "medium" }),
      model("haiku", "Haiku 5.5", { efforts: [], defaultEffort: undefined }),
      model("opus-5", "Opus 5", { fast: FAST, legacy: true }),
      model("sonnet-5", "Sonnet 5", { legacy: true }),
    ],
    usage: [
      { account: "", name: "Personal", limits: [{ name: "5-hour", used: 38, resets: NOW + 2.25 * HOUR }, { name: "Weekly", used: 21, resets: NOW + 80 * HOUR }] },
      { account: "work", name: "Work", limits: [{ name: "5-hour", used: 84, resets: NOW + 0.6 * HOUR }] },
    ],
  },
  {
    provider: "codex", label: "Codex", short: "Codex", mark: codex,
    models: [
      model("sol", "GPT-6.2 Sol", { fast: FAST, efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" }),
      model("astra", "GPT-6.2 Astra", { fast: FAST, efforts: ["low", "medium", "high", "xhigh"] }),
      model("terra", "GPT-6.1 Terra", { efforts: ["minimal", "low", "medium", "high"], defaultEffort: "medium" }),
      model("gpt-5.5", "GPT-5.5", { efforts: ["low", "medium", "high"], defaultEffort: "medium", legacy: true }),
    ],
    usage: [{ account: "", name: "Personal", limits: [{ name: "5-hour", used: 12, resets: NOW + 4.1 * HOUR }, { name: "Weekly", used: 55, resets: NOW + 50 * HOUR }] }],
  },
  { provider: "opencode", label: "OpenCode", short: "OpenCode", mark: opencode, unavailable: ready === "ready" ? null : ready, models: ready === "ready" ? OPEN.map((name) => model(name, name, { efforts: ["low", "medium", "high"], defaultEffort: "medium" })) : [], usage: null },
];
