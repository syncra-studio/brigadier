import { Tabs as BaseTabs } from "@base-ui/react/tabs";

import { cx } from "./cx";

type ClassName = { className?: string };

/** Tabs (side by side only, as the old app used them): a row of pills on a muted track, each showing its panel. Arrow keys move between them. */
export function Tabs({ className, ...props }: Omit<BaseTabs.Root.Props, "className"> & ClassName) {
  return <BaseTabs.Root data-slot="tabs" className={cx("flex flex-col gap-2", className)} {...props} />;
}

export function TabsList({ className, ...props }: Omit<BaseTabs.List.Props, "className"> & ClassName) {
  return (
    <BaseTabs.List
      data-slot="tabs-list"
      className={cx(
        "inline-flex h-control-md w-fit items-center justify-center rounded-control bg-muted p-0.5 text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TabsTrigger({ className, ...props }: Omit<BaseTabs.Tab.Props, "className"> & ClassName) {
  return (
    <BaseTabs.Tab
      data-slot="tabs-trigger"
      className={cx(
        "relative inline-flex h-full flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-control border border-transparent px-2",
        "text-sm font-medium whitespace-nowrap text-muted-foreground transition-all hover:text-foreground focus-visible:focus-ring",
        "data-disabled:cursor-not-allowed data-disabled:opacity-disabled svg:pointer-events-none svg:shrink-0 svg:size-icon-md",
        "data-active:border-input data-active:bg-tab-active data-active:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function TabsContent({ className, ...props }: Omit<BaseTabs.Panel.Props, "className"> & ClassName) {
  return <BaseTabs.Panel data-slot="tabs-content" className={cx("flex-1 outline-none", className)} {...props} />;
}
