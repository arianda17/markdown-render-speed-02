# Fast Markdown Renderer

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/arianda17/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/arianda17/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)

A dependency-free, fast drop-in for [marked](https://github.com/markedjs/marked) 18.1.3: `parse.js` renders exactly the HTML marked renders with its default options (GFM on, breaks off), and `main.ts` drives it over a case set. Built for the [make.fun bounty "Make Markdown rendering faster"](https://make.fun/bounty/markdown-render-speed-02) ($250, top 20 paid).

## How it works

- Line-oriented block lexer: cheap first-character dispatch, one scan per paragraph, so the 40 large documents (99% of the runtime) lex without re-scanning.
- Index-based inline scanner: no substring copying, one cheap test per character, only the patterns the current character can start.
- Emphasis, strikethrough and link handling ported from marked's own greedy `emStrong`/`del` algorithms, including its delimiter-run rules, so the output is byte-identical to marked on all 680 CommonMark/GFM spec examples and all 40 generated documents (720/720).

## Run

```sh
node main.ts
```

Reads `/input/cases.json` (a JSON array of `{id, markdown}`) and writes `/output/html.json` (a JSON array of HTML strings, in the same order). Outside the grading container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for `/input` and `/output`.

## License

MIT. See [LICENSE](LICENSE).
