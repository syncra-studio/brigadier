---
name: kit
description: Create or port a Brigadier UI component (kit part, thread row, gallery row) from the old app, following the owner's kit decisions. Use when adding, porting or restyling any component in app/ui.
---

# Kit components

How slices 1–4 were built. AGENTS.md binds over all of this.

## 1. What to build

- The reference is the old app, `~/Development/brigadier-ai`. It's read-only: use `git -C ~/Development/brigadier-ai show origin/main:<path>` and `git grep`. Never check it out, build it or run it.
- Make an inventory of what the old screens really use, and rebuild only that, with its exact sizes, colours, radii and motion. Where the old code is inconsistent, pick the variant used most and list the choice for the owner.
- A piece fed by a backend that isn't designed yet waits for its feature. Don't guess its data.

## 2. Stack and API

- Use Base UI (`@base-ui/react`) as thin styled parts: each part gets our look, and feature code composes them (`<Menu><MenuTrigger/><MenuItem/>…`). Keyboard and screen-reader behaviour come from Base UI.
- Don't use Radix, assistant-ui, styled kits, cva or tailwind-merge. Instead of Slot, use Base UI's `render` prop.
- `cx` (`components/cx.ts`) only joins classes, it doesn't merge them. Set each property once: never set it in both the base and a variant, or the base and the caller. Size an input by its wrapper, or offer a size prop.
- No inline styles. Write no `style=` or `.style`. For a runtime value, set a data attribute and read it in CSS with `attr()`.
- No bracket values or variants (`w-[3px]`, `data-[x=y]:`) and no opacity suffixes (`bg-foreground/8`). `scripts/limits` fails on them.
- Keep files under the 500-line limit. Split by area, as `icons/thread.tsx` was.

## 3. Theme

- Use only named tokens from `app/ui/src/theme.css`.
- For a gap, take the old app's exact value and add it as a named role token (`--color-diff-added`, `--radius-bubble`). A fill within 1% of an existing token reuses that token.
- Anything that isn't a straight copy of an old value goes to the owner first. That includes new colours, new motion and redesigns.
- Where Tailwind would need brackets, add an `@utility` helper in theme.css (`focus-ring`, `dialog-card`, `shimmer`). For a state, add an `@custom-variant`.
- The theme resets every Tailwind default (`--*: initial`), so `rounded-md`, `leading-relaxed`, `duration-200` and the default colours don't exist. Fractions (`max-w-7/10`) and spacing steps (`size-5.25`) still work.
- Theme keys that work: `--opacity-*`, `--scale-*`, `--z-index-*`, `--tracking-*`, `--ease-*`, `--default-transition-*`. There's no `duration-*` key: use named `--duration-*` inside a utility.
- `outline-none` sets the outline style to none, so `outline-3` also needs `outline-solid`. A custom `@utility` is generated only where it's used.

## 4. The owner's standing looks

- Pointing-hand cursor on everything clickable, text cursor in inputs, not-allowed when disabled (D16).
- When pressed, text buttons shrink to 95% (`active:scale-press-button`) and icon buttons to 90% (`scale-press`), over 150ms, and only with `motion-safe:` (D17, D26).
- Destructive is solid Apple red `rgb(255 66 69)` with near-white text; its soft variant is a light red wash (D24, D30). Warning amber, success green and link blue stay the old app's (D25).
- Ghost icon buttons use `rounded-control` (8px). Smaller sizes keep the same corner-to-size ratio, so none looks like a pill (D27–D29).
- Inputs are capsules (`rounded-capsule`). Kbd keys, and the key chip inside a button, use the checkbox's 5px corner (D31–D33).
- Dialogs use Apple's card (`dialog-card`, blurred `bg-material`, `shadow-material`) with our text, buttons and ✕ inside. Confirm dialogs keep our layout (D46, D48, D51).
- Menus, popover, select, toast and spinner keep the old look (D44, D45, D47).
- Every focusable shows `focus-visible:focus-ring`.
- A row keeps its hover look while the pointer is on an icon inside it. The icon gets its own hover on top (D62).
- Notices go in the composer strip. There's no Banner (D64).
- Every error line in the kit is drawn by `ErrorLine`, so all errors look the same. An errored user bubble is an `ErrorLine` on one line with an ⓘ tooltip for the whole reason and Try again, and Discard is a trash icon in its always-visible actions row (D87, D88).
- Text in a checkbox row is centred vertically on the box (D61). Settings keep the old look (D68).
- Thread rows: a turn's work header shows "worked/waited for" (D73, D76). Approval reads like a question: "Asking for approval · waiting / denied / allowed" (D75). A running subagent stands out with a spinner, a ticking timer and its current step shimmering (D77). Wording is assuring and commanding, never alarming: "Saving context · nothing will be lost" (D78).

## 5. Icons

- Copy them from `@openai/apps-sdk-ui` 0.2.2 (MIT, credited in `THIRD_PARTY_NOTICES.md`). Never use brand icons.
- To add some:
  1. Fetch the package into a scratch dir: `npm pack @openai/apps-sdk-ui@0.2.2`, then untar it.
  2. Each icon is at `package/dist/es/components/Icon/svg/<Name>.js`, as compiled JSX: copy its `viewBox` and each `_jsx("path", { d, fillRule, … })` as a `<path>`.
  3. Write it as a local component, shaped like the ones in `app/ui/src/icons/`: `width/height="1em"`, `fill="currentColor"`, `aria-hidden`, `{...props}`, and props typed `IconProps`.
  4. Use the old app's icon name. Put general icons in `icons/index.tsx` and thread icons in `icons/thread.tsx` (re-exported).
  5. Delete the scratch dir.

## 6. Thread rows

- Rows draw only the types in `app/ui/src/thread/item.ts`. Rust folds events, so no thread logic goes in TS.
- A missing field shows nothing, or a plain fallback ("Used x", no times). Never guess it.
- Expand and fold are view state (`useKept`), not data.
- Restyle the thread run's markdown and code renderers (`thread/markdown.tsx`, `thread/code.tsx`, `highlight.ts`), but never rewrite them. They're tuned for speed: lazy highlighting, and only the lines shown are drawn.
- Tell the thread run before you change `thread/rows.tsx` props or `item.ts`.

## 7. Gallery

- Every component gets a row in `app/ui/gallery/` showing each state side by side, frozen, plus one live copy (`Row`, `State`, `Held` in `parts.tsx`).
- `State frozen="hover focus active"` holds those states still through `data-frozen` custom variants in `gallery.css`. Frozen popups need `Held` as their container, plus `collisionAvoidance={{side:"none",align:"none"}}`. Dialogs also need `initialFocus={false}` and `modal={false}`.
- Run `pnpm gallery` (`scripts/gallery`). It rebuilds on save and the window reloads itself, keeping its scroll place.
- During review, compare columns ("Current | Old app", sometimes "Apple style" or "Proposed") show the options. Remove them, and any old-app utilities, before landing.
- Gallery code never ships. To check: `node_modules/.bin/vite build app/ui --outDir /tmp/<run>-<wid>-dist --emptyOutDir`, then grep its assets for `data-frozen|build-id|old-app` (expect none), then delete the dir. Don't build into `app/ui/dist` while a gallery runs.
- For a layout check without the screen, run `pnpm gallery --remote-debugging-port=<port>`. Then, from a small Node CDP script, set `scrollTop` on `.overflow-y-auto` in the iframe's document and call `Page.captureScreenshot`.

## 8. Flow

1. Inventory the old app, then write a short outline: parts, states, tokens to add.
2. Build, then run `pnpm typecheck`.
3. Get one Codex code review of the slice.
4. Ask before opening any window. Take the screen lock `/tmp/brigadier-screen.lock` only while it's absent, write your name and an end time into it, and delete it when done.
5. Demo with the owner component by component: questions in rounds of up to 4 (AskUserQuestion), each answered "like" or "change". Make changes live in the open gallery.
6. On approval: remove the compare columns, run `pnpm typecheck`, do the bundle check, run `scripts/limits` once, rebase on `origin/main`, push to main, and watch CI.
7. Kill only PIDs you started. Never use `pkill` or `killall`.
