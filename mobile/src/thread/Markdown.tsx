// A reply's markdown through the desktop's own pipeline (thread/markdown.tsx: react-markdown, remark-gfm, remark-breaks,
// its refs and callouts), each element drawn as thread/markdown.css draws it, each fence as the card it is [D98, D102].
import { Children, createContext, isValidElement, type ReactElement, type ReactNode, useContext, useState } from "react";
import { Linking, ScrollView, StyleSheet, Text, type TextStyle, View } from "react-native";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { calloutLabel, callouts, calloutWarns, fenceOf, fenceWalk, linkPath, nestUnderItems, type Node, pathOf, remarkRefs, textOf } from "../../../app/shared/markdown";
import { Check, Eye, Info, Warning } from "../../../app/ui/src/icons";
import { color, fontWeight, leading, mono, radius, space, text as type } from "../theme";
import { CodeBlock } from "./Code";
import { RefWord } from "./Refs";
import { Draft, MessageCard, MessageFrame, WritingCard } from "./ReplyCards";

/** Shows an image a reply names by its path on the Mac; none where nothing can (the user's own bubble, a thought). */
export const ViewImage = createContext<((path: string) => void) | null>(null);
const IMAGE = /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?|svg)$/i;
/** The text a block's words take, whether they sit on the user's bubble, and where a fence still being written ends (-1: none). */
const Look = createContext<{ base: TextStyle; bubble: boolean; openEnd: number }>({ base: {}, bubble: false, openEnd: -1 });
/** How deep a list is (a child bullet list draws circles) and the marker of the item being drawn. */
const Depth = createContext(0);
const Marker = createContext("");

/**
 * A code span, markdown.css's px-1.5 each side of it drawn as an unbreakable zero-width mark that wide, as a nested
 * text can't pad; one that is an image's path shows it. Phone-only: square corners, as iOS fills a run of text as a
 * plain box (a view inside the text could round it, but would keep a long path from wrapping with its sentence).
 */
function Code({ text }: { text: string }) {
  const view = useContext(ViewImage);
  const { bubble } = useContext(Look);
  const style = [st.inlineCode, bubble && st.bubbleCode];
  const pad = <Text style={st.codePad}>{"\u2060"}</Text>;
  if (!view || !IMAGE.test(text) || /\s/.test(text.trim())) return <Text style={style}>{pad}{text}{pad}</Text>;
  return (
    <Text style={[style, st.link]} accessibilityRole="link" accessibilityHint="Shows the image" onPress={() => view(text.trim())}>
      {pad}{text}{pad}
    </Text>
  );
}

/** A link that opens in its app; an image's path shows it; a `#section` or any other path can't open on the phone, so it reads as text. */
function Link({ url, children }: { url: string; children: ReactNode }) {
  const view = useContext(ViewImage);
  const web = /^(https?:|mailto:)/i.test(url);
  const path = web ? "" : pathOf(url);
  if (view && IMAGE.test(path)) {
    return (
      <Text style={st.link} accessibilityRole="link" accessibilityHint="Shows the image" onPress={() => view(path)}>
        {children}
      </Text>
    );
  }
  if (url.startsWith("#")) return <Text style={st.link}>{children}</Text>;
  if (!web) return <Text style={st.inlineCode}>{children}</Text>;
  return (
    <Text style={st.link} accessibilityRole="link" accessibilityHint={url} onPress={() => void Linking.openURL(url)}>
      {children}
    </Text>
  );
}
type Tagged = ReactElement<{ node?: Node; className?: string; children?: ReactNode; style?: TextStyle }>;
const tagOf = (child: ReactNode) => (isValidElement(child) ? ((child as Tagged).props.node?.tagName ?? (typeof child.type === "string" ? child.type : undefined)) : undefined);
const elements = (children: ReactNode) => Children.toArray(children).filter(isValidElement) as Tagged[];

// markdown.css's margins, top and bottom, by block: a paragraph's gap, a heading's own, a table's, a code card's.
const PARAGRAPH: [number, number] = [space(3.5), space(3.5)];
const MARGINS: Record<string, [number, number]> = {
  p: PARAGRAPH,
  ul: PARAGRAPH,
  ol: PARAGRAPH,
  blockquote: PARAGRAPH,
  hr: PARAGRAPH,
  section: PARAGRAPH,
  h1: [space(3.5), space(2)],
  h2: [space(3.5), space(2)],
  h3: [space(3.5), space(2)],
  h4: [space(3.5), space(1)],
  h5: [space(3), space(1)],
  h6: [space(3), space(1)],
  table: [space(3), space(3)],
  pre: [space(4.5), space(4.5)],
  // A reply's card, the code card's frame (reply-cards.tsx FRAME).
  card: [space(3), space(3)],
};
const LIST = /^[uo]l$/;
/** The gap between two blocks, as CSS collapses their margins, with markdown.css's exceptions. */
function gap(before: string, after: string, inItem: boolean): number {
  // What follows a heading sits its gap under it.
  if (/^h[1-4]$/.test(before)) return MARGINS[before]![1];
  // A child list sits as close to its item as the next item does; a lead-in line sits on its list.
  const top = inItem && LIST.test(after) ? space(0.5) : before === "p" && LIST.test(after) ? space(1) : (MARGINS[after]?.[0] ?? 0);
  const bottom = before === "p" && LIST.test(after) ? space(1) : (MARGINS[before]?.[1] ?? 0);
  return Math.max(top, bottom);
}

/** Blocks one under another at markdown.css's gaps; the words between them (a tight list item's) are one text. */
function Flow({ children, inItem = false, style }: { children: ReactNode; inItem?: boolean; style?: object }) {
  const { base, openEnd } = useContext(Look);
  const out: { tag: string; node: ReactNode }[] = [];
  let run: ReactNode[] = [];
  const flush = () => {
    if (run.some((child) => typeof child !== "string" || child.trim())) out.push({ tag: "", node: <Text style={base} selectable>{run}</Text> });
    run = [];
  };
  for (const child of Children.toArray(children)) {
    const tag = tagOf(child);
    if (tag && (tag in MARGINS || tag === "div")) {
      flush();
      const node = (child as Tagged).props.node;
      // GFM's footnotes heading is for screen readers only.
      if (!(child as Tagged).props.className?.includes("sr-only")) out.push({ tag: tag === "pre" && node && fenceIn(node, openEnd).fence.kind !== "code" ? "card" : tag, node: child });
    } else run.push(child);
  }
  flush();
  return (
    <View style={style}>
      {out.map((block, at) => (
        <View key={at} style={at ? { marginTop: gap(out[at - 1]!.tag, block.tag, inItem) } : null}>
          {block.node}
        </View>
      ))}
    </View>
  );
}

/** A heading in the text's own face, 1.5, 1.25 and 1.125 of its size [D88]. */
function Heading({ level, children }: { level: number; children: ReactNode }) {
  const { base } = useContext(Look);
  const size = { 1: type.chatH1, 2: type.chatH2, 3: type.chatH3, 4: { lineHeight: (base.fontSize ?? type.chat.fontSize) * leading.normal }, 5: type.sm, 6: type.sm }[level];
  return (
    <Text accessibilityRole="header" style={[base, size, { fontWeight: level === 6 ? fontWeight.medium : fontWeight.semibold }]} selectable>
      {children}
    </Text>
  );
}

function List({ ordered, start, children }: { ordered: boolean; start?: number; children: ReactNode }) {
  const depth = useContext(Depth);
  return (
    <Depth.Provider value={depth + 1}>
      <View style={st.list}>
        {elements(children).map((item, at) => (
          <Marker.Provider key={at} value={ordered ? `${(start ?? 1) + at}.` : depth ? "circle" : "disc"}>
            {item}
          </Marker.Provider>
        ))}
      </View>
    </Depth.Provider>
  );
}

function Item({ children }: { children: ReactNode }) {
  const { base } = useContext(Look);
  const marker = useContext(Marker);
  return (
    <View style={st.item}>
      {marker === "disc" || marker === "circle" ? (
        <View style={[st.marker, st.dotBox, { height: base.lineHeight }]}>
          <View style={[st.dot, marker === "circle" ? st.circle : { backgroundColor: base.color }]} />
        </View>
      ) : (
        <Text style={[base, st.marker, st.strong]}>{marker} </Text>
      )}
      <Flow inItem>{children}</Flow>
    </View>
  );
}

/** Someone's words, set off by a rounded bar; a GitHub alert is a callout, the bar and its icon on the first line [D477]. */
function Quote({ node, children }: { node?: Node; children: ReactNode }) {
  const look = useContext(Look);
  const kind = node?.properties?.dataCallout;
  const bar = <View style={st.bar} />;
  if (!kind) {
    return (
      <Look.Provider value={{ ...look, base: { ...look.base, color: color.mutedForeground } }}>
        <View style={st.quote}>
          {bar}
          <Flow>{children}</Flow>
        </View>
      </Look.Provider>
    );
  }
  const warn = calloutWarns(kind);
  const Mark = warn ? Warning : Info;
  return (
    <View style={[st.quote, st.callout]}>
      {bar}
      <View style={{ height: look.base.lineHeight, justifyContent: "center" }} accessible accessibilityLabel={calloutLabel(warn)}>
        <Mark className={warn ? "size-icon-md text-warning" : "size-icon-md text-muted-foreground"} />
      </View>
      <Flow style={st.grow}>{children}</Flow>
    </View>
  );
}

/**
 * A table, sideways when wider than the screen: a column is as wide as its widest cell, measured once drawn.
 * shortcut: a cell is at most 288 wide (the desktop's wraps to the chat's width), and a column never narrows while the reply streams.
 */
function Table({ children }: { children: ReactNode }) {
  const { base } = useContext(Look);
  const [widths, setWidths] = useState<number[]>([]);
  const head = elements(children).some((part) => tagOf(part) === "thead");
  const rows = elements(children).flatMap((part) => elements(part.props.children));
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View>
        {rows.map((row, r) => (
          <View key={r} style={[st.row, r > 0 && { borderTopWidth: 1, borderTopColor: head && r === 1 ? color.border : color.tableRule }]}>
            {elements(row.props.children).map((cell, c) => (
              <View
                key={c}
                style={[st.cell, widths[c] ? { width: widths[c] } : null]}
                onLayout={({ nativeEvent }) => {
                  const width = Math.ceil(nativeEvent.layout.width);
                  setWidths((now) => ((now[c] ?? 0) >= width ? now : Object.assign([...now], { [c]: width })));
                }}
              >
                <Text style={[base, type.sm, tagOf(cell) === "th" && st.strong, { textAlign: cell.props.style?.textAlign }]} selectable>
                  {cell.props.children}
                </Text>
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

const Words = ({ children }: { children?: ReactNode }) => {
  const { base } = useContext(Look);
  return <Text style={base} selectable>{children}</Text>;
};

/** A fence's language, code and what it draws; past `openEnd`, the text ends inside it: it's still being written [D520]. */
function fenceIn(pre: Node, openEnd: number) {
  const live = openEnd >= 0 && (pre.position?.end.offset ?? 0) >= openEnd;
  const code = pre.children?.[0];
  const classes = Array.isArray(code?.properties?.className) ? (code.properties.className as string[]) : [];
  const language = classes.find((name) => name.startsWith("language-"))?.slice("language-".length) ?? "";
  const text = textOf(code);
  return { language, said: text.replace(/\n$/, ""), fence: fenceOf(language, code?.data?.meta, text, live) };
}

/** A fence as the card it is, or a code block. */
function Pre({ node }: { node?: Node }) {
  const { base, openEnd } = useContext(Look);
  if (node?.children?.[0]?.tagName !== "code") return null;
  const { language, said, fence } = fenceIn(node, openEnd);
  if (fence.kind === "preview") {
    return (
      <Draft icon={<Eye className="size-icon-sm shrink-0 text-muted-foreground" />} title={fence.title} text={said}>
        <View style={st.preview}>
          <Markdown text={said} style={base} />
        </View>
      </Draft>
    );
  }
  if (fence.kind === "message") return fence.message ? <MessageCard {...fence.message} base={base} /> : <MessageFrame />;
  if (fence.kind === "writing") return <WritingCard title={fence.title} text={said} base={base} />;
  return <CodeBlock code={said} language={language} title={fence.title} />;
}

const components: Components = {
  div: ({ children }) => <Flow>{children}</Flow>,
  section: ({ children }) => <Flow>{children}</Flow>,
  p: ({ children }) => <Words>{children}</Words>,
  h1: ({ children }) => <Heading level={1}>{children}</Heading>,
  h2: ({ children }) => <Heading level={2}>{children}</Heading>,
  h3: ({ children }) => <Heading level={3}>{children}</Heading>,
  h4: ({ children }) => <Heading level={4}>{children}</Heading>,
  h5: ({ children }) => <Heading level={5}>{children}</Heading>,
  h6: ({ children }) => <Heading level={6}>{children}</Heading>,
  ul: ({ children }) => <List ordered={false}>{children}</List>,
  ol: ({ children, start }) => <List ordered start={start}>{children}</List>,
  li: ({ children }) => <Item>{children}</Item>,
  blockquote: ({ node, children }) => <Quote node={node as Node | undefined}>{children}</Quote>,
  hr: () => <View style={st.rule} />,
  table: ({ children }) => <Table>{children}</Table>,
  pre: ({ node }) => <Pre node={node as Node | undefined} />,
  // A word or whole inline code the session knows is its ref (Refs.tsx).
  span: ({ node, children }) => {
    const word = (node as Node | undefined)?.properties?.dataRef;
    return word === undefined ? children : <RefWord word={word} plain={children} />;
  },
  code: ({ node }) => {
    const text = textOf(node as Node | undefined);
    return <RefWord word={text} plain={<Code text={text} />} />;
  },
  // A link to a session the Mac lists is its ref, as the desktop's; a web, mail or anchor link stays a link.
  a: ({ href, children }) => {
    const link = <Link url={href ?? ""}>{children}</Link>;
    return !href || /^(https?:|mailto:|#)/i.test(href) ? link : <RefWord word={linkPath(href)} plain={link} />;
  },
  img: ({ src, alt }) => <Link url={String(src ?? "")}>{alt || String(src ?? "").split("/").pop()}</Link>,
  strong: ({ children }) => <Text style={st.strong}>{children}</Text>,
  em: ({ children }) => <Text style={st.em}>{children}</Text>,
  del: ({ children }) => <Text style={st.del}>{children}</Text>,
  sup: ({ children }) => <Text style={st.sup}>{children}</Text>,
  br: () => "\n",
  input: ({ checked }) => <View style={[st.check, checked && st.checked]}>{checked ? <Check className="size-icon-xs text-background" /> : null}</View>,
};
const allowed = [...Object.keys(components), "thead", "tbody", "tr", "th", "td"];
/** One box for the reply's blocks, so the words between them never land outside a text. */
const box = () => (tree: Node) => {
  tree.children = [{ type: "element", tagName: "div", properties: {}, children: tree.children ?? [] }];
};
const BLOCK = /^(div|section|p|h[1-6]|ul|ol|li|blockquote|table|thead|tbody|tr|th|td|pre|hr)$/;
/** Whitespace as a browser lays it out: a run is one space, none at a block's edge or around a line break; code keeps its own. */
const collapse = () => (tree: Node) => {
  const walk = (node: Node) => {
    if (node.tagName === "pre" || node.tagName === "code") return;
    const kids = node.children ?? [];
    const edge = (at: number) => at < 0 || at >= kids.length || kids[at]!.tagName === "br" || BLOCK.test(kids[at]!.tagName ?? "");
    const block = node.type === "root" || BLOCK.test(node.tagName ?? "");
    kids.forEach((child, at) => {
      if (child.type !== "text") return walk(child);
      let value = child.value!.replace(/[ \t\n\r\f]+/g, " ");
      if ((at === 0 && block) || (at > 0 && edge(at - 1))) value = value.replace(/^ /, "");
      if ((at === kids.length - 1 && block) || (at < kids.length - 1 && edge(at + 1))) value = value.replace(/ $/, "");
      child.value = value;
    });
    node.children = kids.filter((child) => child.type !== "text" || child.value);
  };
  walk(tree);
};
// Links keep any target: Link opens only web ones and shows a Mac path's image.
const keepUrl = (url: string) => url;

/** Markdown drawn in `style`'s text: an answer's, or (with `bubble`) the user's bubble's. */
export function Markdown({ text, style, bubble = false, streaming = false }: { text: string; style?: TextStyle; bubble?: boolean; streaming?: boolean }) {
  const base: TextStyle = StyleSheet.flatten([st.text, style]) ?? st.text;
  const source = nestUnderItems(text);
  // As the desktop's openFence, less a quote's next `>`: only a reply still streaming has a fence still open.
  const codeAt = fenceWalk();
  const openEnd = streaming && source.trimEnd().split("\n").map(codeAt).at(-1) !== null ? source.replace(/[\s>]+$/, "").length : -1;
  return (
    <Look.Provider value={{ base, bubble, openEnd }}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks, remarkRefs]} rehypePlugins={[callouts, collapse, box]} components={components} allowedElements={allowed} unwrapDisallowed urlTransform={keepUrl}>
        {source}
      </ReactMarkdown>
    </Look.Provider>
  );
}

const st = StyleSheet.create({
  text: { ...type.chat, fontWeight: fontWeight.normal, color: color.chatForeground },
  strong: { fontWeight: fontWeight.semibold },
  em: { fontStyle: "italic" },
  del: { textDecorationLine: "line-through" },
  sup: { fontSize: type.xs.fontSize },
  link: { color: color.chatLink },
  inlineCode: { fontFamily: mono, fontSize: type.codeInline.fontSize, backgroundColor: color.codeCard },
  bubbleCode: { backgroundColor: color.fillHover },
  codePad: { letterSpacing: space(1.5) },
  list: { marginStart: space(6) },
  item: { paddingStart: space(1) },
  marker: { position: "absolute", right: "100%" },
  // CSS's disc and circle markers: a third of the text's size, a little before the item's words.
  dotBox: { justifyContent: "center", paddingEnd: space(1.5) },
  dot: { width: space(1.25), height: space(1.25), borderRadius: radius.capsule },
  circle: { borderWidth: 1, borderColor: color.chatForeground },
  quote: { paddingStart: space(4) },
  callout: { flexDirection: "row", gap: space(2) },
  bar: { position: "absolute", top: 0, bottom: 0, start: 0, width: space(1), borderRadius: radius.capsule, backgroundColor: color.quoteEdge },
  rule: { borderTopWidth: 1, borderTopColor: color.proseRule },
  row: { flexDirection: "row" },
  cell: { minWidth: space(24), maxWidth: space(72), paddingHorizontal: space(3), paddingVertical: space(2) },
  check: { width: space(3.5), height: space(3.5), marginEnd: space(1), borderRadius: radius.xs, borderWidth: 1, borderColor: color.border, alignItems: "center", justifyContent: "center" },
  checked: { backgroundColor: color.foreground, borderColor: color.foreground },
  grow: { flex: 1 },
  preview: { paddingHorizontal: space(4), paddingTop: space(1), paddingBottom: space(3) },
});
