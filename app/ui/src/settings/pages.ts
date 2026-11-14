import type { ComponentType } from "react";

import { PROVIDERS_ROWS, ProvidersPage } from "../accounts/providers";
import { Archive, Branch, type IconProps, KeyboardShortcut, RobotHead, SettingsCog, SettingsSlider, Shuffle } from "../icons";
import { ARCHIVED_ROWS, ArchivedPage } from "./archived";
import { CONFIGURATION_ROWS, ConfigurationPage } from "./configuration";
import { GENERAL_ROWS, GeneralPage } from "./general";
import { GIT_ROWS, GitPage } from "./git";
import { ROUTING_ROWS, RoutingSettings } from "./routing";
import { SHORTCUTS_ROWS, ShortcutsPage } from "./shortcuts";

/**
 * The pages of Settings, the old app's cut down [D2004, D2022], in the order the nav lists them. A page's rows
 * (label and line) are what Settings search finds; each page exports the words it draws, so the two never drift.
 */

/** A row search finds; `section` is the part of the page it sits in. */
export type SettingsRowCopy = { readonly label: string; readonly description?: string; readonly section?: string };

/** A group of the nav; "end" is the last, set apart by its gap alone. */
type SettingsGroup = "Personal" | "Agents" | "end";

export type SettingsPageId = "general" | "configuration" | "shortcuts" | "providers" | "routing" | "git" | "archived";

type SettingsPageEntry = {
  id: SettingsPageId;
  label: string;
  /** Names it went by, which search still finds it under. */
  formerly?: readonly string[];
  icon: ComponentType<IconProps>;
  group: SettingsGroup;
  /** `detail` is what follows the page in its route (an agent, under Providers). */
  component: ComponentType<{ detail?: string }>;
  rows: readonly SettingsRowCopy[];
};

export const SETTINGS_GROUPS: readonly SettingsGroup[] = ["Personal", "Agents", "end"];

export const SETTINGS_PAGES: readonly SettingsPageEntry[] = [
  { id: "general", label: "General", icon: SettingsCog, group: "Personal", component: GeneralPage, rows: Object.values(GENERAL_ROWS) },
  { id: "configuration", label: "Configuration", icon: SettingsSlider, group: "Personal", component: ConfigurationPage, rows: Object.values(CONFIGURATION_ROWS) },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: KeyboardShortcut, group: "Personal", component: ShortcutsPage, rows: SHORTCUTS_ROWS },
  { id: "providers", label: "Providers", formerly: ["Accounts", "Usage", "Switching"], icon: RobotHead, group: "Agents", component: ProvidersPage, rows: Object.values(PROVIDERS_ROWS) },
  { id: "routing", label: "Routing", formerly: ["Who does what"], icon: Shuffle, group: "Agents", component: RoutingSettings, rows: [ROUTING_ROWS.rows, ROUTING_ROWS.review, ROUTING_ROWS.rules, ROUTING_ROWS.results] },
  { id: "git", label: "Git", icon: Branch, group: "Agents", component: GitPage, rows: Object.values(GIT_ROWS) },
  { id: "archived", label: "Archived", icon: Archive, group: "end", component: ArchivedPage, rows: Object.values(ARCHIVED_ROWS) },
];

/** The page a route names (`providers/<agent>` is Providers). */
export function settingsPage(route: string): SettingsPageEntry {
  const id = route.split("/")[0];
  return SETTINGS_PAGES.find((page) => page.id === id) ?? SETTINGS_PAGES[0]!;
}

export type SettingsSearchResult = { page: SettingsPageEntry; row: SettingsRowCopy | null };

/** Pages, then rows, whose words hold every word of the query. */
export function searchSettings(query: string): SettingsSearchResult[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word));
  return [
    ...SETTINGS_PAGES.filter((page) => matches([page.label, ...(page.formerly ?? [])].join(" "))).map((page) => ({ page, row: null })),
    ...SETTINGS_PAGES.flatMap((page) => page.rows.filter((row) => matches(`${row.label} ${row.description ?? ""} ${row.section ?? ""}`)).map((row) => ({ page, row }))),
  ];
}
