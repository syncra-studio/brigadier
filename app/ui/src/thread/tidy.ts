const SHELL = /^(sh|bash|zsh|shell|console)$/i;

/**
 * A reply's shape, repaired where agents slip, so the prompt needn't spell it out [D525, D529, D530]: a shell
 * block's `$ ` prompts go, only the first warning stays a callout, a `#` or `##` heading reads as `###`, and a
 * line that starts in bold reads plain.
 */
export function tidy(text: string): string {
  let open = "";
  let language = "";
  let warned = false;
  return text
    .split("\n")
    .map((line) => {
      const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line);
      if (fence && !open) [open, language] = [fence[1]!, fence[2]!];
      else if (fence && fence[1]!.startsWith(open) && !fence[2]) open = "";
      if (fence) return line;
      if (open) return SHELL.test(language) ? line.replace(/^(\s*)\$ /, "$1") : line;
      if (/^\s*>\s*\[!(WARNING|CAUTION)\]/.test(line)) {
        if (warned) return line.replace(/\[!(WARNING|CAUTION)\]\s*/, "");
        warned = true;
        return line;
      }
      return line.replace(/^#{1,2} /, "### ").replace(/^\*\*([^*\n]+)\*\*/, "$1");
    })
    .join("\n");
}
