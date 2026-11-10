import { Info } from "../../icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "../tooltip";

/** An ⓘ whose tooltip says the rest, on hover or focus. */
export function InfoTip({ text }: { text: string }) {
  return (
    // Centred on the capitals of the line it sits on.
    <span className="ms-1.5 w-icon-sm cap-box">
      <Tooltip>
        <TooltipTrigger
          render={
            <span role="img" tabIndex={0} aria-label={text} className="flex rounded-control hover:text-foreground focus-visible:focus-ring">
              <Info className="size-icon-sm" />
            </span>
          }
        />
        <TooltipContent>{text}</TooltipContent>
      </Tooltip>
    </span>
  );
}

/** Words, then an ⓘ that never wraps onto a line alone: it holds to the last word. */
export function WithTip({ words, tip }: { words: string; tip: string }) {
  const cut = words.lastIndexOf(" ") + 1;
  return (
    <span>
      {words.slice(0, cut)}
      <span className="whitespace-nowrap">
        {words.slice(cut)}
        <InfoTip text={tip} />
      </span>
    </span>
  );
}
