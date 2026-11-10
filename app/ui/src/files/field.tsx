import type { ComponentProps, KeyboardEvent, ReactNode, Ref } from "react";

import { cx } from "../components/cx";
import { Search } from "../icons";

/** Typing here is code and paths: no spelling, case or completion help. */
export const PLAIN_FIELD = { spellCheck: false, autoCorrect: "off", autoCapitalize: "off", autoComplete: "off" } as const;

/**
 * The panel's search field, as the old app's outlined one [D1058]: a magnifier (or `icon`), the input, and
 * trailing `children` (Search's toggles). `tight` holds those buttons close to the end.
 */
export function PanelField({
  label,
  value,
  onChange,
  onKeyDown,
  icon,
  tight = false,
  inputRef,
  children,
  ...input
}: Omit<ComponentProps<"input">, "value" | "onChange" | "onKeyDown" | "children" | "className" | "ref"> & {
  /** The input's name, and its placeholder unless one is given. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
  /** In place of the magnifier; `null` for none. */
  icon?: ReactNode;
  tight?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  children?: ReactNode;
}) {
  // With buttons inside, the box is a plain box, not a label, so their names stay their own.
  const Box = children ? "div" : "label";
  return (
    <Box
      data-slot="panel-field"
      className={cx(
        "flex h-control-md min-w-0 items-center rounded-control border border-border focus-within:border-ring",
        tight ? "gap-0.5 ps-2 pe-0.5" : "gap-1.5 px-2",
      )}
    >
      {icon === undefined ? <Search aria-hidden className="size-icon-md shrink-0 text-muted-foreground" /> : icon}
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={label}
        aria-label={label}
        {...PLAIN_FIELD}
        className="min-w-0 flex-1 cursor-text bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        {...input}
      />
      {children}
    </Box>
  );
}
