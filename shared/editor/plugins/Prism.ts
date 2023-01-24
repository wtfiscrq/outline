import { flattenDeep } from "lodash";
import { Node } from "prosemirror-model";
import { Plugin, PluginKey, Transaction } from "prosemirror-state";
import { findBlockNodes } from "prosemirror-utils";
import { Decoration, DecorationSet } from "prosemirror-view";
import refractor from "refractor/core";

export const LANGUAGES = {
  none: "None", // additional entry to disable highlighting
  bash: "Bash",
  css: "CSS",
  clike: "C",
  csharp: "C#",
  elixir: "Elixir",
  erlang: "Erlang",
  go: "Go",
  graphql: "GraphQL",
  groovy: "Groovy",
  haskell: "Haskell",
  markup: "HTML",
  ini: "INI",
  java: "Java",
  javascript: "JavaScript",
  json: "JSON",
  kotlin: "Kotlin",
  lisp: "Lisp",
  lua: "Lua",
  mermaidjs: "Mermaid Diagram",
  objectivec: "Objective-C",
  ocaml: "OCaml",
  perl: "Perl",
  php: "PHP",
  powershell: "Powershell",
  python: "Python",
  rego: "Rego",
  ruby: "Ruby",
  rust: "Rust",
  scala: "Scala",
  sql: "SQL",
  solidity: "Solidity",
  swift: "Swift",
  toml: "TOML",
  typescript: "TypeScript",
  "visual-basic": "Visual Basic",
  yaml: "YAML",
  zig: "Zig",
};

// Languages that are not supported by refractor or are specially handled
const EXCLUDED_LANGUAGES = ["mermaidjs"];

type ParsedNode = {
  text: string;
  classes: string[];
};

const cache: Record<number, { node: Node; decorations: Decoration[] }> = {};

function getDecorations({
  doc,
  name,
  lineNumbers,
}: {
  /** The prosemirror document to operate on. */
  doc: Node;
  /** The node name. */
  name: string;
  /** Whether to include decorations representing line numbers */
  lineNumbers?: boolean;
}) {
  const decorations: Decoration[] = [];
  const blocks: { node: Node; pos: number }[] = findBlockNodes(doc).filter(
    (item) => item.node.type.name === name
  );

  function parseNodes(
    nodes: refractor.RefractorNode[],
    classNames: string[] = []
  ): any {
    return nodes.map((node) => {
      if (node.type === "element") {
        const classes = [...classNames, ...(node.properties.className || [])];
        return parseNodes(node.children, classes);
      }

      return {
        text: node.value,
        classes: classNames,
      };
    });
  }

  blocks.forEach(async (block) => {
    let startPos = block.pos + 1;
    const language = block.node.attrs.language;
    const isExcluded = EXCLUDED_LANGUAGES.includes(language);
    if (!language || language === "none" || isExcluded) {
      return;
    }

    if (!refractor.registered(language)) {
      try {
        // Dynamically load and register the language module
        const mod = await import(`refractor/lang/${language}`);
        refractor.register(mod.default);
      } catch (e) {
        console.error(`Failed loading '${language}' language module: ${e}`);
        return;
      }
    }

    const lineDecorations = [];

    if (!cache[block.pos] || !cache[block.pos].node.eq(block.node)) {
      if (lineNumbers) {
        const lineCount =
          (block.node.textContent.match(/\n/g) || []).length + 1;
        lineDecorations.push(
          Decoration.widget(block.pos + 1, () => {
            const el = document.createElement("div");
            el.innerText = new Array(lineCount)
              .fill(0)
              .map((_, i) => i + 1)
              .join("\n");
            el.className = "line-numbers";
            return el;
          })
        );
        lineDecorations.push(
          Decoration.node(block.pos, block.pos + block.node.nodeSize, {
            style: `--line-number-gutter-width: ${String(lineCount).length}`,
          })
        );
      }

      const nodes = refractor.highlight(block.node.textContent, language);
      const newDecorations = flattenDeep(parseNodes(nodes))
        .map((node: ParsedNode) => {
          const from = startPos;
          const to = from + node.text.length;

          startPos = to;

          return {
            ...node,
            from,
            to,
          };
        })
        .filter((node) => node.classes && node.classes.length)
        .map((node) =>
          Decoration.inline(node.from, node.to, {
            class: node.classes.join(" "),
          })
        )
        .concat(lineDecorations);

      cache[block.pos] = {
        node: block.node,
        decorations: newDecorations,
      };
    }

    cache[block.pos].decorations.forEach((decoration) => {
      decorations.push(decoration);
    });
  });

  Object.keys(cache)
    .filter((pos) => !blocks.find((block) => block.pos === Number(pos)))
    .forEach((pos) => {
      delete cache[Number(pos)];
    });

  return DecorationSet.create(doc, decorations);
}

export default function Prism({
  name,
  lineNumbers,
}: {
  /** The node name. */
  name: string;
  /** Whether to include decorations representing line numbers */
  lineNumbers?: boolean;
}) {
  let highlighted = false;

  return new Plugin({
    key: new PluginKey("prism"),
    state: {
      init: (_: Plugin, { doc }) => {
        return DecorationSet.create(doc, []);
      },
      apply: (transaction: Transaction, decorationSet, oldState, state) => {
        const nodeName = state.selection.$head.parent.type.name;
        const previousNodeName = oldState.selection.$head.parent.type.name;
        const codeBlockChanged =
          transaction.docChanged && [nodeName, previousNodeName].includes(name);
        const ySyncEdit = !!transaction.getMeta("y-sync$");

        if (!highlighted || codeBlockChanged || ySyncEdit) {
          highlighted = true;
          return getDecorations({ doc: transaction.doc, name, lineNumbers });
        }

        return decorationSet.map(transaction.mapping, transaction.doc);
      },
    },
    view: (view) => {
      if (!highlighted) {
        // we don't highlight code blocks on the first render as part of mounting
        // as it's expensive (relative to the rest of the document). Instead let
        // it render un-highlighted and then trigger a defered render of Prism
        // by updating the plugins metadata
        setTimeout(() => {
          view.dispatch(view.state.tr.setMeta("prism", { loaded: true }));
        }, 10);
      }
      return {};
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
}
