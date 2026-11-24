const SHELL = /^(sh|bash|zsh|shell|console)$/i;

/** Given a text's lines in turn, the language of the fence each opens or is inside, a quote's too; null outside code. */
export function fenceWalk(): (line: string) => string | null {
  let mark = "";
  let language = "";
  let depth = 0;
  return (line) => {
    const quotes = /^(?:\s*>)*/.exec(line)![0].split(">").length - 1;
    // A quote's end closes the fence in it.
    if (quotes < depth) mark = "";
    if (!mark) depth = quotes;
    // Inside a fence, a `>` past its own quote's is code.
    const fence = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(line.split(">").slice(depth).join(">"));
    if (fence && !mark) [mark, language] = [fence[1]!, fence[2]!];
    else if (fence && fence[1]!.startsWith(mark) && !fence[2]) mark = "";
    return mark ? language : null;
  };
}

/**
 * A reply's shape, repaired where agents slip, so the prompt needn't spell it out [D525, D529, D530]: a shell
 * block's `$ ` prompts go, only the first warning stays a callout, a `#` or `##` heading reads as `###`, and a
 * line that starts in bold reads plain.
 */
export function tidy(text: string): string {
  const codeAt = fenceWalk();
  let warned = false;
  return text
    .split("\n")
    .map((line) => {
      const language = codeAt(line);
      if (language !== null) return SHELL.test(language) ? line.replace(/^(\s*)\$ /, "$1") : line;
      if (/^\s*>\s*\[!(WARNING|CAUTION)\]/.test(line)) {
        if (warned) return line.replace(/\[!(WARNING|CAUTION)\]\s*/, "");
        warned = true;
        return line;
      }
      return line.replace(/^#{1,2} /, "### ").replace(/^\*\*([^*\n]+)\*\*/, "$1");
    })
    .join("\n");
}
