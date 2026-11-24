/** The `!` commands running in view, oldest first: Ctrl+C in an empty composer stops the newest only [D320]. */
export const running: string[] = [];

/** Whether a key in an empty composer stops a running `!` command [D320]. */
export function isStopKey(event: KeyboardEvent): boolean {
  const field = (event.target as Element | null)?.closest?.("[data-slot=composer-field] [contenteditable]");
  // Not ⌘.: the composer's model picker has it.
  return event.ctrlKey && !event.metaKey && event.key === "c" && Boolean(field) && !field!.textContent?.trim();
}
