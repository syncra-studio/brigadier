// Mockup only: Project settings' Name row, its icon a button that opens a picker (variant A): the folder's logo or
// initials as now, initials on a colour, an emoji, or an image you choose. Fake project, kept in memory. ?v=real is the
// real Project settings page on a fake project kept in memory (an image needs the app, which copies it in). Not the app.
import "../src/theme.css";
import "../src/note/page.css";
import "./fixtures.css";

import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { Button } from "../src/components/button";
import { cx } from "../src/components/cx";
import { TooltipIconButton } from "../src/components/icon-button";
import { Input } from "../src/components/input";
import { Popover, PopoverContent, PopoverTrigger } from "../src/components/popover";
import { ImageSquare } from "../src/icons/tab";
import { Undo } from "../src/icons/thread";
import { ProjectBadge } from "../src/sidebar/row";
import { hueOf, projectInitials } from "../src/sidebar/words";
import type { Project } from "../src/daemon";
import { ProjectSettings, type SettingsSource } from "../src/projects/settings";

type Icon = { kind: "auto" } | { kind: "colour"; tag: number } | { kind: "emoji"; emoji: string } | { kind: "image"; src: string };

// The sidebar's tile colours, in its order (sidebar/row.tsx).
const TAGS = ["bg-tile-coral", "bg-tile-mint", "bg-tile-sunflower", "bg-tile-violet", "bg-tile-sky", "bg-tile-tangerine", "bg-tile-lime", "bg-tile-pink", "bg-tile-periwinkle", "bg-tile-rose"];
const NAMES = ["Coral", "Mint", "Sunflower", "Violet", "Sky", "Tangerine", "Lime", "Pink", "Periwinkle", "Rose"];
const EMOJI = [
  "🚀", "⭐", "🔥", "💡", "🎯", "🧪", "🛠️", "⚙️",
  "📦", "📚", "📝", "📈", "💬", "🔒", "🌍", "🏠",
  "🐛", "🧩", "🧭", "🎨", "🎵", "🌱", "🍀", "☕",
  "🦊", "🐙", "🐳", "🦄", "🍎", "⚡", "❤️", "🙂",
];

/** The project's icon at `size`, as the sidebar would draw it. */
function ProjectIcon({ icon, name, size }: { icon: Icon; name: string; size: string }) {
  const tile = cx("flex shrink-0 items-center justify-center overflow-hidden rounded-badge", size);
  if (icon.kind === "auto") return <ProjectBadge id="mockup-no-logo" name={name} size={size} />;
  if (icon.kind === "image") return <img aria-hidden alt="" src={icon.src} className={cx(tile, "object-cover")} />;
  if (icon.kind === "emoji") return <span aria-hidden className={cx(tile, "bg-fill leading-none")}>{icon.emoji}</span>;
  return <span aria-hidden className={cx(tile, "font-bold text-tile-ink", TAGS[icon.tag])}>{projectInitials(name)}</span>;
}

const Heading = ({ children }: { children: string }) => <p className="px-1 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">{children}</p>;

/** The picker: colours, then emoji, then an image of your own; back to the folder's logo or initials at the foot. */
function IconPicker({ icon, name, onChange, defaultOpen }: { icon: Icon; name: string; onChange: (icon: Icon) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen ?? false);
  const file = useRef<HTMLInputElement>(null);
  const pick = (next: Icon) => {
    onChange(next);
    setOpen(false);
  };
  const auto = hueOf(name, TAGS.length);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<TooltipIconButton tooltip="Change icon" size="icon-md" className="aria-expanded:bg-fill" />}>
        <ProjectIcon icon={icon} name={name} size="size-5 text-badge" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <Heading>Colour</Heading>
        <div role="listbox" aria-label="Colours" className="mb-2 grid grid-cols-10 gap-0.5">
          {TAGS.map((tag, index) => (
            <button
              key={tag}
              type="button"
              role="option"
              aria-label={NAMES[index]}
              aria-selected={icon.kind === "colour" ? icon.tag === index : icon.kind === "auto" && index === auto}
              className="flex size-6.5 items-center justify-center rounded-control hover:bg-fill focus-visible:focus-ring aria-selected:bg-fill"
              onClick={() => pick({ kind: "colour", tag: index })}
            >
              <ProjectIcon icon={{ kind: "colour", tag: index }} name={name} size="size-4.5 text-badge" />
            </button>
          ))}
        </div>
        <Heading>Emoji</Heading>
        <div role="listbox" aria-label="Emoji" className="note-emoji-grid">
          {EMOJI.map((emoji) => (
            <button key={emoji} type="button" role="option" aria-label={emoji} aria-selected={icon.kind === "emoji" && icon.emoji === emoji} className="note-emoji-choice" onClick={() => pick({ kind: "emoji", emoji })}>
              {emoji}
            </button>
          ))}
        </div>
        <div className="mt-1 flex items-center gap-1 border-t border-divider pt-2">
          <Button size="sm" variant="ghost" onClick={() => file.current?.click()}>
            <ImageSquare />
            Choose image…
          </Button>
          {icon.kind !== "auto" && (
            <Button size="sm" variant="ghost" className="ms-auto" onClick={() => pick({ kind: "auto" })}>
              <Undo />
              Use folder's
            </Button>
          )}
        </div>
        <input
          ref={file}
          hidden
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp,image/gif"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            if (chosen) pick({ kind: "image", src: URL.createObjectURL(chosen) });
          }}
        />
      </PopoverContent>
    </Popover>
  );
}

/** The Name row as Project settings draws it, its icon now the picker's button. */
function VariantA() {
  const [name, setName] = useState("billing");
  const [icon, setIcon] = useState<Icon>({ kind: "auto" });
  const line = icon.kind === "auto" ? "What the sidebar and this page call it; its icon is the folder's logo, else these initials — click it to pick another" : "What the sidebar and this page call it; click its icon to change it";
  return (
    <div className="mx-auto max-w-3xl px-5 pt-10">
      <ul aria-label="General">
        <li className="border-b border-divider">
          <div className="flex min-h-12 items-center gap-x-6 px-2 py-2.5 text-sm">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="font-medium text-foreground">Name</span>
              <span className="text-xs text-muted-foreground">{line}</span>
            </div>
            <div className="flex w-80 shrink-0 items-center justify-end gap-2">
              <IconPicker icon={icon} name={name} onChange={setIcon} defaultOpen={new URLSearchParams(location.search).has("open")} />
              <Input aria-label="Name" value={name} spellCheck={false} onChange={(event) => setName(event.target.value)} />
            </div>
          </div>
        </li>
      </ul>
      {/* Where it shows: the sidebar's project row. */}
      <div className="mt-10 w-60 rounded-surface bg-sidebar p-2 text-sm">
        <div className="flex h-8 items-center gap-2 rounded-control px-2 text-foreground">
          <ProjectIcon icon={icon} name={name} size="size-icon-md text-badge" />
          <span className="truncate">{name}</span>
        </div>
      </div>
    </div>
  );
}

/** The real Project settings page, saving to a fake project in memory as Rust would keep it. */
function Real() {
  const [project, setProject] = useState<Project>({ id: "p1", name: "billing", folder: "/Users/sam/Development/work/billing", trusted: true, setup: "pnpm install", include: [".env.local"], added: 0, branch_prefix: "brigadier/" });
  const source: SettingsSource = {
    pick: async () => null,
    check: async () => ({ kind: "invalid", reason: "" }),
    save: async (_, change, args) => {
      const icon = args[0] === "--icon" ? args[1]! : undefined;
      if (icon?.startsWith("image:")) throw new Error("An image is copied in by the app; here, pick a colour or an emoji.");
      setProject((now) => ({ ...now, ...change, ...(icon !== undefined && { icon: icon || null }) }));
    },
    repos: async () => [],
    accounts: async () => ({ github: false, auto: null, logins: [] }),
  };
  return (
    <div className="flex h-screen">
      <div className="w-60 shrink-0 bg-sidebar p-2 text-sm">
        <div className="flex h-8 items-center gap-2 rounded-control px-2 text-foreground">
          <ProjectBadge id={project.id} name={project.name} icon={project.icon} />
          <span className="truncate">{project.name}</span>
        </div>
      </div>
      <ProjectSettings project={project} source={source} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(new URLSearchParams(location.search).get("v") === "real" ? <Real /> : <VariantA />);
