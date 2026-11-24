import "../note/page.css";

import { useRef, useState } from "react";

import { Button } from "../components/button";
import { TooltipIconButton } from "../components/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "../components/popover";
import { ImageSquare } from "../icons/tab";
import { Undo } from "../icons/thread";
import { ProjectBadge, TAGS } from "../sidebar/row";
import { hueOf } from "../sidebar/words";

const NAMES = ["Coral", "Mint", "Sunflower", "Violet", "Sky", "Tangerine", "Lime", "Pink", "Periwinkle", "Rose"];
const EMOJI = [
  "🚀", "⭐", "🔥", "💡", "🎯", "🧪", "🛠️", "⚙️",
  "📦", "📚", "📝", "📈", "💬", "🔒", "🌍", "🏠",
  "🐛", "🧩", "🧭", "🎨", "🎵", "🌱", "🍀", "☕",
  "🦊", "🐙", "🐳", "🦄", "🍎", "⚡", "❤️", "🙂",
];

const Heading = ({ children }: { children: string }) => <p className="px-1 pt-1 pb-1.5 text-xs font-medium text-muted-foreground">{children}</p>;

/**
 * The project's icon beside its Name, a button that opens its picker: initials on a colour, an emoji, or an image of
 * your own, and back to the folder's logo or initials at the foot. `onChange` gets Rust's icon: `tag:<n>`, `emoji:<it>`,
 * `image:<path>` (copied in by Rust), or "".
 */
export function IconPicker({ id, name, icon, onChange, defaultOpen = false }: { id: string; name: string; icon?: string | null; onChange: (icon: string) => void; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const file = useRef<HTMLInputElement>(null);
  const pick = (next: string) => {
    onChange(next);
    setOpen(false);
  };
  const shown = icon ?? `tag:${hueOf(name, TAGS.length)}`;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<TooltipIconButton tooltip="Change icon" size="icon-md" className="aria-expanded:bg-fill" />}>
        <ProjectBadge id={id} name={name} icon={icon} size="size-5 text-badge" />
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
              aria-selected={shown === `tag:${index}`}
              className="flex size-6.5 items-center justify-center rounded-control hover:bg-fill focus-visible:focus-ring aria-selected:bg-fill"
              onClick={() => pick(`tag:${index}`)}
            >
              <ProjectBadge name={name} icon={`tag:${index}`} size="size-4.5 text-badge" />
            </button>
          ))}
        </div>
        <Heading>Emoji</Heading>
        <div role="listbox" aria-label="Emoji" className="note-emoji-grid">
          {EMOJI.map((emoji) => (
            <button key={emoji} type="button" role="option" aria-label={emoji} aria-selected={icon === `emoji:${emoji}`} className="note-emoji-choice" onClick={() => pick(`emoji:${emoji}`)}>
              {emoji}
            </button>
          ))}
        </div>
        <div className="mt-1 flex items-center gap-1 border-t border-divider pt-2">
          <Button size="sm" variant="ghost" onClick={() => file.current?.click()}>
            <ImageSquare />
            Choose image…
          </Button>
          {icon && (
            <Button size="sm" variant="ghost" className="ms-auto" onClick={() => pick("")}>
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
            event.target.value = "";
            // Rust copies it in from where it is on this Mac.
            const path = chosen && window.brigadier?.pathForFile(chosen);
            if (path) pick(`image:${path}`);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
