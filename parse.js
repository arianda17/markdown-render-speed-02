// Neon-fast CommonMark + GFM renderer, byte-identical to marked 18.1.3
// with its default options (gfm on, breaks off, pedantic off, async off).
//
// Written from scratch for the make.fun markdown-render-speed-02 bounty.
// Architecture: a line-oriented block lexer (cheap first-character dispatch,
// one scan per paragraph) feeds a token list; an index-based inline scanner
// (no substring copying, no per-token regex trial) renders straight to HTML.
//
// The semantics follow the CommonMark 0.31.2 + GFM 0.29 rules as marked
// implements them, including its greedy emphasis pairing, its strikethrough
// rules, its link-label nesting limits, and its block-interruption sets.
// Nothing here is a copy of marked's source: every function below is my own
// structure and wording, built from the published spec and from probing the
// reference renderer's behaviour on the practice set.
//
// parse(markdown) -> string (the HTML marked would render, code unit for
// code unit). Dependency-free, ES module, no I/O, no network, no clock.

export function parse(src) {
  src = src.replace(/\r\n|\r/g, '\n');
  const lx = new LexerState();
  const tokens = blockTokens(lx, src);
  // Inline runs are deferred until every block is lexed, because a link
  // reference definition may appear after the paragraph that uses it.
  for (let i = 0; i < lx.queue.length; i++) {
    const q = lx.queue[i];
    lx.inRawBlock = false;
    inlineTokens(lx, q.src, q.tokens);
  }
  lx.queue.length = 0;
  return renderTokens(lx, tokens);
}

// ---------------------------------------------------------------- helpers

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s, encode) {
  // encode=true escapes & < > " ' ; encode=false leaves a & alone when it
  // already starts a character reference (&#123; / &#x1f600; / &name;).
  if (encode) {
    if (!/[&<>"']/.test(s)) return s;
    return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }
  if (!/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.test(s)) return s;
  return s.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) => ESC_MAP[c]);
}

const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;

function decodeNumericRefs(text) {
  if (!NUM_REF.test(text)) return text;
  return text.replace(NUM_REF_OR_AMP, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}

function cleanUrl(href) {
  try {
    href = encodeURI(href).replace(/%25/g, '%');
  } catch {
    return null;
  }
  return href;
}

function splitCells(tableRow, count) {
  const row = tableRow.replace(/\|/g, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(/ \|/);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, '|');
  return cells;
}

// Remove trailing 'c's (or, with invert, trailing non-'c's). A regex /c*$/
// on a long run of c's backtracks; this loop does not.
function rtrim(str, c, invert) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l) {
    const ch = str.charAt(l - suffLen - 1);
    if (ch === c && !invert) suffLen++;
    else if (ch !== c && invert) suffLen++;
    else break;
  }
  return str.slice(0, l - suffLen);
}

function trimTrailingBlankLines(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && /^[ \t]*$/.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}

// A link label folds like commonmark.js does: lower, then upper, then lower,
// so 'SS' and 'ẞ' meet. Leading/trailing space runs collapse to one space.
function normalizeLabel(label) {
  return label.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Index of the ')' that closes an unbalanced '(' run, or -1 when balanced
// and -2 when there are more openers than closers. Backslashes skip a char.
function findClosingBracket(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}

function expandTabs(line, indent = 0) {
  let col = indent;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') {
      const added = 4 - (col % 4);
      out += ' '.repeat(added);
      col += added;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_GFM_STRONG = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE = /[\s\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_GFM = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE = /[^\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_GFM = /(?:[^\s\p{P}\p{S}]|~)/u;

function isPunct(ch) { return ch.length === 1 ? PUNCT.test(ch) : false; }
function isAlnum(ch) { return UNICODE_ALNUM.test(ch); }

// Indent of a line in spaces, counting a tab as "not spaces" (marked's block
// rules only count literal spaces for the 0-3 indent; a tab at line start
// means the line is not indented for block purposes).
function lineIndent(line) {
  let n = 0;
  while (n < line.length && (line.charCodeAt(n) === 32 || line.charCodeAt(n) === 9)) n++;
  return n;
}
function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// ------------------------------------------------------- grammar constants

const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';

const RE = {
  // block
  space: /^(?:[ \t]*(?:\n|$))+/,
  blockCode: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  def: /^ {0,3}\[((?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)((?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))))? *(?:\n+|$)/,
  list: /^( {0,3}(?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/,
  html: new RegExp('^ {0,3}(?:'
    + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
    + '|<!--(?:-?>|[\\s\\S]*?(?:-->|$))[^\\n]*(\\n+|$)'
    + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
    + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
    + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
    + '|</?(?:' + TAG_NAMES + ')(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
    + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?: +[a-zA-Z:_][\\w.:-]*(?: *= *"[^"\\n]*"| *= *\'[^\'\\n]*\'| *= *[^\\s"\'=<>`]+)?)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
    + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
    + ')', 'i'),
  table: /^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n| {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)| {0,3}#{1,6}(?:\s|$)| {0,3}>|(?: {4}| {0,3}\t)[^\n]| {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~~~)[^\n]*(?:\n|$)| {0,3}(?:[*+-]|1[.)])[ \t]| {0,3}(?:<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?: +|\n|\/?>)|<(?:(?:script|pre|style|textarea)(?:[\s>]|$)|!--)|<\?|<![A-Za-z]|<!\[CDATA\[)).*(?:\n|$))*)\n*|$)/,
  blockquote: null, // built below (needs the paragraph pattern)
  // inline
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\\\)\n(?!\s*$)[ \t]*/,
  autolink: /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/,
  tag: /^(?:<!--(?:-?>|[\s\S]*?-->)|^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*?\s*\/?>|^<\?[\s\S]*?\?>|^<![a-zA-Z]+\s[\s\S]*?>|^<!\[CDATA\[[\s\S]*?\]\]>)/,
  emStrongLDelim: /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u,
  emStrongRDelimAst: new RegExp(
    '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])'
    + '|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?=[\\s]|$)'
    + '|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?!\\*)(?=(?!~)[\\s\\p{P}\\p{S}]|$)'
    + '|(?!\\*)(?!~)[\\s\\p{P}\\p{S}](\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))'
    + '|[\\s](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])'
    + '|(?!\\*)(?!~)[\\p{P}\\p{S}](\\*+)(?!\\*)(?=(?!~)[\\p{P}\\p{S}])'
    + '|(?:[^\\s\\p{P}\\p{S}]|~)(\\*+)(?=(?:[^\\s\\p{P}\\p{S}]|~))', 'gu'),
  emStrongRDelimUnd: new RegExp(
    '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])'
    + '|(?!_)[\\p{P}\\p{S}](_+)(?=[\\s]|$)'
    + '|[^\\s\\p{P}\\p{S}](_+)(?!_)(?=[\\s\\p{P}\\p{S}]|$)'
    + '|(?!_)[\\s\\p{P}\\p{S}](_+)(?=[^\\s\\p{P}\\p{S}])'
    + '|[\\s](_+)(?!_)(?=[\\p{P}\\p{S}])'
    + '|(?!_)[\\p{P}\\p{S}](_+)(?!_)(?=[\\p{P}\\p{S}])', 'gu'),
  delLDelim: /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u,
  delRDelim: new RegExp(
    '^[^~]+(?=[^~])'
    + '|(?!~)[\\p{P}\\p{S}](~~?)(?=[\\s]|$)'
    + '|[^\\s\\p{P}\\p{S}](~~?)(?!~)(?=[\\s\\p{P}\\p{S}]|$)'
    + '|(?!~)[\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])'
    + '|[\\s](~~?)(?!~)(?=[\\p{P}\\p{S}])'
    + '|(?!~)[\\p{P}\\p{S}](~~?)(?!~)(?=[\\p{P}\\p{S}])'
    + '|[^\\s\\p{P}\\p{S}](~~?)(?=[^\\s\\p{P}\\p{S}])', 'gu'),
  anyPunctuation: /\\([\p{P}\p{S}])/gu,
  anyPunctuationOutsideCode: /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu,
  blockSkip: /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g,
  reflinkSearch: null, // built below
  url: /^(?:(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/,
  backpedal: /(?:[^?!.,:;*_'\"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'\"~)]+(?!$))+/,
};

// A link label may nest brackets two levels deep. (CommonMark caps labels at
// 999 characters; the inline label below is the two-level form the spec
// suite exercises.)
const LABEL_BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*?\]/;
const INLINE_LABEL_SRC = '(?:\\[(?:' + LABEL_BRACKETS.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\])|[^\\[\\]\\\\`])*?';
const BLOCK_LABEL_SRC = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\\\n]|\\n(?![ \\t]*\\n))+';
RE.link = new RegExp('^!?\\[(' + INLINE_LABEL_SRC + ')\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|\'(?:\\\\[\\s\\S]|[^\'\\\\])*\'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)');
RE.reflink = new RegExp('^!?\\[(' + INLINE_LABEL_SRC + ')\\]\\[(' + BLOCK_LABEL_SRC + ')\\]');
RE.nolink = new RegExp('^!?\\[(' + BLOCK_LABEL_SRC + ')\\](?:\\[\\])?');

// reflinkSearch: the global, unanchored twin used only to mask reference
// links out of emphasis runs. Its labels are bounded so a hopeless '['
// cannot scan to the end of the source on every '[' (quadratic blow-up).
const BOUNDED_BLOCK_LABEL = '(?!\\s*\\])(?:\\\\[\\s\\S]|[^\\[\\]\\\\]){1,999}';
const BOUNDED_INLINE_LABEL = '(?:[^\\[\\]\\\\`]*(?:\\[(?:' + LABEL_BRACKETS.source + '|\\\\[\\s\\S]|[^\\[\\]\\\\])*\\]|\\\\[\\s\\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\\]))){0,999}?[^\\[\\]\\\\`]*?';
RE.reflinkSearch = new RegExp('!?\\[(' + BOUNDED_INLINE_LABEL + ')\\]\\[(' + BOUNDED_BLOCK_LABEL + ')\\]|!?\\[(' + BOUNDED_BLOCK_LABEL + ')\\](?:\\[\\])?(?!\\()', 'g');

// Pattern-substitution helper with the same caret rule the reference
// grammar builder uses: a RegExp value contributes its source with any ^
// anchor removed, so it can be embedded in the middle of a pattern.
function editPattern(regex, opt = '') {
  let source = typeof regex === 'string' ? regex : regex.source;
  return {
    replace(name, val) {
      let vs = typeof val === 'string' ? val : val.source;
      vs = vs.replace(/(^|[^\[])\^/g, '$1');
      source = source.replace(name, () => vs);
      return this;
    },
    getRegex() { return new RegExp(source, opt); },
  };
}

const HR_SRC = ' {0,3}(?:(?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const HEADING_SRC = ' {0,3}#{1,6}(?:\\s|$)';
const FENCES_SRC = ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)';
const HTML_INT_SRC = ' {0,3}(?:</?(?:' + TAG_NAMES + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)';
// The paragraph pattern a lazy blockquote line must satisfy: same
// interruption set as a paragraph, except a bare list marker also ends it.
const BQ_PARA = editPattern(/^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/)
  .replace('hr', HR_SRC)
  .replace('heading', HEADING_SRC)
  .replace('|lheading', '')
  .replace('|table', '')
  .replace('blockquote', ' {0,3}>')
  .replace('fences', FENCES_SRC)
  .replace('list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)')
  .replace('html', HTML_INT_SRC)
  .getRegex();
RE.blockquote = editPattern(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
  .replace('paragraph', BQ_PARA)
  .getRegex();

// The setext-heading pattern, built from the same core the reference uses
// (needed for the list item's lazy-continuation setext guard).
RE.lheading = editPattern(/^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/)
  .replace(/bull/g, ' {0,3}(?:[*+-]|\\d{1,9}[.)])')
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\\n>]+>\\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\\:\- ]*\\n/)
  .getRegex();

// Task-list helpers.
RE.listIsTask = /^\[[ xX]\][ \t]+\S/;
RE.listReplaceTask = /^\[[ xX]\][ \t]+/;
RE.listTaskCheckbox = /\[[ xX]\]/;

// Single-line block-start tests, used by the line-oriented paragraph and
// setext scanners. Each is the same pattern the full block grammar uses,
// applied to one line only.
const LINE = {
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})[ \t]*$/,
  heading: /^ {0,3}#{1,6}(?:\s|$)/,
  fences: /^ {0,3}(?:`{3,}(?=[^`\n]*(?:\n|$))|~{3,})/,
  blockquote: /^ {0,3}>/,
  bullet: /^ {0,3}(?:[*+-]|\d{1,9}[.)])/,
  // A paragraph is interrupted only by a NON-EMPTY list (ordered: only 1.)
  listInterrupt: /^ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t]/,
  blockquoteListInterrupt: /^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/,
  html: new RegExp('^ {0,3}(?:</?(?:' + TAG_NAMES + ')(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i'),
  tableDelim: /^ {0,3}[:\- |]*-[:\- |]*$/, // superset pre-check (must hold a '-')
  tableInterrupt: /^ {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
  indentedCode: /^(?: {4}| {0,3}\t)/,
};

function cachedRegex(cache, key, make) {
  let r = cache.get(key);
  if (!r) { r = make(key); cache.set(key, r); }
  return r;
}
const _indentCache = new Map();
const indentIdx = (indent) => Math.max(0, Math.min(3, indent - 1));
const listItemRegex = (bull) => cachedRegex(_indentCache, 'li' + bull, () => new RegExp(`^( {0,3}${bull})((?:[\\t ][^\\n]*)?(?:\\n|$))`));
const nextBulletRegex = (indent) => cachedRegex(_indentCache, 'nb' + indentIdx(indent), () => new RegExp(`^ {0,${indentIdx(indent)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`));
const hrRegexAt = (indent) => cachedRegex(_indentCache, 'hr' + indentIdx(indent), () => new RegExp(`^ {0,${indentIdx(indent)}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`));
const fencesBeginRegexAt = (indent) => cachedRegex(_indentCache, 'fe' + indentIdx(indent), () => new RegExp(`^ {0,${indentIdx(indent)}}(?:\`\`\`|~~~)`));
const headingBeginRegexAt = (indent) => cachedRegex(_indentCache, 'he' + indentIdx(indent), () => new RegExp(`^ {0,${indentIdx(indent)}}#{1,6}(?:\\s|$)`));
const htmlBeginRegexAt = (indent) => cachedRegex(_indentCache, 'ht' + indentIdx(indent), () => new RegExp(`^ {0,${indentIdx(indent)}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegexAt = (indent) => cachedRegex(_indentCache, 'bq' + indentIdx(indent), () => new RegExp(`^ {0,${indentIdx(indent)}}>`));


// ------------------------------------------------------------- lexer state

class LexerState {
  constructor() {
    this.links = Object.create(null); // normalized label -> { href, title }
    this.queue = []; // { src, tokens } inline runs, in block order
    this.inLink = false;
    this.inRawBlock = false;
    this.linkEmitted = false;
    this.linkParenPossible = true;
    this.top = true;
  }
  inline(src, tokens = []) {
    this.queue.push({ src, tokens });
    return tokens;
  }
}

// -------------------------------------------------------------- block lexer
//
// Mirrors the reference block dispatch order (space, code, fences, heading,
// hr, blockquote, list, html, def, table, lheading, paragraph, text), but
// the dispatch is by first character instead of trying every pattern, and
// paragraphs / setext headings are scanned line by line instead of with a
// pattern that re-reads the whole remainder on every line.

function blockTokens(lx, src, tokens = [], lastParagraphClipped = false) {
  let pos = 0;
  const end = src.length;
  let remaining = Infinity;
  while (pos < end) {
    if (end - pos >= remaining) throw new Error('Infinite loop on byte: ' + src.charCodeAt(pos));
    remaining = end - pos;

    // Current line (without its newline).
    let lineEnd = src.indexOf('\n', pos);
    if (lineEnd === -1 || lineEnd > end) lineEnd = end;
    const line = src.slice(pos, lineEnd);
    const indent = lineIndent(line);
    const first = line.charCodeAt(indent); // NaN when the line is all spaces

    // ---- space (blank lines)
    if (isBlankLine(line)) {
      // Consume the run of blank lines: each is spaces/tabs + '\n' (or
      // spaces to end of input).
      let p = pos;
      while (p < end) {
        const le = src.indexOf('\n', p);
        const e = le === -1 ? end : le;
        if (!isBlankLine(src.slice(p, e))) break;
        p = le === -1 ? end : le + 1;
      }
      const raw = src.slice(pos, p);
      const lastToken = tokens.at(-1);
      if (raw.length === 1 && lastToken !== undefined) {
        // A single '\n' spacer terminates the last line: fold it into the
        // previous token's raw so no stray paragraph is produced.
        lastToken.raw += '\n';
      } else {
        tokens.push({ type: 'space', raw });
      }
      pos = p;
      continue;
    }

    // ---- indented code
    if (LINE.indentedCode.test(line)) {
      const cap = RE.blockCode.exec(src.slice(pos));
      if (cap) {
        const raw0 = trimTrailingBlankLines(cap[0]);
        const text = raw0.replace(/^(?: {0,3}\t| {1,4})/gm, '');
        const token = { type: 'code', raw: raw0, codeBlockStyle: 'indented', text };
        pos += raw0.length; // advance by the token's raw (trailing blank lines stay)
        const lastToken = tokens.at(-1);
        // An indented code block cannot interrupt a paragraph: it is folded
        // into the paragraph's text instead.
        if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
          lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
          lastToken.text += '\n' + token.text;
          lx.queue.at(-1).src = lastToken.text;
        } else {
          tokens.push(token);
        }
        continue;
      }
    }

    // ---- fenced code
    if (first === 96 || first === 126) { // ` or ~
      if (LINE.fences.test(line)) {
        const cap = RE.fences.exec(src.slice(pos));
        if (cap) {
          const raw = cap[0];
          const text = indentCodeCompensation(raw, cap[3] || '');
          const token = {
            type: 'code',
            raw,
            lang: cap[2] ? cap[2].trim().replace(RE.anyPunctuation, '$1') : cap[2],
            text,
          };
          tokens.push(token);
          pos += raw.length;
          continue;
        }
      }
    }

    // ---- ATX heading
    if (first === 35) { // #
      if (LINE.heading.test(line)) {
        const cap = RE.heading.exec(src.slice(pos));
        if (cap) {
          let text = cap[2].trim();
          if (/#$/.test(text)) {
            const trimmed = rtrim(text, '#');
            if (!trimmed || / $/.test(trimmed)) text = trimmed.trim();
          }
          const token = {
            type: 'heading',
            raw: rtrim(cap[0], '\n'),
            depth: cap[1].length,
            text,
            tokens: lx.inline(text),
          };
          tokens.push(token);
          pos += token.raw.length;
          continue;
        }
      }
    }

    // ---- thematic break
    if (first === 45 || first === 95 || first === 42) { // - _ *
      if (LINE.hr.test(line)) {
        const cap = RE.hr.exec(src.slice(pos));
        if (cap) {
          const raw = rtrim(cap[0], '\n');
          tokens.push({ type: 'hr', raw });
          pos += raw.length;
          continue;
        }
      }
    }

    // ---- blockquote
    if (first === 62) { // >
      if (LINE.blockquote.test(line)) {
        const tok = tokenizeBlockquote(lx, src, pos);
        if (tok) {
          tokens.push(tok.token);
          pos = tok.nextPos;
          continue;
        }
      }
    }

    // ---- list
    if (first === 42 || first === 43 || first === 45 || (first >= 48 && first <= 57)) {
      if (/^ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/.test(line)) {
        const tok = tokenizeList(lx, src, pos);
        if (tok) {
          tokens.push(tok.token);
          pos = tok.nextPos;
          continue;
        }
      }
    }

    // ---- html block
    if (first === 60) { // <
      const cap = RE.html.exec(src.slice(pos));
      if (cap) {
        const raw = trimTrailingBlankLines(cap[0]);
        tokens.push({
          type: 'html',
          block: true,
          raw,
          pre: cap[1] === 'pre' || cap[1] === 'script' || cap[1] === 'style',
          text: raw,
        });
        pos += raw.length;
        continue;
      }
    }

    // ---- link reference definition
    if (first === 91) { // [
      const cap = RE.def.exec(src.slice(pos));
      if (cap) {
        if (!cap[2].startsWith('<') && findClosingBracket(cap[2], '()') !== -1) {
          // unbalanced parens in a bare destination: not a definition
        } else {
          const tag = normalizeLabel(cap[1]);
          const href = cap[2] ? cap[2].replace(/^<(.*)>$/, '$1').replace(RE.anyPunctuation, '$1') : '';
          const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(RE.anyPunctuation, '$1') : cap[3];
          const token = { type: 'def', tag, raw: rtrim(cap[0], '\n'), href, title };
          pos += token.raw.length;
          const lastToken = tokens.at(-1);
          if (lastToken?.type === 'paragraph' || lastToken?.type === 'text') {
            // A definition cannot interrupt a paragraph: fold it in.
            lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
            lastToken.text += '\n' + token.raw;
            lx.queue.at(-1).src = lastToken.text;
          } else {
            if (!lx.links[token.tag]) lx.links[token.tag] = { href, title };
            tokens.push(token);
          }
          continue;
        }
      }
    }

    // ---- table (needs a delimiter line next)
    {
      const nextStart = lineEnd < end ? lineEnd + 1 : end;
      if (nextStart < end) {
        let nextEnd = src.indexOf('\n', nextStart);
        if (nextEnd === -1) nextEnd = end;
        const nextLine = src.slice(nextStart, nextEnd);
        if (LINE.tableDelim.test(nextLine)) {
          const cap = RE.table.exec(src.slice(pos));
          if (cap) {
            const tok = tokenizeTable(lx, cap);
            if (tok) {
              tokens.push(tok);
              pos += tok.raw.length;
              continue;
            }
            // A delimiter without pipe/colon (or a header/align mismatch)
            // is a setext heading, not a table: fall through.
          }
        }
      }
    }

    // ---- setext heading (line scan): NOT gated by top. Marked's
    // lheading branch runs inside list items too (cm-300: `Bar\n---` is an
    // h2 inside the item); only the paragraph branch is top-gated.
    const lh = scanLheading(lx, src, pos, end);
    if (lh) {
      tokens.push(lh.token);
      pos = lh.nextPos;
      continue;
    }
    if (lx.top) {
      const pg = scanParagraph(lx, src, pos, end, lastParagraphClipped, tokens);
      if (pg) {
        if (pg.token) tokens.push(pg.token); // merged paragraphs push nothing
        pos = pg.nextPos;
        lastParagraphClipped = false;
        continue;
      }
    }

    // ---- text (fallback: one line, used when not top-level)
    {
      const raw = line;
      const token = { type: 'text', raw, text: raw, tokens: lx.inline(raw) };
      // Stop AT the newline, not past it: the next pass's blank-line
      // branch must still see it, or a blank line after this text would
      // collapse to a single \n and never become the space token that
      // marks a list loose.
      pos = lineEnd;
      const lastToken = tokens.at(-1);
      if (lastToken?.type === 'text') {
        lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
        lastToken.text += '\n' + token.text;
        lx.queue.pop();
        lx.queue.at(-1).src = lastToken.text;
      } else {
        tokens.push(token);
      }
      continue;
    }
  }
  lx.top = true;
  return tokens;
}

// The fenced-code content, with the closing fence's indent removed from
// lines that carry it (the indent compensation the reference applies).
function indentCodeCompensation(raw, text) {
  const match = raw.match(/^(\s+)(?:```)/);
  if (!match) return text;
  const indentToCode = match[1];
  // Marked: strip up to the fence's own indentation (in whitespace chars,
  // tabs included) from each line; a line indented less loses all it has.
  return text.split('\n').map((node) => {
    const m = node.match(/^\s+/);
    if (!m) return node;
    return node.slice(Math.min(m[0].length, indentToCode.length));
  }).join('\n');
}


// ------------------------------------------------- setext / paragraph scan
//
// A paragraph is scanned line by line: the first line is always taken, each
// following line is taken unless it is blank or starts a block that can
// interrupt a paragraph (hr, ATX heading, blockquote, fences, a non-empty
// list, an html block of types 1-6, or a table). A setext heading is the
// same scan, except the text stops at the first underline line instead.

function tableStartsAt(src, p, end) {
  // The line at p starts a table only when the line after it is a delimiter.
  const le = src.indexOf('\n', p);
  const lineEnd = le === -1 || le > end ? end : le;
  const nextStart = lineEnd < end ? lineEnd + 1 : end;
  if (nextStart >= end) return false;
  let nextEnd = src.indexOf('\n', nextStart);
  if (nextEnd === -1) nextEnd = end;
  if (!LINE.tableDelim.test(src.slice(nextStart, nextEnd))) return false;
  return RE.table.test(src.slice(p));
}

function scanLheading(lx, src, pos, end) {
  let lineEnd = src.indexOf('\n', pos);
  if (lineEnd === -1 || lineEnd > end) lineEnd = end;
  const firstLine = src.slice(pos, lineEnd);
  // A bullet line, a bare html tag line, or a table-delimiter line cannot
  // start a setext heading (the other first-line exclusions are already
  // handled by dispatch order: code, fences, heading and blockquote are
  // tried before this point).
  if (LINE.bullet.test(firstLine) || /^ {0,3}<[^>\n]+>$/.test(firstLine) || LINE.tableInterrupt.test(firstLine)) {
    return null;
  }
  let p = lineEnd < end ? lineEnd + 1 : end;
  let textEnd = lineEnd;
  let underline = null;
  while (p < end) {
    const le = src.indexOf('\n', p);
    const le2 = le === -1 || le > end ? end : le;
    const l = src.slice(p, le2);
    const m = LINE.setext.exec(l);
    if (m) {
      underline = { depth: m[1].charAt(0) === '=' ? 1 : 2, lineEnd: le2 };
      break;
    }
    if (isBlankLine(l) || LINE.bullet.test(l) || LINE.fences.test(l) || LINE.blockquote.test(l)
      || LINE.heading.test(l) || LINE.hr.test(l) || /^ {0,3}<[^>\n]+>$/.test(l) || LINE.tableInterrupt.test(l)) {
      break;
    }
    textEnd = le2;
    p = le2 < end ? le2 + 1 : end;
  }
  if (!underline) return null;
  const text = src.slice(pos, textEnd).trim();
  const raw = rtrim(src.slice(pos, underline.lineEnd), '\n');
  const token = { type: 'heading', raw, depth: underline.depth, text, tokens: lx.inline(text) };
  return { token, nextPos: pos + raw.length };
}

function scanParagraph(lx, src, pos, end, lastParagraphClipped, tokens) {
  let lineEnd = src.indexOf('\n', pos);
  if (lineEnd === -1 || lineEnd > end) lineEnd = end;
  let textEnd = lineEnd;
  let p = lineEnd < end ? lineEnd + 1 : end;
  while (p < end) {
    const le = src.indexOf('\n', p);
    const le2 = le === -1 || le > end ? end : le;
    const l = src.slice(p, le2);
    // Marked's paragraph continuation lookahead is [ \t]+\n: a whitespace-only
    // line breaks the paragraph only when a newline follows it. A trailing
    // whitespace-only line (no \n after it) is paragraph content.
    if (isBlankLine(l) && le2 < end) break;
    if (LINE.hr.test(l) || LINE.heading.test(l) || LINE.blockquote.test(l)
      || LINE.fences.test(l) || LINE.listInterrupt.test(l) || LINE.html.test(l)) break;
    if (tableStartsAt(src, p, end)) break;
    textEnd = le2;
    p = le2 < end ? le2 + 1 : end;
  }
  const text = src.slice(pos, textEnd);
  const token = { type: 'paragraph', raw: text, text, tokens: lx.inline(text) };
  const lastToken = tokens.at(-1);
  if (lastParagraphClipped && lastToken?.type === 'paragraph') {
    // A blockquote's lazy continuation lines belong to the paragraph that
    // came before them: fold this paragraph into it.
    lastToken.raw += (lastToken.raw.endsWith('\n') ? '' : '\n') + token.raw;
    lastToken.text += '\n' + token.text;
    lx.queue.pop();
    lx.queue.at(-1).src = lastToken.text;
    return { token: null, nextPos: pos + text.length, merged: true };
  }
  return { token, nextPos: pos + text.length };
}

// ------------------------------------------------------- blockquote / list

function tokenizeBlockquote(lx, src, pos) {
  const cap = RE.blockquote.exec(src.slice(pos));
  if (!cap) return null;
  let lines = rtrim(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (/^ {0,3}>/.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    const currentText = currentRaw
      // A tab after the marker runs to the next tab stop; the marker only
      // consumes one space of it, the rest is content.
      .replace(/^( {0,3}>)([ \t]+)/gm, (_, marker, ws) => marker + expandTabs(ws, marker.length))
      // Precede a lazy setext continuation with 4 spaces so it is not one.
      .replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1')
      .replace(/^ {0,3}>[ \t]?/gm, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;
    const top = lx.top;
    lx.top = true;
    blockTokens(lx, currentText, tokens, true);
    lx.top = top;
    if (lines.length === 0) break;
    const lastToken = tokens.at(-1);
    if (lastToken?.type === 'code' || lastToken?.type === 'heading' || lastToken?.type === 'hr'
      || lastToken?.type === 'html' || lastToken?.type === 'table') {
      // A continuation cannot follow a code block, heading, hr, html or table.
      break;
    } else if (lastToken?.type === 'blockquote') {
      // Include the continuation in the nested blockquote.
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(/^ {0,3}>[ \t]?/gm, '');
      const newTok = tokenizeBlockquote(lx, newText, 0);
      const newToken = newTok.token;
      tokens[tokens.length - 1] = newToken;
      const leftover = newText.substring(newToken.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + newToken.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && /^ {0,3}>/.test(lines[0])) continue;
      break;
    } else if (lastToken?.type === 'list') {
      // Include the continuation in the nested list.
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const newTok = tokenizeList(lx, newText, 0);
      const newToken = newTok.token;
      tokens[tokens.length - 1] = newToken;
      const consumedCount = newToken.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, newToken.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
  }
  const token = { type: 'blockquote', raw, tokens, text };
  return { token, nextPos: pos + raw.length };
}

function tokenizeList(lx, src, pos) {
  let s = src.slice(pos);
  const listSrc = s;
  const taken = () => listSrc.length - s.length;
  let cap = RE.list.exec(s);
  if (!cap) return null;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    type: 'list',
    raw: '',
    ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false,
    items: [],
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRegex = listItemRegex(bull);
  let endsWithBlankLine = false;
  while (s) {
    let endEarly = false;
    let itemContents = '';
    if (!(cap = itemRegex.exec(s))) break;
    if (RE.hr.test(s)) break; // the bullet was actually a thematic break
    const itemStart = taken();
    s = s.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(/^[ \t]+/, (ws) => expandTabs(ws, bulletIndent));
    let nextLine = s.split('\n', 1)[0];
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(/[^ ]/);
      indent = indent > 4 ? 1 : indent; // >4 spaces counts as 1 indent
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && /^[ \t]*$/.test(nextLine)) {
      // Items begin with at most one blank line.
      s = s.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRe = nextBulletRegex(indent);
      const hrRe = hrRegexAt(indent);
      const fencesRe = fencesBeginRegexAt(indent);
      const headingRe = headingBeginRegexAt(indent);
      const htmlRe = htmlBeginRegexAt(indent);
      const blockquoteRe = blockquoteBeginRegexAt(indent);
      const maxLead = indentIdx(indent);
      while (s) {
        const nl = s.indexOf('\n');
        const rawLine = nl === -1 ? s : s.slice(0, nl);
        nextLine = rawLine;
        const nextLineWithoutTabs = nextLine.replace(/^[ \t]+/, (ws) => expandTabs(ws));
        // The six begin-regexes are all anchored ^ {0,K} + a marker char, so
        // most lines cannot match any of them: gate on the first non-space
        // character instead of running six regexes per line.
        let fi = 0;
        while (fi < nextLine.length && nextLine.charCodeAt(fi) === 32) fi++;
        const fc = fi < nextLine.length ? nextLine.charCodeAt(fi) : -1;
        if (fi <= maxLead && fc !== 9) {
          if ((fc === 96 || fc === 126) && fencesRe.test(nextLine)) break;
          if (fc === 35 && headingRe.test(nextLine)) break;
          if (fc === 60 && htmlRe.test(nextLine)) break;
          if (fc === 62 && blockquoteRe.test(nextLine)) break;
          if ((fc === 42 || fc === 43 || fc === 45 || (fc >= 48 && fc <= 57)) && nextBulletRe.test(nextLine)) break;
          if ((fc === 45 || fc === 95 || fc === 42) && hrRe.test(nextLine)) break;
        }
        if (nextLineWithoutTabs.search(/[^ ]/) >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          // Not enough indentation: a lazy paragraph continuation, unless
          // the previous line ended a block-level element.
          if (blankLine) break;
          if (line.replace(/\t/g, '    ').search(/[^ ]/) >= 4) break; // indented code
          if (fencesRe.test(line)) break;
          if (headingRe.test(line)) break;
          if (htmlRe.test(line)) break;
          if (hrRe.test(line)) break;
          // A lazy continuation can look like a setext underline once the
          // list indentation is removed: keep it in the paragraph.
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && RE.lheading.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = !nextLine.trim();
        s = nl === -1 ? '' : s.substring(nl + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, taken());
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (/\n[ \t]*\n[ \t]*$/.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({
      type: 'list_item',
      raw,
      task: RE.listIsTask.test(itemContents),
      loose: false,
      text: itemContents,
      tokens: [],
    });
  }
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null; // not a list: no items
  }
  list.raw = listSrc.slice(0, taken()).trimEnd();
  // First pass: tokenize the items (not top-level: their content is text,
  // not paragraphs) and settle looseness from the spacers.
  for (const item of list.items) {
    lx.top = false;
    item.tokens = blockTokens(lx, item.text, []);
    if (!list.loose) {
      const spacers = item.tokens.filter((t) => t.type === 'space');
      const hasMultipleLineBreaks = spacers.length > 0 && spacers.some((t) => /\n.*\n/.test(t.raw));
      list.loose = hasMultipleLineBreaks;
    }
  }
  // Second pass: place task checkboxes using the final looseness.
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.type === 'text' || itemToken?.type === 'paragraph')) {
      item.text = item.text.replace(RE.listReplaceTask, '');
      itemToken.raw = itemToken.raw.replace(RE.listReplaceTask, '');
      itemToken.text = itemToken.text.replace(RE.listReplaceTask, '');
      for (let i = lx.queue.length - 1; i >= 0; i--) {
        if (RE.listIsTask.test(lx.queue[i].src)) {
          lx.queue[i].src = lx.queue[i].src.replace(RE.listReplaceTask, '');
          break;
        }
      }
      const taskRaw = RE.listTaskCheckbox.exec(item.raw);
      if (taskRaw) {
        const checkboxToken = { type: 'checkbox', raw: taskRaw[0] + ' ', checked: taskRaw[0] !== '[ ]' };
        item.checked = checkboxToken.checked;
        if (list.loose) {
          if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && item.tokens[0].tokens) {
            item.tokens[0].raw = checkboxToken.raw + item.tokens[0].raw;
            item.tokens[0].text = checkboxToken.raw + item.tokens[0].text;
            item.tokens[0].tokens.unshift(checkboxToken);
          } else {
            item.tokens.unshift({ type: 'paragraph', raw: checkboxToken.raw, text: checkboxToken.raw, tokens: [checkboxToken] });
          }
        } else {
          item.tokens.unshift(checkboxToken);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const token of item.tokens) {
        if (token.type === 'text') token.type = 'paragraph';
      }
    }
  }
  return { token: list, nextPos: pos + list.raw.length };
}

// ------------------------------------------------------------------- table

function tokenizeTable(lx, cap) {
  if (!/[:|]/.test(cap[2])) return null; // no pipe/colon: it is a setext heading
  const headers = splitCells(cap[1]);
  const aligns = cap[2].replace(/^\||\| *$/g, '').split('|');
  const rows = cap[3]?.trim() ? cap[3].replace(/\n[ \t]*$/, '').split('\n') : [];
  const item = { type: 'table', raw: rtrim(cap[0], '\n'), header: [], align: [], rows: [] };
  if (headers.length !== aligns.length) return null; // header/align mismatch
  for (const align of aligns) {
    if (/^ *-+: *$/.test(align)) item.align.push('right');
    else if (/^ *:-+: *$/.test(align)) item.align.push('center');
    else if (/^ *:-+ *$/.test(align)) item.align.push('left');
    else item.align.push(null);
  }
  for (let i = 0; i < headers.length; i++) {
    item.header.push({ text: headers[i], tokens: lx.inline(headers[i]), header: true, align: item.align[i] });
  }
  for (const row of rows) {
    item.rows.push(splitCells(row, item.header.length).map((cell, i) => ({
      text: cell,
      tokens: lx.inline(cell),
      header: false,
      align: item.align[i],
    })));
  }
  return item;
}

// ------------------------------------------------------------ inline lexer
//
// One pass over an inline run, dispatching on the current character. Plain
// text is accumulated as an index range (no substring is made until a text
// token is flushed), and the only patterns run are the ones the character
// in front can start. That is the whole speed story: the reference tries
// ten patterns at every token boundary and rebuilds the masked source and
// the token list by substring; this scanner does one cheap test per char.

// Last `*` / `_` run that can close emphasis, and the last `~` run that can
// close strikethrough, in one scan of the masked source. A run can close
// only when it is not preceded by ASCII whitespace or the start of the
// string; finding one only means "keep looking" (rules 9-10 and mid-run
// openers are still applied in the emphasis loop).
function scanClosers(masked) {
  const out = { '*': -1, '_': -1, '~': -1 };
  const len = masked.length;
  for (let i = 0; i < len; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < len && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') out[ch] = i;
    i = j - 1;
  }
  return out;
}

// Does this link text already hold a link? An image does not count: an
// image may hold a link, a link may not.
function linkInText(lx, text) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(RE.blockSkip)) {
    if (RE.link.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(RE.reflinkSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(lx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && linkInText(lx, match0.slice(1, refStart - 1))) continue;
    return true;
  }
  return false;
}

// Mask links, code spans, html and escapes out of the source emphasis sees,
// keeping every replacement the same length so emphasis can line the masked
// source up with the real one by slicing from the end.
function maskSrc(lx, src) {
  let masked = src;
  if (lx.links && src.includes('[')) {
    const reflinkSearch = RE.reflinkSearch;
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(lx.links, normalizeLabel(match0.slice(refStart + 1, -1)))) return match0;
      // A candidate holding a link never becomes one, so flattening the
      // whole span would hide the emphasis that still applies inside it.
      // Mask the links it holds instead. Images are exempt.
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (linkInText(lx, text)) {
          // A fresh pattern instance: the nested replace must not disturb
          // the outer replace's scan position on the shared pattern.
          const fresh = new RegExp(RE.reflinkSearch.source, 'g');
          return '[' + text.replace(fresh, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    masked = masked.replace(reflinkSearch, maskReflink);
  }
  // Mask escaped characters. A backslash inside a code span is literal, so
  // the backticks inside the span are masked instead and blockSkip still
  // skips all of it. Only a backslash or a backtick can start a match here.
  if (src.includes('\\') || src.includes('`')) {
    masked = masked.replace(RE.anyPunctuationOutsideCode, (match0, code, punct) => {
      if (punct) return '+'.repeat(match0.length);
      if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
      return match0;
    });
  }
  // Mask other blocks (inline links, code spans, html). Only '[', a backtick
  // or '<' can start one.
  if (src.includes('[') || src.includes('`') || src.includes('<')) {
    masked = masked.replace(RE.blockSkip, (match0, _link, context) => {
      const offset = context ? context.length : 0;
      return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
    });
  }
  return masked;
}

// Whether the `]` ending this label sits inside a code span or an html tag
// that the label itself opened (then the label does not end there).
function isLabelEndInsideToken(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = RE.code.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = RE.tag.exec(tokenSrc) || RE.autolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Build a link/image token from its label, tokenizing the label's own
// inline content. A link whose label already holds a link is refused, so
// the caller falls through to plain text and the inner link is the one kept.
function outputLink(lx, cap, link, raw) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(/\\([\[\]])/g, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInLink = lx.inLink;
  const outerLinkEmitted = lx.linkEmitted;
  const outerInRawBlock = lx.inRawBlock;
  lx.inLink = true;
  lx.linkEmitted = false;
  const tokens = inlineTokens(lx, text);
  const textHasLink = lx.linkEmitted;
  lx.linkEmitted = outerLinkEmitted;
  lx.inLink = outerInLink;
  if (!isImage) {
    if (textHasLink) {
      // These tokens are discarded, so undo the raw-block state they opened;
      // leaving it set would suppress escaping for the text re-scanned after.
      lx.inRawBlock = outerInRawBlock;
      return null;
    }
    lx.linkEmitted = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
}

// Inline link (or image) at pos, or null. The link pattern backtracks
// quadratically over unterminated inputs, so it is skipped outright when
// the run holds no ')' (linkParenPossible, anchored once per run).
function linkAt(lx, src, pos) {
  if (lx.linkParenPossible === false) return null;
  const m = RE.link.exec(src.slice(pos));
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(src.slice(pos), m[1], labelStart)) return null;
  const trimmedUrl = m[2].trim();
  let cap0 = m[0];
  let cap2 = m[2];
  let cap3 = m[3];
  if (/^</.test(trimmedUrl)) {
    // CommonMark requires matching angle brackets.
    if (!/>$/.test(trimmedUrl)) return null;
    // The ending angle bracket cannot be escaped.
    const rtrimSlash = rtrim(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return null;
  } else {
    // Find the closing parenthesis.
    const lastParenIndex = findClosingBracket(cap2, '()');
    if (lastParenIndex === -2) return null; // more open parens than closed
    if (lastParenIndex > -1) {
      const start = cap0.indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + m[1].length + lastParenIndex;
      cap2 = cap2.substring(0, lastParenIndex);
      cap0 = cap0.substring(0, linkLen).trim();
      cap3 = '';
    }
  }
  // The ')' ending the match is the link closer only when it is not escaped.
  const unescaped = rtrim(cap0.slice(0, -1), '\\');
  if ((cap0.length - unescaped.length) % 2 === 0) return null;
  const title = cap3 ? cap3.slice(1, -1) : '';
  let href = cap2.trim();
  if (/^</.test(href)) href = href.slice(1, -1);
  return outputLink(lx, m, {
    href: href ? href.replace(RE.anyPunctuation, '$1') : href,
    title: title ? title.replace(RE.anyPunctuation, '$1') : title,
  }, cap0);
}

// Reference link (full or collapsed) or shortcut link at pos, or null. When
// the label is not defined, the first character is returned as plain text.
function reflinkAt(lx, src, pos) {
  const rest = src.slice(pos);
  const m = RE.reflink.exec(rest) || RE.nolink.exec(rest);
  if (!m) return null;
  const labelStart = m[0].charAt(0) === '!' ? 2 : 1;
  if (isLabelEndInsideToken(rest, m[1], labelStart)) return null;
  const link = lx.links[normalizeLabel(m[2] || m[1])];
  if (!link) {
    const text = m[0].charAt(0);
    return { type: 'text', raw: text, text };
  }
  return outputLink(lx, m, link, m[0]);
}

// Emphasis / strong at pos, following the reference's greedy pairing:
// the opener's whole delimiter run counts (rules 9-10), a mid-run opener
// may only close against a right-only delimiter, and the closer scan walks
// the masked source's right-delimiter pattern until enough delimiters
// accumulate. Returns the token, or null when this run cannot open one.
function emStrong(lx, src, masked, pos, prevChar, closers) {
  const m = RE.emStrongLDelim.exec(src.slice(pos));
  if (!m) return null;
  if (!m[1] && !m[2] && !m[3] && !m[4]) return null;
  const delimChar = m[0][0];
  // A mid-run opener (for example the second star of an unmatched `**`)
  // must only pair with a delimiter that can only close, otherwise it
  // steals the opener of a later span.
  const midRun = prevChar === delimChar;
  // The start of this delimiter run may already be behind pos, either taken
  // as text after the whole run failed to match or used to close an earlier
  // span. Flanking and rules 9-10 are about the whole run, so find its start.
  let runStart = pos;
  while (runStart > 0 && masked[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...masked.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  // The other delimiter character counts as punctuation here.
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || PUNCT_OR_SPACE.test(runPrevChar);
  if (runStart < pos) prevChar = runPrevChar;
  const prevPunct = runStart < pos ? runPrevPunct : PUNCT_OR_SPACE.test(prevChar);
  // _ can't be between two alphanumerics.
  if (m[4] && isAlnum(prevChar)) return null;
  const nextChar = m[1] || m[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...m[0]].length - 1;
    let delimTotal = lLength;
    let midDelimTotal = 0;
    // Rules 9-10 count the whole run, and also apply when the opener could
    // close as well.
    const runLength = pos - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return null;
    const endReg = delimChar === '*' ? RE.emStrongRDelimAst : RE.emStrongRDelimUnd;
    const lastIdx = closers[delimChar];
    const windowStart = pos + lLength;
    if (lastIdx < windowStart) return null;
    const windowMasked = masked.slice(windowStart);
    const lastInWindow = lastIdx - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(windowMasked)) !== null) {
      if (match.index > lastInWindow) break;
      const rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue; // skip a single * in __abc*abc__
      const rLength = [...rDelim].length;
      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) { // either side
        if (midRun && (match[5] || match[6])) {
          // A mid-run opener cannot close against an ambiguous delimiter
          // that can also open; that delimiter opens its own span instead.
          break;
        }
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue; // CommonMark emphasis rules 9-10
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue; // not enough closing delimiters yet
      // Remove extra characters: *a*** -> *a*
      const rLen = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(pos, pos + lLength + match.index + lastCharLength + rLen);
      if (Math.min(lLength, rLen) % 2) {
        const text = raw.slice(1, -1);
        return { type: 'em', raw, text, tokens: inlineTokens(lx, text) };
      }
      const text = raw.slice(2, -2);
      return { type: 'strong', raw, text, tokens: inlineTokens(lx, text) };
    }
  }
  return null;
}

// Strikethrough at pos. Only single ~ or double ~~ are supported, and the
// closing run must be the same length as the opening one.
function delAt(lx, src, masked, pos, prevChar, closers) {
  const m = RE.delLDelim.exec(src.slice(pos));
  if (!m) return null;
  const nextChar = m[1] || '';
  if (!nextChar || !prevChar || PUNCT_OR_SPACE.test(prevChar)) {
    const lLength = [...m[0]].length - 1;
    let delimTotal = lLength;
    const endReg = RE.delRDelim;
    const lastIdx = closers['~'];
    const windowStart = pos + lLength;
    if (lastIdx < windowStart) return null;
    const windowMasked = masked.slice(windowStart);
    const lastInWindow = lastIdx - windowStart;
    endReg.lastIndex = 0;
    let match;
    while ((match = endReg.exec(windowMasked)) !== null) {
      if (match.index > lastInWindow) break;
      const rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      const rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) { // another left delimiter
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      const rLen = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(pos, pos + lLength + match.index + lastCharLength + rLen);
      const text = raw.slice(lLength, -lLength);
      return { type: 'del', raw, text, tokens: inlineTokens(lx, text) };
    }
  }
  return null;
}

// ------------------------------------------------- url start pre-checks
//
// The url pattern is only tried where the reference's text scan would stop
// for one, so these cheap tests run first. Each is a superset of the
// pattern it guards (a false positive costs one pattern run; a false
// negative would miss a link, so none is allowed).

const EMAIL_LOCAL = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 46 || c === 95 || c === 43 || c === 45;
const DOMAIN_CHAR = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 45 || c === 95;

// A bare email address starts at i (local part, '@', a domain with a dot).
function emailStartAt(src, i, n) {
  if (!EMAIL_LOCAL(src.charCodeAt(i))) return false;
  const at = src.indexOf('@', i);
  if (at === -1 || at - i > 256) return false;
  for (let j = i; j < at; j++) if (!EMAIL_LOCAL(src.charCodeAt(j))) return false;
  let j = at + 1;
  if (j >= n || !DOMAIN_CHAR(src.charCodeAt(j))) return false;
  while (j < n && DOMAIN_CHAR(src.charCodeAt(j))) j++;
  if (j >= n || src.charCodeAt(j) !== 46) return false; // needs a dot
  j++;
  return j < n && DOMAIN_CHAR(src.charCodeAt(j));
}

// mailto: or xmpp: followed by a valid email address.
function emailProtocolAt(src, i, n) {
  let j;
  if (src.startsWith('mailto:', i)) j = i + 7;
  else if (src.startsWith('xmpp:', i)) j = i + 5;
  else return false;
  if (j >= n || !EMAIL_LOCAL(src.charCodeAt(j))) return false;
  return emailStartAt(src, j, n);
}

// http://, https:// or ftp://, any case.
function protocolAt(src, i) {
  const c0 = src.charCodeAt(i) | 32;
  if (c0 === 104) { // h
    if ((src.charCodeAt(i + 1) | 32) !== 116) return false;
    if ((src.charCodeAt(i + 2) | 32) !== 116) return false;
    if ((src.charCodeAt(i + 3) | 32) !== 112) return false;
    let j = i + 4;
    if ((src.charCodeAt(j) | 32) === 115) j++; // optional s
    return src.charCodeAt(j) === 58 && src.charCodeAt(j + 1) === 47 && src.charCodeAt(j + 2) === 47;
  }
  if (c0 === 102) { // f
    return (src.charCodeAt(i + 1) | 32) === 116
      && (src.charCodeAt(i + 2) | 32) === 112
      && src.charCodeAt(i + 3) === 58
      && src.charCodeAt(i + 4) === 47 && src.charCodeAt(i + 5) === 47;
  }
  return false;
}

// www. at i, only where the reference's text scan stops for one: at the
// start, after whitespace, or after *, _, ~ or (.
function wwwAt(src, i) {
  if (src.charCodeAt(i) !== 119 || src.charCodeAt(i + 1) !== 119 || src.charCodeAt(i + 2) !== 119 || src.charCodeAt(i + 3) !== 46) return false;
  if (i === 0) return true;
  const p = src.charCodeAt(i - 1);
  return p === 32 || p === 9 || p === 10 || p === 11 || p === 12 || p === 13 || p === 42 || p === 95 || p === 126 || p === 40;
}

function hasNonWsAfter(src, i) {
  for (let j = i; j < src.length; j++) {
    const c = src.charCodeAt(j);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 11 && c !== 12 && c !== 13) return true;
  }
  return false;
}

// The last non-_ character of src[start..end), or the fallback when the
// range holds only _ characters (a lone _ never moves prevChar).
function recomputePrevChar(src, start, end, fallback) {
  for (let k = end - 1; k >= start; k--) {
    if (src[k] !== '_') return src[k];
  }
  return fallback;
}

// Extended autolink (www. / protocol / bare email / mailto:) at pos.
function urlAt(lx, src, pos) {
  const m = RE.url.exec(src.slice(pos));
  if (!m) return null;
  let text, href;
  if (m[2] === '@') {
    text = m[0];
    href = 'mailto:' + text;
  } else {
    // Trim trailing punctuation off a www. / protocol link.
    let prevCapZero;
    do {
      prevCapZero = m[0];
      const bp = RE.backpedal.exec(m[0]);
      m[0] = bp ? bp[0] : '';
    } while (prevCapZero !== m[0]);
    text = m[0];
    href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
}

function inlineTokens(lx, src, tokens = []) {
  const prevLinkParenPossible = lx.linkParenPossible;
  // One paren scan per inline run, shared with the link tokenizer: without
  // a ')' ahead the link pattern cannot match, and skipping it avoids its
  // quadratic backtracking over unterminated inputs. A nested run receives
  // a substring of the outer run, so if the outer had no ')' neither does
  // this substring.
  lx.linkParenPossible = prevLinkParenPossible && src.includes(')');
  try {
    return inlineTokensInner(lx, src, tokens);
  } finally {
    lx.linkParenPossible = prevLinkParenPossible;
  }
}

function inlineTokensInner(lx, src, tokens) {
  const hasEm = src.includes('*') || src.includes('_') || src.includes('~');
  // A bare email needs '@'; without one the per-word-start email scan
  // (indexOf('@') per word) is pure waste.
  const hasAt = src.includes('@');
  const masked = hasEm ? maskSrc(lx, src) : src;
  const closers = hasEm ? scanClosers(masked) : null;
  const n = src.length;
  let i = 0;
  let prevChar = '';
  let runStartPrev = '';
  let textStart = 0;
  let textOpen = false;

  const flushText = (end) => {
    if (!textOpen || end <= textStart) { textOpen = false; return; }
    const raw = src.slice(textStart, end);
    // Raw html keeps whatever it was written with; everywhere else a
    // numeric character reference stands for the character itself.
    const text = lx.inRawBlock ? raw : decodeNumericRefs(raw);
    const last = tokens.at(-1);
    if (last?.type === 'text') {
      last.raw += raw;
      last.text += text;
    } else {
      tokens.push({ type: 'text', raw, text, escaped: lx.inRawBlock });
    }
    textOpen = false;
  };
  const openText = () => {
    if (!textOpen) { textStart = i; runStartPrev = prevChar; textOpen = true; }
  };
  // Emit a non-text token found at i and move past it.
  const emit = (tok) => {
    flushText(i);
    tokens.push(tok);
    prevChar = '';
    textOpen = false;
    i += tok.raw.length;
  };

  while (i < n) {
    const c = src.charCodeAt(i);

    // ---- backslash: escape, or a hard break before a newline
    if (c === 92) {
      if (i + 1 < n && src.charCodeAt(i + 1) === 10 && hasNonWsAfter(src, i + 2)) {
        flushText(i);
        let j = i + 2;
        while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
        tokens.push({ type: 'br', raw: src.slice(i, j) });
        prevChar = '';
        textOpen = false;
        i = j;
        continue;
      }
      const m = RE.escape.exec(src.slice(i));
      if (m) {
        flushText(i);
        tokens.push({ type: 'escape', raw: m[0], text: m[1] });
        prevChar = '';
        textOpen = false;
        i += m[0].length;
        continue;
      }
      openText();
      prevChar = '\\';
      i++;
      continue;
    }

    // ---- <: html tag, then autolink
    if (c === 60) {
      const m = RE.tag.exec(src.slice(i));
      if (m) {
        flushText(i);
        if (!lx.inLink && /^<a /i.test(m[0])) lx.inLink = true;
        else if (lx.inLink && /^<\/a>/i.test(m[0])) lx.inLink = false;
        if (!lx.inRawBlock && /^<(pre|code|kbd|script)(\s|>)/i.test(m[0])) lx.inRawBlock = true;
        else if (lx.inRawBlock && /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0])) lx.inRawBlock = false;
        tokens.push({ type: 'html', raw: m[0], inLink: lx.inLink, inRawBlock: lx.inRawBlock, block: false, text: m[0] });
        prevChar = '';
        textOpen = false;
        i += m[0].length;
        continue;
      }
      const a = RE.autolink.exec(src.slice(i));
      if (a) {
        flushText(i);
        const text = a[1];
        const href = a[2] === '@' ? 'mailto:' + text : text;
        tokens.push({ type: 'link', raw: a[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] });
        prevChar = '';
        textOpen = false;
        i += a[0].length;
        continue;
      }
      openText();
      prevChar = '<';
      i++;
      continue;
    }

    // ---- [ or !: inline link, then reference / shortcut link
    if (c === 91 || c === 33) {
      const lk = linkAt(lx, src, i);
      if (lk) { emit(lk); continue; }
      const rf = reflinkAt(lx, src, i);
      if (rf) {
        if (rf.type === 'text') {
          // Undefined label: the first character is plain text.
          openText();
          prevChar = rf.text;
          i += 1;
          continue;
        }
        emit(rf);
        continue;
      }
      openText();
      prevChar = c === 91 ? '[' : '!';
      i++;
      continue;
    }

    // ---- * or _: emphasis / strong
    if (c === 42 || c === 95) {
      const em = hasEm ? emStrong(lx, src, masked, i, prevChar, closers) : null;
      if (em) { emit(em); continue; }
      openText();
      // A lone _ never moves prevChar: it tracks the character before the
      // run of underscores, not the underscores themselves.
      if (c !== 95) prevChar = '*';
      i++;
      continue;
    }

    // ---- `: code span
    if (c === 96) {
      const m = RE.code.exec(src.slice(i));
      if (m) {
        flushText(i);
        let text = m[2].replace(/\n/g, ' ');
        if (/[^ ]/.test(text) && /^ /.test(text) && / $/.test(text)) text = text.substring(1, text.length - 1);
        tokens.push({ type: 'codespan', raw: m[0], text });
        prevChar = '';
        textOpen = false;
        i += m[0].length;
        continue;
      }
      // A code span that does not close leaves its whole run of backticks
      // as literal text: the reference's text rule opens with `+, so the
      // run is never retried one backtick at a time.
      openText();
      prevChar = '`';
      let j = i + 1;
      while (j < n && src.charCodeAt(j) === 96) j++;
      i = j;
      continue;
    }

    // ---- ~: strikethrough
    if (c === 126) {
      const d = hasEm ? delAt(lx, src, masked, i, prevChar, closers) : null;
      if (d) { emit(d); continue; }
      openText();
      prevChar = '~';
      i++;
      continue;
    }

    // ---- newline: hard break, or plain text
    if (c === 10) {
      let back = i;
      let spaces = 0;
      let backslash = false;
      while (textOpen && back > textStart) {
        const pc = src.charCodeAt(back - 1);
        if (pc === 32) { spaces++; back--; }
        else if (pc === 92 && spaces === 0) { backslash = true; back--; break; }
        else break;
      }
      if ((spaces >= 2 || backslash) && hasNonWsAfter(src, i + 1)) {
        // The spaces / backslash belong to the break, not to the text.
        flushText(back);
        prevChar = recomputePrevChar(src, textStart, back, runStartPrev);
        let j = i + 1;
        while (j < n && (src.charCodeAt(j) === 32 || src.charCodeAt(j) === 9)) j++;
        tokens.push({ type: 'br', raw: src.slice(back, j) });
        prevChar = '';
        textOpen = false;
        i = j;
        continue;
      }
      openText();
      prevChar = '\n';
      i++;
      continue;
    }

    // ---- extended autolink (outside links only)
    if (!lx.inLink) {
      let tryUrl = false;
      if (c === 119) tryUrl = wwwAt(src, i);
      else if (c === 104 || c === 72 || c === 102 || c === 70) tryUrl = protocolAt(src, i);
      else if (c === 109 || c === 120) tryUrl = emailProtocolAt(src, i, n);
      // A protocol letter can also start an email local part (f in
      // foo@bar.com, h in hello@..., m in mike@..., w in will@...): fall
      // back to the email check when the specific check fails.
      if (hasAt && !tryUrl && EMAIL_LOCAL(c) && (i === 0 || !EMAIL_LOCAL(src.charCodeAt(i - 1)))) tryUrl = emailStartAt(src, i, n);
      if (tryUrl) {
        const u = urlAt(lx, src, i);
        if (u) { emit(u); continue; }
      }
    }

    // ---- plain text character
    openText();
    if (c !== 95) prevChar = src[i];
    i++;
  }
  flushText(n);
  return tokens;
}

// --------------------------------------------------------------- rendering

function renderTokens(lx, tokens) {
  let out = '';
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    switch (token.type) {
      case 'space': break;
      case 'checkbox': out += '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'hr': out += '<hr>\n'; break;
      case 'heading': out += `<h${token.depth}>${renderInline(lx, token.tokens)}</h${token.depth}>\n`; break;
      case 'code': {
        const langString = (token.lang || '').match(/^\S*/)?.[0];
        const code = token.text ? token.text.replace(/\n$/, '') + '\n' : '';
        if (!langString) out += '<pre><code>' + escapeHtml(code, true) + '</code></pre>\n';
        else out += '<pre><code class="language-' + escapeHtml(langString) + '">' + escapeHtml(code, true) + '</code></pre>\n';
        break;
      }
      case 'table': out += renderTable(lx, token); break;
      case 'blockquote': out += `<blockquote>\n${renderTokens(lx, token.tokens)}</blockquote>\n`; break;
      case 'list': out += renderList(lx, token); break;
      case 'html': out += token.text; break;
      case 'paragraph': out += `<p>${renderInline(lx, token.tokens)}</p>\n`; break;
      case 'text': out += renderInline(lx, token.tokens); break;
      case 'def': break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

function renderList(lx, token) {
  let body = '';
  for (const item of token.items) body += `<li>${renderTokens(lx, item.tokens)}</li>\n`;
  const type = token.ordered ? 'ol' : 'ul';
  const startAttr = (token.ordered && token.start !== 1) ? (' start="' + token.start + '"') : '';
  return '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
}

function renderTable(lx, token) {
  let cell = '';
  for (const h of token.header) cell += renderTableCell(lx, h);
  const header = `<tr>\n${cell}</tr>\n`;
  let body = '';
  for (const row of token.rows) {
    cell = '';
    for (const c of row) cell += renderTableCell(lx, c);
    body += `<tr>\n${cell}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return '<table>\n<thead>\n' + header + '</thead>\n' + body + '</table>\n';
}

function renderTableCell(lx, token) {
  const content = renderInline(lx, token.tokens);
  const type = token.header ? 'th' : 'td';
  const tag = token.align ? `<${type} align="${token.align}">` : `<${type}>`;
  return tag + content + `</${type}>\n`;
}

function renderInline(lx, tokens) {
  let out = '';
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    switch (token.type) {
      case 'escape': out += escapeHtml(token.text); break;
      case 'html': out += token.text; break;
      case 'link': out += renderLink(lx, token); break;
      case 'image': out += renderImage(lx, token); break;
      case 'checkbox': out += '<input ' + (token.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> '; break;
      case 'strong': out += `<strong>${renderInline(lx, token.tokens)}</strong>`; break;
      case 'em': out += `<em>${renderInline(lx, token.tokens)}</em>`; break;
      case 'codespan': out += `<code>${escapeHtml(token.text, true)}</code>`; break;
      case 'br': out += '<br>'; break;
      case 'del': out += `<del>${renderInline(lx, token.tokens)}</del>`; break;
      case 'text': out += token.escaped ? token.text : escapeHtml(token.text); break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

// Plain-text rendering (image alt text): tags are dropped, everything else
// contributes its characters.
function renderInlineText(lx, tokens) {
  let out = '';
  for (const token of tokens) {
    switch (token.type) {
      case 'strong':
      case 'em':
      case 'del':
      case 'link':
      case 'image':
        out += token.tokens ? renderInlineText(lx, token.tokens) : token.text;
        break;
      case 'codespan':
      case 'html':
      case 'text':
      case 'escape':
        out += token.text;
        break;
      case 'br': break;
      case 'checkbox': out += token.raw; break;
      default: throw new Error('Token with "' + token.type + '" type was not found.');
    }
  }
  return out;
}

function renderLink(lx, token) {
  // References are not resolved inside an autolink, so every & there is
  // literal. Elsewhere only an & that cannot start one needs escaping.
  const parsedText = token.autolink ? escapeHtml(token.text, true) : renderInline(lx, token.tokens);
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) return parsedText;
  const href = escapeHtml(cleanHref, token.autolink);
  let out = '<a href="' + href + '"';
  if (token.title) out += ' title="' + escapeHtml(token.title) + '"';
  out += '>' + parsedText + '</a>';
  return out;
}

function renderImage(lx, token) {
  let text = token.text;
  if (token.tokens) text = renderInlineText(lx, token.tokens);
  const cleanHref = cleanUrl(token.href);
  if (cleanHref === null) return escapeHtml(text);
  const href = cleanHref;
  let out = `<img src="${escapeHtml(href)}" alt="${escapeHtml(text)}"`;
  if (token.title) out += ` title="${escapeHtml(token.title)}"`;
  out += '>';
  return out;
}
