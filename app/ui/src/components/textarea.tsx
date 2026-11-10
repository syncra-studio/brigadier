import type { ComponentProps, ReactNode } from "react";

import { cx } from "./cx";

/**
 * Input's look over several lines [D1100]: one line tall, growing with its text (or its placeholder) up to the old
 * commit box's cap, then scrolling. Its corner is the surface's, as a capsule doesn't hold a paragraph. `end`: a small
 * icon button held in its top end corner. Fills its container's width: size it by its container.
 */
export function Textarea({ end, ...props }: Omit<ComponentProps<"textarea">, "className"> & { end?: ReactNode }) {
  return (
    <div data-slot="textarea" className="relative min-w-0">
      <textarea
        rows={1}
        className={cx(
          "block max-h-40 w-full min-w-0 resize-none rounded-surface border border-transparent bg-fill py-1.5 ps-3 text-sm field-sizing-content input-focus",
          "placeholder:text-muted-foreground focus-visible:bg-background focus-visible:focus-ring",
          "cursor-text disabled:cursor-not-allowed disabled:bg-input-disabled disabled:opacity-disabled",
          end ? "pe-8" : "pe-3",
        )}
        {...props}
      />
      {end && <div className="absolute end-1 top-1 flex">{end}</div>}
    </div>
  );
}
