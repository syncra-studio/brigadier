/**
 * Joins class names, skipping the empty ones.
 * shortcut: no merging, so a caller's class can't replace one the component sets (two widths, two
 * colours); components keep each property in one place. Add a merge if callers start needing overrides.
 */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(" ");
}
