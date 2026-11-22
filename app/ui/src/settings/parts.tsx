import { type ReactNode, useEffect, useId, useRef } from "react";

import { cx } from "../components/cx";
import { ScrollFade } from "../components/scroll-fade";

/*
 * The parts every Settings page is built from, the old app's: a page (its title, an optional line and
 * actions, then its sections in a centred column) and a section (a heading over its cards). Cards and
 * rows are the kit's SettingsCard and SettingsRow.
 */

/**
 * A Settings page: its title, then its sections. A page that scrolls its own list passes `scrollable={false}`. `mark`
 * sits before the title (an agent's). No breadcrumb: the nav's highlighted row and the title say where you are [D255].
 */
export function SettingsPage({
  title,
  description,
  mark,
  actions,
  scrollable = true,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  mark?: ReactNode;
  actions?: ReactNode;
  scrollable?: boolean;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // A page opened from the nav takes focus on its title, unless something else kept it.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === document.body) heading.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div data-slot="settings-page" className="flex h-full min-h-0 min-w-0 flex-1 flex-col">
      {/* From the window's top: the page scrolls under the titlebar's row and off the window, the title starting below
          the row as before [D292]. */}
      <div className="relative -mt-tab-bar flex min-h-0 flex-1 flex-col">
        <div className={cx("min-h-0 flex-1", scrollable ? "overflow-y-auto scroll-gutter" : "flex flex-col overflow-hidden")}>
          <div className={cx("mx-auto flex w-full max-w-settings flex-col px-5 pt-page-top", scrollable ? "pb-12" : "min-h-0 flex-1")}>
            <header className="flex shrink-0 items-start gap-4 py-3">
              <div className="flex min-w-0 flex-1 items-center gap-3.5">
                {mark}
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h1 ref={heading} tabIndex={-1} className="text-page-title font-medium outline-none">
                    {title}
                  </h1>
                  {description && <div className="text-sm text-quiet-foreground">{description}</div>}
                </div>
              </div>
              {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
            </header>
            <div className={cx("flex flex-col", scrollable ? "gap-10 pt-5" : "min-h-0 flex-1")}>{children}</div>
          </div>
        </div>
        {scrollable && <ScrollFade side="top" />}
        {scrollable && <ScrollFade />}
        {/* The titlebar's row drags the window, as the tab bar does elsewhere, over what scrolls under it [D255]. */}
        <div className="app-drag absolute inset-x-0 top-0 z-10 h-tab-bar" />
      </div>
    </div>
  );
}

/**
 * A heading over one or more cards, with an optional line, a grey note and actions at its end. `setting`
 * is the name Settings search brings into view.
 */
export function SettingsSection({
  title,
  icon,
  description,
  aside,
  actions,
  setting,
  children,
  className,
}: {
  title?: string;
  icon?: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  actions?: ReactNode;
  setting?: string;
  children: ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <section aria-labelledby={title ? id : undefined} data-setting={setting} className={cx("flex flex-col", className)}>
      {(title || aside || actions) && (
        <div className="flex min-h-11.5 items-center justify-between gap-4 pb-1.5">
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            {title && (
              <h2 id={id} className="flex min-w-0 items-center gap-2 text-sm font-medium">
                {icon}
                <span className="truncate">{title}</span>
              </h2>
            )}
            {description && <p className="text-label text-quiet-foreground">{description}</p>}
          </div>
          {aside && <div className="flex items-center gap-1 text-label text-quiet-foreground">{aside}</div>}
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="flex flex-col gap-1.5">{children}</div>
    </section>
  );
}
