// SDOC Slides — the Claude Slides subset, as data, and a validator for it.
//
// A deck published to a Claude Slides artifact is checked by nothing. The page
// drops what it does not understand and heals what it can, silently, so a file
// outside the subset does not fail — it arrives wrong, and the author finds out
// by looking. That is the whole reason this module exists: the export has to
// refuse to emit anything the page would quietly change.
//
// The rules below are transcribed from the Slides type's own
// `artifact-type/reference/format.md`, read on 2026-10-01 from type release
// 1790884704-b2eb, contract 0.2.47. They are a transcription, not an
// interpretation: when the type changes, re-read that file and update the
// tables here rather than patching the checks that consume them.
//
// Zero dependencies, and the parser is in here too — the subset is closed, so
// a general HTML parser would be more than the job needs and harder to trust.

const SUBSET_RELEASE = "1790884704-b2eb";
const SUBSET_CONTRACT = "0.2.47";

// The canvas is fixed. A theme's design box is almost never this, so the
// exporter scales; see slide-artifact.js.
const CANVAS = { w: 1920, h: 1080 };

// Advisory, not enforced by the page: the type calls 128px the margins and
// asks for 24px type. Both are warnings here, never errors, because a deck
// that breaks them still publishes and still reads.
const MARGIN = 128;
const MIN_FONT_SIZE = 24;
const MAX_NOTES = 4000;
const MAX_ELEMENTS = 200;
const MAX_PINNED_PER_HOST = 24;
const MAX_DIV_DEPTH = 15;
const MAX_TABLE_ROWS = 100;
const MAX_TABLE_COLS = 24;
const MAX_TABLE_CELLS = 4000;
const MAX_SVG_BYTES = 52 * 1024;
const MAX_EMBED_BYTES = 16 * 1024;
const MAX_EMBEDS = 8;
const MAX_TEXT_CHARS = 20000;
const MAX_INLINE_MARKS = 100;

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

const TEXT_TAGS = new Set(["h1", "h2", "h3", "p", "ul", "ol"]);
const INLINE_TAGS = new Set(["b", "i", "u", "a", "span", "br"]);
const VOID_TAGS = new Set(["br", "hr", "img", "x-shape", "x-icon", "x-connector"]);

const ALLOWED_TAGS = new Set([
  "section", "div", "aside",
  ...TEXT_TAGS, "li",
  ...INLINE_TAGS,
  "img", "table", "tr", "th", "td", "svg",
  "hr", "x-shape", "x-icon", "x-connector", "x-embed",
]);

// Everything inside an <svg> is passed through: the page treats a drawing as
// one opaque graphic. Only the svg element itself is checked.
const SVG_OPAQUE = true;

const X_SHAPE_KINDS = new Set([
  "rect", "rounded", "ellipse", "diamond",
  "arrow-right", "arrow-left", "arrow-up", "arrow-down", "line",
]);

const X_ICON_NAMES = new Set([
  "Activity", "Book", "Chart", "Chat", "Check", "CheckCircle", "Clock", "Cloud",
  "Code", "Database", "Globe", "GraduationCap", "Home", "Key", "Lightbulb",
  "Lightning", "Link", "Lock", "PaperPlane", "Play", "Search", "Settings",
  "Star", "ThumbsUp", "Tool", "Trust", "Users", "Verified", "Warning", "Wrench",
]);

const X_CONNECTOR_ROUTES = new Set(["straight", "hv", "vh", "elbow"]);
const X_CONNECTOR_HEADS = new Set(["end", "both", "none"]);

// Faces that resolve on any machine, so a stack may end on one before its
// generic. From the type's fonts.md.
const BASIC_FACES = new Set([
  "Arial", "Verdana", "Tahoma", "Trebuchet MS", "Georgia",
  "Times New Roman", "Courier New", "Brush Script MT",
]);
const GENERIC_FACES = new Set(["serif", "sans-serif", "monospace", "cursive"]);

// ---------------------------------------------------------------------------
// Value grammars
//
// LEN is px only. The subset's single most common failure is a length that
// carried an em, a rem or a percentage through from a theme, so this is strict
// and says which unit it found.
// ---------------------------------------------------------------------------

const RE_LEN = /^-?\d*\.?\d+(px)?$/;
const RE_PCT = /^-?\d*\.?\d+%$/;
const RE_NUM = /^-?\d*\.?\d+$/;
const RE_ANGLE = /^-?\d*\.?\d+(deg|turn|rad)$/;
const RE_HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const RE_FUNC_COLOR = /^(rgb|rgba|hsl|hsla)\(/i;
const RE_BAD_UNIT = /\d(em|rem|vw|vh|vmin|vmax|ch|ex|pt|cm|mm|in|pc)\b/i;
const RE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const RE_BLOB = /^\/?_blob\/[A-Za-z0-9_-]+$/;

// What an export writes before its assets have been uploaded. An image cannot
// carry its final `/_blob/<id>` until the publish step has put the file on the
// artifact and been told the id, so the export emits this and
// tools/artifact-resolve-assets.js rewrites it afterwards — and exits non-zero
// if any survive. It is only ever valid in that window: callers opt in with
// `assetPlaceholders`, and a file being published still fails on one.
const RE_ASSET_PLACEHOLDER = /^sdoc-asset:[^"'\s>]+$/;
const RE_DS_PATH = /^project\/ds\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+$/;

const ALIGN_WORDS = new Set([
  "start", "center", "end", "stretch", "baseline",
  "flex-start", "flex-end", "self-start", "self-end",
]);

function isLen(v) { return RE_LEN.test(v.trim()); }
function isPct(v) { return RE_PCT.test(v.trim()); }
function isNum(v) { return RE_NUM.test(v.trim()); }

// What `color-mix(in srgb, …)` computes to in Chrome. The subset has no such
// function, so the exporter converts it to rgba() before emitting; this is here
// so the two agree about what one looks like.
const RE_COLOR_SRGB =
  /^color\(\s*srgb\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*(?:\/\s*([0-9.]+)\s*)?\)$/;

// `color(srgb 0 0.82 0.85 / 0.1)` -> `rgba(0, 209, 217, 0.1)`, or null if it is
// not that shape. Chrome serialises a color-mix() this way and nothing else in
// the pipeline knows the function, so it has to be normalised at the edge.
function srgbToRgba(v) {
  const m = RE_COLOR_SRGB.exec(String(v).trim().toLowerCase());
  if (!m) return null;
  const ch = (x) => Math.max(0, Math.min(255, Math.round(parseFloat(x) * 255)));
  const alpha = m[4] === undefined ? 1 : Math.max(0, Math.min(1, parseFloat(m[4])));
  const rgb = `${ch(m[1])}, ${ch(m[2])}, ${ch(m[3])}`;
  return alpha >= 1 ? `rgb(${rgb})` : `rgba(${rgb}, ${alpha})`;
}

function isColor(v) {
  const t = v.trim().toLowerCase();
  if (t === "transparent") return true;
  if (t === "currentcolor") return false; // explicitly not in the subset
  if (t.includes("var(")) return false;
  if (RE_COLOR_SRGB.test(t)) return true;
  return RE_HEX.test(t) || RE_FUNC_COLOR.test(t) || /^[a-z]+$/.test(t);
}

function lenValue(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : null;
}

// A declaration's value, checked against the grammar its property allows.
// Returns null when fine, or a reason.
function checkValue(prop, raw) {
  const v = raw.trim();
  const lower = v.toLowerCase();

  if (lower.includes("var(")) return "var() is not in the subset";
  if (lower.includes("calc(") && !/^(left|top)$/.test(prop)) {
    return "calc() is allowed on left and top only";
  }

  switch (prop) {
    case "position":
      return /^(absolute|relative)$/.test(lower) ? null : "expected absolute or relative";
    case "left": case "top": case "right": case "bottom":
      if (lower === "auto" || isLen(v) || isPct(v)) return null;
      if (/^(left|top)$/.test(prop) && lower.startsWith("calc(")) return null;
      return "expected a px length, a percentage or auto";
    case "width": case "height":
      return lower === "auto" || isLen(v) || isPct(v) ? null : "expected a px length, a percentage or auto";
    case "min-width":
      return isLen(v) || lower === "min-content" || lower === "max-content"
        ? null : "expected a px length, min-content or max-content";
    case "min-height": case "max-width": case "max-height":
      return isLen(v) ? null : "expected a px length";
    case "display":
      return /^(flex|grid|none)$/.test(lower) ? null : "expected flex, grid or none";
    case "flex-direction":
      return /^(row|column)(-reverse)?$/.test(lower) ? null : "expected row or column";
    case "flex-wrap":
      return /^(wrap|nowrap)$/.test(lower) ? null : "expected wrap or nowrap";
    case "gap": {
      if (!isLen(v)) return "expected one px length";
      const n = lenValue(v);
      return n >= 0 && n <= 512 ? null : "gap must be 0-512px";
    }
    case "align-items": case "align-self": case "justify-items": case "justify-self":
      if (lower === "auto") return null;
      return ALIGN_WORDS.has(lower) ? null : "expected an alignment keyword";
    case "justify-content":
      return /^(start|center|end|flex-start|flex-end|space-between|space-around|space-evenly)$/.test(lower)
        ? null : "expected a justify-content keyword";
    case "flex":
      if (/^(none|auto)$/.test(lower)) return null;
      return /^\d*\.?\d+(\s+\d*\.?\d+)?(\s+(\d*\.?\d+px|0%|auto))?$/.test(lower)
        ? null : "expected none, auto, or 1-3 flex values";
    case "flex-grow": case "flex-shrink":
      return isNum(v) ? null : "expected a number";
    case "flex-basis":
      return isLen(v) || lower === "auto" ? null : "expected a px length or auto";
    case "grid-template-columns": case "grid-template-rows": {
      if (/minmax|auto-fill|auto-fit|\[/.test(lower)) return "minmax, auto-fill and line names are not in the subset";
      const tracks = lower.replace(/repeat\(\s*\d+\s*,([^)]*)\)/g, "$1").trim().split(/\s+/).filter(Boolean);
      if (tracks.length > MAX_TABLE_COLS) return `at most ${MAX_TABLE_COLS} tracks`;
      for (const t of tracks) {
        if (!(isLen(t) || /^\d*\.?\d+fr$/.test(t) || t === "auto")) return `track "${t}" is not a px length, fr or auto`;
      }
      return null;
    }
    case "grid-column": case "grid-row":
      return /^span\s+\d+$/.test(lower) ? null : "expected span N";
    case "aspect-ratio":
      return /^\d*\.?\d+(\s*\/\s*\d*\.?\d+)?$/.test(lower) ? null : "expected N or N / N";
    case "padding": {
      const parts = v.split(/\s+/);
      if (parts.length < 1 || parts.length > 4) return "expected 1-4 px lengths";
      for (const p of parts) {
        if (!isLen(p)) return `"${p}" is not a px length`;
        const n = lenValue(p);
        if (n < 0 || n > 256) return "padding must be 0-256px";
      }
      return null;
    }
    case "overflow":
      return /^(hidden|visible)$/.test(lower) ? null : "expected hidden or visible";
    case "font-family":
      return null; // checked separately against declared faces
    case "font-size": {
      if (!isLen(v)) return "expected a px length";
      const n = lenValue(v);
      return n >= 8 && n <= 400 ? null : "font-size must be 8-400px";
    }
    case "font-weight":
      if (/^(normal|bold)$/.test(lower)) return null;
      return /^[1-9]00$/.test(lower) ? null : "expected a whole hundred, normal or bold";
    case "font-style":
      return /^(normal|italic)$/.test(lower) ? null : "expected normal or italic";
    case "line-height":
      return isNum(v) || isPct(v) || isLen(v) ? null : "expected a number, percentage or px length";
    case "letter-spacing":
      if (lower === "normal") return null;
      return isLen(v) || /^-?\d*\.?\d+em$/.test(lower) ? null : "expected a px length, an em or normal";
    case "text-align":
      return /^(left|center|right|justify)$/.test(lower) ? null : "expected left, center, right or justify";
    case "text-transform":
      return /^(none|uppercase|lowercase|capitalize)$/.test(lower) ? null : "expected a text-transform keyword";
    case "white-space":
      return /^(normal|nowrap)$/.test(lower) ? null : "expected normal or nowrap";
    case "font-variant-numeric":
      return /^(normal|tabular-nums)$/.test(lower) ? null : "expected normal or tabular-nums";
    case "opacity": {
      if (!isNum(v)) return "expected a number";
      const n = parseFloat(v);
      return n >= 0 && n <= 1 ? null : "opacity must be 0-1";
    }
    case "object-fit":
      return /^(cover|contain)$/.test(lower) ? null : "expected cover or contain";
    case "color": case "background-color":
      return isColor(v) ? null : "expected a colour";
    case "background":
      if (/gradient\(/.test(lower)) return checkGradient(lower);
      return isColor(v) ? null : "expected a colour or a gradient";
    case "border": case "border-top": case "border-right":
    case "border-bottom": case "border-left":
      return checkBorder(v);
    // A connector's stroke is set with these two rather than the shorthand,
    // which is why they are allowed on x-connector and nowhere else.
    case "border-width": {
      if (!isLen(v)) return "expected a px length";
      const n = lenValue(v);
      return n >= 0 && n <= 32 ? null : "a connector's stroke must be 0-32px";
    }
    case "border-style":
      return /^(solid|dashed|dotted|double|none)$/.test(lower)
        ? null : "expected solid, dashed, dotted, double or none";
    case "border-radius": {
      const parts = v.split(/\s+/);
      if (parts.length > 4) return "expected 1-4 values";
      for (const p of parts) if (!isLen(p) && !isPct(p)) return `"${p}" is not a px length or percentage`;
      return null;
    }
    case "transform":
      return checkTransform(v);
    case "text-decoration":
      return /^(none|underline|line-through)/.test(lower) ? null : "expected none, underline or line-through";
    case "box-shadow": case "text-shadow": case "filter": case "backdrop-filter":
    case "mix-blend-mode": case "background-clip": case "-webkit-text-fill-color":
    case "-webkit-text-stroke":
      return null; // in the subset; ranges are not re-checked here
    case "margin": case "box-sizing": case "grid-template":
      return null; // accepted as a no-op by the page
    default:
      return "not a property in the subset";
  }
}

// `transform: translate(…) rotate(…) scale(…) skew…(…)`, each at most once and
// in that order. scale takes ONE number between 0.5 and 2 — so there is no way
// to mirror anything, which is why a background flip cannot be exported.
function checkTransform(v) {
  const fns = v.trim().match(/[a-zA-Z]+\([^)]*\)/g) || [];
  if (!fns.length) return "expected one or more transform functions";
  const order = ["translate", "translatex", "translatey", "rotate", "scale", "skew", "skewx", "skewy"];
  let last = -1;
  for (const fn of fns) {
    const name = fn.slice(0, fn.indexOf("(")).toLowerCase();
    const arg = fn.slice(fn.indexOf("(") + 1, -1).trim();
    const idx = order.indexOf(name);
    if (idx === -1) return `${name}() is not in the subset`;
    if (idx < last) return "transform functions must be in the order translate, rotate, scale, skew";
    last = idx;
    if (name === "scale") {
      if (!isNum(arg)) return "scale takes one number";
      const n = parseFloat(arg);
      if (n < 0.5 || n > 2) return "scale must be 0.5-2 — a negative scale, and so a mirror, is not in the subset";
    }
    if (name === "rotate" && !RE_ANGLE.test(arg)) return "rotate takes an angle";
  }
  return null;
}

function checkGradient(v) {
  if (!/^(repeating-)?(linear|radial)-gradient\(/.test(v)) return "expected a linear or radial gradient";
  const stops = v.split(",").length - 1;
  if (stops < 1) return "a gradient needs at least 2 stops";
  if (stops > 8) return "at most 8 stops";
  if (/url\(/.test(v)) return "a gradient may not reference a url";
  return null;
}

function checkBorder(v) {
  const t = v.trim().toLowerCase();
  if (t === "none") return null;
  if (!/\b(solid|dashed|dotted|double|none)\b/.test(t)) return "a border needs a style word (solid, dashed, dotted or double)";
  const width = t.match(/(-?\d*\.?\d+)px/);
  if (width) {
    const n = parseFloat(width[1]);
    if (n < 0 || n > 32) return "border width must be 0-32px";
  }
  if (RE_BAD_UNIT.test(t)) return "border width must be a px length";
  return null;
}

// ---------------------------------------------------------------------------
// Which properties each kind of element may carry
// ---------------------------------------------------------------------------

// Arranging children is for a section or a div only — the format lists
// display, gap, align-items, justify-content, flex-direction, flex-wrap and
// justify-items against those two tags and no others. A <p> carrying them is
// admissible-looking output whose layout the page silently drops, so a row of
// marks meant to sit side by side arrives stacked.
const FLOW_PROPS = [
  "display", "flex-direction", "flex-wrap", "gap", "align-items", "justify-content",
  "justify-items", "grid-template-columns", "grid-template-rows",
];
const LAYOUT_PROPS = [...FLOW_PROPS, "padding", "overflow"];
const BOX_PROPS = [
  "position", "left", "top", "right", "bottom", "width", "height",
  "min-width", "min-height", "max-width", "max-height",
  "flex", "flex-grow", "flex-shrink", "flex-basis", "align-self", "justify-self",
  "grid-column", "grid-row", "aspect-ratio",
  "background", "background-color", "border", "border-top", "border-right",
  "border-bottom", "border-left", "border-radius", "box-shadow", "opacity",
  "transform", "filter", "backdrop-filter", "mix-blend-mode",
  "margin", "box-sizing", "grid-template",
];
const TYPE_PROPS = [
  "font-family", "font-size", "font-weight", "font-style", "line-height",
  "letter-spacing", "text-align", "text-transform", "white-space",
  "text-decoration", "font-variant-numeric", "color", "text-shadow",
  "background-clip", "-webkit-text-fill-color", "-webkit-text-stroke",
];

const PROPS_FOR_TAG = {
  section: new Set([...LAYOUT_PROPS, ...BOX_PROPS, ...TYPE_PROPS]),
  div: new Set([...LAYOUT_PROPS, ...BOX_PROPS, ...TYPE_PROPS]),
  img: new Set([...BOX_PROPS, "object-fit"]),
  table: new Set([...BOX_PROPS, ...TYPE_PROPS, "padding"]),
  tr: new Set(["background", "background-color"]),
  // A cell takes far less than a text element. From the reference's own table:
  // `color · text span td/th`, `text-align · text td/th`, `width · td/th`,
  // `padding · td/th: one per table`, and `font-weight · text th` — th only.
  // `font-family` and `font-size` read `· text table`, so they belong to the
  // <table>, not its cells; the Tables section says as much in prose ("set
  // font-family, font-size, or color on the <table>, or it inherits them").
  // And `background` reads `… table x-icon; tr: COLOR` — a row, never a cell.
  //
  // This set said TYPE_PROPS plus background for both, which passed output the
  // page then drops: per-cell faces and sizes that silently become the table's,
  // and a cell background that silently becomes nothing.
  th: new Set(["color", "text-align", "width", "padding", "font-weight"]),
  td: new Set(["color", "text-align", "width", "padding"]),
  svg: new Set([...BOX_PROPS]),
  hr: new Set([...BOX_PROPS, "color"]),
  "x-shape": new Set([...BOX_PROPS]),
  "x-icon": new Set([...BOX_PROPS, "color"]),
  "x-connector": new Set(["color", "border", "border-width", "border-style", "opacity"]),
  "x-embed": new Set(["position", "left", "top", "right", "bottom", "width", "height", "opacity"]),
  // A span carries colour and nothing else. This is the rule that forces the
  // exporter to bake text case rather than lean on text-transform: a protected
  // unit cannot be given its own font or transform here.
  span: new Set(["color"]),
  a: new Set(["color", "text-decoration"]),
  b: new Set([]), i: new Set([]), u: new Set([]), br: new Set([]),
  li: new Set([...TYPE_PROPS]),
  aside: new Set([]),
};
for (const tag of TEXT_TAGS) {
  // Box and type, plus padding and overflow — but not the flow properties,
  // which belong to a section or a div.
  PROPS_FOR_TAG[tag] = new Set([...BOX_PROPS, ...TYPE_PROPS, "padding", "overflow"]);
}

// ---------------------------------------------------------------------------
// A parser for the subset
//
// Exported, because the diff tool reads pulled slides with it too. It is not a
// general HTML parser: it understands the tags above, quoted attributes, void
// elements and text, and it reports anything else as malformed rather than
// guessing, which is the behaviour a validator wants.
// ---------------------------------------------------------------------------

function parseSubsetHtml(html) {
  const errors = [];
  const root = { tag: "#root", attrs: {}, children: [], parent: null };
  let node = root;
  let i = 0;

  const pos = (at) => {
    const upto = html.slice(0, at);
    const line = upto.split("\n").length;
    const col = at - upto.lastIndexOf("\n");
    return `${line}:${col}`;
  };

  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      const text = html.slice(i);
      if (text.trim()) node.children.push({ tag: "#text", value: text });
      break;
    }
    if (lt > i) {
      const text = html.slice(i, lt);
      if (text.trim()) node.children.push({ tag: "#text", value: text });
    }

    // Comments pass through untouched.
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt);
      i = end === -1 ? html.length : end + 3;
      continue;
    }

    const gt = html.indexOf(">", lt);
    if (gt === -1) {
      errors.push({ at: pos(lt), message: "unclosed tag" });
      break;
    }
    const raw = html.slice(lt + 1, gt).trim();

    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      // Shapes, icons and connectors hold no content, so they are parsed as
      // void — but an author may still write the closing tag. Consume it
      // silently rather than reporting a stray close, which would bury the
      // real complaint about the element itself.
      if (VOID_TAGS.has(name)) { i = gt + 1; continue; }
      if (node === root) {
        errors.push({ at: pos(lt), message: `stray closing </${name}>` });
      } else if (node.tag !== name) {
        errors.push({ at: pos(lt), message: `</${name}> closes <${node.tag}>` });
        node = node.parent || root;
      } else {
        node = node.parent || root;
      }
      i = gt + 1;
      continue;
    }

    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1).trim() : raw;
    const nameEnd = body.search(/[\s]/);
    const tag = (nameEnd === -1 ? body : body.slice(0, nameEnd)).toLowerCase();
    const attrs = parseAttrs(nameEnd === -1 ? "" : body.slice(nameEnd));

    const el = { tag, attrs, children: [], parent: node, at: pos(lt) };
    node.children.push(el);

    // An <svg> is one opaque graphic: take it whole and do not walk inside.
    if (tag === "svg" && SVG_OPAQUE && !selfClosing) {
      const close = html.toLowerCase().indexOf("</svg>", gt);
      el.raw = close === -1 ? html.slice(gt + 1) : html.slice(gt + 1, close);
      i = close === -1 ? html.length : close + 6;
      continue;
    }
    if (tag === "x-embed" && !selfClosing) {
      const close = html.toLowerCase().indexOf("</x-embed>", gt);
      el.raw = close === -1 ? html.slice(gt + 1) : html.slice(gt + 1, close);
      i = close === -1 ? html.length : close + 10;
      continue;
    }

    if (!selfClosing && !VOID_TAGS.has(tag)) node = el;
    i = gt + 1;
  }

  if (node !== root) errors.push({ at: node.at, message: `<${node.tag}> is never closed` });
  return { root, errors };
}

function parseAttrs(text) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(text))) {
    attrs[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "";
  }
  return attrs;
}

function parseStyle(style) {
  const out = [];
  for (const part of String(style || "").split(";")) {
    const t = part.trim();
    if (!t) continue;
    const c = t.indexOf(":");
    if (c === -1) { out.push({ prop: t.toLowerCase(), value: "", malformed: true }); continue; }
    out.push({ prop: t.slice(0, c).trim().toLowerCase(), value: t.slice(c + 1).trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

// `declaredFaces` is the set of family names deck.json declares, so a
// font-family naming something the deck never loads is caught here rather than
// healing to a generic on the page.
function validateSlideHtml(html, options = {}) {
  const slide = options.slide || "(slide)";
  const declaredFaces = options.declaredFaces || new Set();
  // Set by the exporter, which has not uploaded its assets yet. Never set by
  // anything checking a file that is about to be published.
  const assetPlaceholders = options.assetPlaceholders === true;
  const errors = [];
  const warnings = [];

  const err = (message, el) => errors.push({ slide, at: el && el.at, element: el && el.tag, message });
  const warn = (message, el) => warnings.push({ slide, at: el && el.at, element: el && el.tag, message });

  const { root, errors: parseErrors } = parseSubsetHtml(html);
  for (const e of parseErrors) errors.push({ slide, at: e.at, message: e.message });

  const tops = root.children.filter((c) => c.tag !== "#text");
  const stray = root.children.filter((c) => c.tag === "#text" && c.value.trim());
  if (stray.length) err("text outside the <section>; the file holds exactly one <section> and nothing else");
  if (tops.length !== 1 || tops[0].tag !== "section") {
    err(`the file must hold exactly one <section>, found ${tops.length ? tops.map((t) => "<" + t.tag + ">").join(", ") : "nothing"}`);
    return { errors, warnings, release: SUBSET_RELEASE };
  }

  const section = tops[0];
  const id = section.attrs.id || "";
  if (!RE_ID.test(id)) err(`section id "${id}" must match [A-Za-z0-9_-]{1,64}`, section);

  const sectionStyle = parseStyle(section.attrs.style);
  if (!sectionStyle.some((d) => d.prop === "background" || d.prop === "background-color")) {
    warn("the section sets no background; the type asks for one on every slide", section);
  }

  let elementCount = 0;
  let embedCount = 0;
  const counters = { text: 0, marks: 0 };

  const walk = (el, depth, divDepth, pinnedHost) => {
    if (el.tag === "#text") {
      counters.text += el.value.length;
      return;
    }
    elementCount++;

    if (!ALLOWED_TAGS.has(el.tag)) {
      err(`<${el.tag}> is not in the subset and is dropped on read`, el);
      return;
    }
    if (el.attrs.class !== undefined) {
      warn("class is stripped on save; it cannot carry meaning", el);
    }
    for (const a of Object.keys(el.attrs)) {
      if (a.startsWith("data-") && !/^data-(transition|build-in|build-out|section|crop|fit|video|video-start|video-delay)$/.test(a)) {
        warn(`${a} is stripped on save; it cannot carry meaning`, el);
      }
      if (a.startsWith("on")) err(`${a} is a script attribute and is not allowed`, el);
    }
    if (el.tag === "script" || el.tag === "style" || el.tag === "link") {
      err(`<${el.tag}> is not allowed in a slide file`, el);
    }

    if (INLINE_TAGS.has(el.tag) && el.tag !== "br") counters.marks++;

    const styles = parseStyle(el.attrs.style);
    const allowed = PROPS_FOR_TAG[el.tag];
    let positioned = false;

    for (const d of styles) {
      if (d.malformed) { err(`malformed style declaration "${d.prop}"`, el); continue; }
      if (allowed && !allowed.has(d.prop)) {
        err(`${d.prop} is not allowed on <${el.tag}>`, el);
        continue;
      }
      if (RE_BAD_UNIT.test(d.value) && d.prop !== "letter-spacing") {
        const unit = d.value.match(RE_BAD_UNIT)[1];
        err(`${d.prop}: "${d.value}" uses ${unit}; lengths are px only`, el);
        continue;
      }
      // The page swallows these rather than refusing them, which is worse than
      // an error: the spacing an author wrote simply does not happen, and
      // nothing says so.
      if (d.prop === "margin" && !/^0(px)?$/.test(d.value.trim())) {
        warn(`margin is accepted but does nothing on a slide; use gap or padding`, el);
      }
      const reason = checkValue(d.prop, d.value);
      if (reason) err(`${d.prop}: "${d.value}" — ${reason}`, el);
      if (d.prop === "position" && d.value.trim().toLowerCase() === "absolute") positioned = true;
      if (d.prop === "font-size") {
        const n = lenValue(d.value);
        if (n !== null && n < MIN_FONT_SIZE) {
          warn(`font-size ${n}px is under the ${MIN_FONT_SIZE}px the type asks for`, el);
        }
      }
      if (d.prop === "font-family") {
        const first = d.value.split(",")[0].trim().replace(/^['"]|['"]$/g, "");
        if (first && !declaredFaces.has(first) && !BASIC_FACES.has(first) && !GENERIC_FACES.has(first)) {
          warn(`font-family "${first}" is not a declared face, a basic face or a generic; it heals to the generic`, el);
        }
      }
    }

    if (positioned) {
      pinnedHost.count++;
      if (pinnedHost.count > MAX_PINNED_PER_HOST) {
        err(`more than ${MAX_PINNED_PER_HOST} positioned children in one host; split across sibling hosts`, el);
      }
      const box = pinnedBox(styles);
      if (box) {
        if (box.left !== null && box.width !== null && box.left + box.width > CANVAS.w - MARGIN) {
          warn(`pinned box runs past the ${MARGIN}px right margin`, el);
        }
        if (box.top !== null && box.height !== null && box.top + box.height > CANVAS.h - MARGIN) {
          warn(`pinned box runs past the ${MARGIN}px bottom margin`, el);
        }
        if ((box.left !== null && box.left < 0) || (box.top !== null && box.top < 0)) {
          warn("a negative offset is clamped to 0 on read", el);
        }
      }
    }

    // Per-tag rules
    if (el.tag === "img") {
      const src = el.attrs.src || "";
      if (!src) warn("<img> has no src: the type reads that as a deliberately empty frame", el);
      else if (/^data:/i.test(src)) err("an <img> src may not be a data: URI; upload the file and use its /_blob/<id>", el);
      else if (/^https?:/i.test(src)) err("an <img> src may not be an http URL; upload the file and use its /_blob/<id>", el);
      else if (assetPlaceholders && RE_ASSET_PLACEHOLDER.test(src)) {
        // An unresolved export. The resolve step turns it into a blob id.
      }
      else if (!RE_BLOB.test(src) && !RE_DS_PATH.test(src)) {
        err(`an <img> src must be /_blob/<id> or project/ds/<folder>/…, found "${src}"`, el);
      }
      if (el.attrs.alt === undefined) warn("<img> has no alt", el);
    }
    if (el.tag === "x-shape" && !X_SHAPE_KINDS.has(el.attrs.kind || "")) {
      err(`x-shape kind "${el.attrs.kind || ""}" is not one of ${[...X_SHAPE_KINDS].join(", ")}`, el);
    }
    if (el.tag === "x-icon" && !X_ICON_NAMES.has(el.attrs.name || "")) {
      err(`x-icon name "${el.attrs.name || ""}" is not a name the type knows`, el);
    }
    if (el.tag === "x-connector") {
      const coords = ["x1", "y1", "x2", "y2"].filter((k) => el.attrs[k] !== undefined);
      if (coords.length && coords.length < 4) err("x-connector needs all four of x1, y1, x2, y2 or none", el);
      if (el.attrs.route && !X_CONNECTOR_ROUTES.has(el.attrs.route)) err(`x-connector route "${el.attrs.route}" is unknown`, el);
      if (el.attrs.head && !X_CONNECTOR_HEADS.has(el.attrs.head)) err(`x-connector head "${el.attrs.head}" is unknown`, el);
      if (coords.length === 4) pinnedHost.count++;
    }
    if (el.tag === "x-embed") {
      embedCount++;
      if (el.parent && el.parent.tag !== "section") err("<x-embed> must be a direct child of the section", el);
      if (!positioned) err("<x-embed> must be pinned", el);
      if (Buffer.byteLength(el.raw || "", "utf8") > MAX_EMBED_BYTES) err("<x-embed> is over 16 KB", el);
    }
    if (el.tag === "svg") {
      const raw = el.raw || "";
      if (Buffer.byteLength(raw, "utf8") > MAX_SVG_BYTES) err("<svg> is over 52 KB", el);
      if (/<script|on[a-z]+\s*=/i.test(raw)) err("<svg> may not hold a script", el);
      if (/<foreignObject/i.test(raw)) err("<svg> may not hold a foreignObject; it is stripped and the PPTX export skips the drawing", el);
      if (/<(animate|animateTransform|animateMotion|set)[\s>]/i.test(raw)) {
        warn("SMIL animation in an svg never plays; the viewer treats a drawing as a static image", el);
      }
      // Only numeric references and the XML five survive. Anything else
      // breaks the whole drawing rather than one glyph.
      const badEntity = raw.match(/&(?!#\d+;|#x[0-9a-fA-F]+;|amp;|lt;|gt;|quot;|apos;)([a-zA-Z]+;|\s)/);
      if (badEntity) {
        err(`<svg> uses the entity "&${badEntity[1].trim()}"; only &#NNNN; and the XML five are read, and anything else breaks the drawing`, el);
      }
      if (/\b(?:href|xlink:href|src)\s*=\s*["']?(?:https?:|\/\/)/i.test(raw)) err("<svg> may not reference a URL", el);
      if (/<text[\s>]/i.test(raw)) {
        warn("<text> in an svg: fonts never load inside a drawing, so lift labels out as pinned <p>s", el);
      }
      if (el.attrs["aria-label"] === undefined) warn("<svg> has no aria-label", el);
    }
    if (el.tag === "ul" || el.tag === "ol") {
      for (const c of el.children) {
        if (c.tag === "#text") continue;
        if (c.tag !== "li") err(`<${el.tag}> may hold only <li>`, el);
        else if (c.children.some((g) => g.tag === "ul" || g.tag === "ol")) {
          err("nested lists are not in the subset; flatten to one level", c);
        }
      }
    }
    if (el.tag === "table") {
      const rows = el.children.filter((c) => c.tag === "tr");
      if (rows.length > MAX_TABLE_ROWS) err(`a table may hold at most ${MAX_TABLE_ROWS} rows`, el);
      let cells = 0;
      for (const r of rows) {
        const cs = r.children.filter((c) => c.tag === "th" || c.tag === "td");
        if (cs.length > MAX_TABLE_COLS) err(`a table row may hold at most ${MAX_TABLE_COLS} cells`, r);
        cells += cs.length;
        for (const c of cs) {
          if (c.attrs.colspan !== undefined || c.attrs.rowspan !== undefined) {
            err("colspan and rowspan are not in the subset", c);
          }
        }
      }
      if (cells > MAX_TABLE_CELLS) err(`a table may hold at most ${MAX_TABLE_CELLS} cells`, el);
    }
    if (el.tag === "div") {
      if (divDepth + 1 > MAX_DIV_DEPTH) err(`<div> nesting is deeper than ${MAX_DIV_DEPTH}`, el);
    }
    if (el.tag === "aside") {
      const text = textOf(el);
      if (text.length > MAX_NOTES) err(`speaker notes are ${text.length} characters; the limit is ${MAX_NOTES}`, el);
      for (const c of el.children) {
        if (c.tag !== "#text") warn("speaker notes should be plain text", el);
      }
    }

    const isRelativeHost = styles.some((d) => d.prop === "position" && d.value.trim() === "relative");
    const childHost = isRelativeHost ? { count: 0 } : pinnedHost;
    const nextDivDepth = el.tag === "div" ? divDepth + 1 : divDepth;
    for (const c of el.children) walk(c, depth + 1, nextDivDepth, childHost);
  };

  const sectionHost = { count: 0 };
  for (const c of section.children) walk(c, 1, 0, sectionHost);

  // <aside> is the section's last child, or the page does not read it as notes.
  const kids = section.children.filter((c) => c.tag !== "#text" || c.value.trim());
  const asides = kids.filter((c) => c.tag === "aside");
  if (asides.length > 1) err("a slide may hold only one <aside>", section);
  if (asides.length === 1 && kids[kids.length - 1] !== asides[0]) {
    err("<aside> must be the section's last child or it is not read as speaker notes", asides[0]);
  }

  if (elementCount > MAX_ELEMENTS) err(`${elementCount} elements; the limit is ${MAX_ELEMENTS}`, section);
  if (embedCount > MAX_EMBEDS) err(`${embedCount} <x-embed>s; the limit is ${MAX_EMBEDS}`, section);
  if (counters.text > MAX_TEXT_CHARS) err(`${counters.text} characters of text; the limit is ${MAX_TEXT_CHARS}`, section);
  if (counters.marks > MAX_INLINE_MARKS) err(`${counters.marks} inline marks; the limit is ${MAX_INLINE_MARKS}`, section);

  return { errors, warnings, release: SUBSET_RELEASE, elementCount };
}

function pinnedBox(styles) {
  const get = (p) => {
    const d = styles.find((s) => s.prop === p);
    return d ? lenValue(d.value) : null;
  };
  return { left: get("left"), top: get("top"), width: get("width"), height: get("height") };
}

// The characters a reader sees, not the characters in the file. The parser
// keeps text as written, so `&` arrives as `&amp;` — and counting that form
// against a limit measures the escaping rather than the content. Speaker notes
// truncated to exactly 4,000 characters were then reported as 4,140 and the
// export refused, which is how this was found.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" };
function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code) : whole;
    }
    const named = ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

function textOf(el) {
  if (el.tag === "#text") return decodeEntities(el.value);
  return (el.children || []).map(textOf).join("");
}

// deck.json, checked against the same reference.
function validateDeckJson(deck, options = {}) {
  const assetPlaceholders = options.assetPlaceholders === true;
  const errors = [];
  const warnings = [];
  const err = (m) => errors.push({ slide: "deck.json", message: m });
  const warn = (m) => warnings.push({ slide: "deck.json", message: m });

  if (!deck || typeof deck !== "object") { err("deck.json is not an object"); return { errors, warnings }; }
  if (deck.v !== 4) err(`deck.json "v" must be 4, found ${JSON.stringify(deck.v)}`);
  if (typeof deck.title !== "string" || !deck.title) err('deck.json needs a "title"');
  if (!Array.isArray(deck.order) || !deck.order.length) err('deck.json needs a non-empty "order"');
  else {
    for (const id of deck.order) if (!RE_ID.test(id)) err(`order id "${id}" must match [A-Za-z0-9_-]{1,64}`);
    if (new Set(deck.order).size !== deck.order.length) err("order holds a duplicate id");
  }
  if (deck.cover && !((deck.order || []).includes(deck.cover))) err(`"cover" names "${deck.cover}", which is not in order`);

  const faces = deck.faces || {};
  const names = Object.keys(faces);
  if (names.length > 4) err(`${names.length} faces; the limit is 4`);
  for (const key of names) {
    const face = faces[key] || {};
    const expected = String(face.family || "").toLowerCase().replace(/\s+/g, "-");
    if (key !== expected) warn(`face key "${key}" should be "${expected}" (the family lowercased, spaces as -) or the entry is ignored`);
    if (!/^[A-Za-z][A-Za-z0-9 _-]{0,39}$/.test(face.family || "")) {
      err(`face "${key}" family "${face.family}" must start with a letter and be at most 40 characters`);
    }
    if (face.href && face.src) err(`face "${key}" has both href and src; it takes one`);
    if (!face.href && !face.src) err(`face "${key}" has neither href nor src`);
    if (face.href && !/^https:\/\/fonts\.googleapis\.com\/css2\?/.test(face.href)) {
      err(`face "${key}" href must be a https://fonts.googleapis.com/css2? link`);
    }
    if (face.href && face.href.length > 1024) err(`face "${key}" href is over 1024 characters`);
    if (face.src && !RE_BLOB.test(face.src) && !RE_DS_PATH.test(face.src) &&
        !(assetPlaceholders && RE_ASSET_PLACEHOLDER.test(face.src))) {
      err(`face "${key}" src must be /_blob/<id> or project/ds/<folder>/…`);
    }
  }

  for (const [key, s] of Object.entries(deck.sections || {})) {
    if (!s || !s.start) err(`section "${key}" has no start`);
    else if (!(deck.order || []).includes(s.start)) err(`section "${key}" starts at "${s.start}", which is not in order`);
  }
  return { errors, warnings };
}

module.exports = {
  // The exporter filters its own declarations through this, so it cannot emit a
  // property this file would then reject. One table, one source of truth.
  PROPS_FOR_TAG,
  decodeEntities,
  srgbToRgba,
  RE_ASSET_PLACEHOLDER,
  SUBSET_RELEASE,
  SUBSET_CONTRACT,
  CANVAS,
  MARGIN,
  MIN_FONT_SIZE,
  MAX_NOTES,
  MAX_ELEMENTS,
  MAX_PINNED_PER_HOST,
  BASIC_FACES,
  GENERIC_FACES,
  X_ICON_NAMES,
  X_SHAPE_KINDS,
  RE_ID,
  parseSubsetHtml,
  parseStyle,
  textOf,
  validateSlideHtml,
  validateDeckJson,
};
