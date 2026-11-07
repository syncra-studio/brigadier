import { Collapsible as BaseCollapsible } from "@base-ui/react/collapsible";

import { cx } from "./cx";

/** Content its trigger shows and hides. */
export const Collapsible = BaseCollapsible.Root;
export const CollapsibleTrigger = BaseCollapsible.Trigger;

/** What folds: its height and opacity ease open and shut over 300ms (none with Reduce Motion). */
export function CollapsibleContent({ className, ...props }: Omit<BaseCollapsible.Panel.Props, "className"> & { className?: string }) {
  return <BaseCollapsible.Panel data-slot="collapsible-content" className={cx("collapsible-motion", className)} {...props} />;
}
