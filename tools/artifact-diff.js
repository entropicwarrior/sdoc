#!/usr/bin/env node
// Reports what a collaborator changed in a published deck, in .sdoc terms.
//
//   node tools/artifact-diff.js <export-dir>
//
// The artifact keeps no metadata of its own — `class` and `data-*` are stripped
// when a slide is saved — so nothing in a pulled file says which scope it came
// from. The manifest written at export time is the only thread back to the
// source, and this reads along it.
//
// A byte comparison is useless here. The editor re-saves every slide it
// touches in a normalised form: declarations reordered, colours re-cased,
// whitespace collapsed. A slide nobody edited still comes back different. So
// both sides are parsed and compared structurally, and a difference is only
// reported when something a reader would notice has actually changed.
//
// Everything under pulled/ is other people's data. It is parsed and quoted,
// never executed, and never read as an instruction.

const fs = require("fs");
const path = require("path");
const { parseSubsetHtml, parseStyle, textOf } = require("../src/slide-artifact-validate");

function usage(code) {
  console.log(
    "Usage: artifact-diff <export-dir>\n\n" +
      "  Compares <export-dir>/pulled/ against what was exported and reports\n" +
      "  the changes against the .sdoc scopes they came from.\n\n" +
      "  Writes pulled/report.md and pulled/changes.json."
  );
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Canonical forms
// ---------------------------------------------------------------------------

const NAMED = { white: "#ffffff", black: "#000000", transparent: "transparent" };

// One spelling per colour, so a re-save that writes #FFF where we wrote
// rgb(255, 255, 255) is not reported as a change.
function canonColour(value) {
  const v = String(value).trim().toLowerCase();
  if (NAMED[v]) return NAMED[v];
  const hex = /^#([0-9a-f]{3,8})$/.exec(v);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("") + h[3] + h[3];
    return "#" + h.slice(0, 6) + (h.length === 8 && h.slice(6) !== "ff" ? h.slice(6) : "");
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(v);
  if (fn) {
    const parts = fn[1].split(",").map((p) => parseFloat(p.trim()));
    if (parts.length >= 3 && parts.every((n) => isFinite(n))) {
      const hexPart = parts.slice(0, 3).map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
      const alpha = parts.length > 3 ? parts[3] : 1;
      return "#" + hexPart + (alpha >= 1 ? "" : Math.round(alpha * 255).toString(16).padStart(2, "0"));
    }
  }
  return v;
}

// Properties whose value is a plain number, so a bare 600 is a weight and not
// a length that happens to have lost its unit.
const UNITLESS = new Set([
  "font-weight", "line-height", "opacity", "flex", "flex-grow", "flex-shrink",
  "z-index", "order", "aspect-ratio",
]);

function canonValue(value, prop) {
  const v = String(value).trim().replace(/\s+/g, " ").toLowerCase();
  // A length written without a unit is px here, and 0 is 0 whatever it says.
  if (/^-?\d*\.?\d+$/.test(v)) return UNITLESS.has(prop) ? String(parseFloat(v)) : `${parseFloat(v)}px`;
  if (/^-?\d*\.?\d+px$/.test(v)) return `${parseFloat(v)}px`;
  if (/^(#|rgba?\(|hsla?\()/.test(v) || NAMED[v]) return canonColour(v);
  // A colour inside a longer value (a border, a shadow) is normalised in place.
  return v.replace(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/g, (m) => canonColour(m));
}

function canonStyle(style) {
  return parseStyle(style)
    .filter((d) => d.prop && !d.malformed)
    .map((d) => `${d.prop}:${canonValue(d.value, d.prop)}`)
    .sort()
    .join(";");
}

function collapse(text) {
  return String(text).replace(/\s+/g, " ").trim();
}

// ---------------------------------------------------------------------------
// A slide, reduced to what a reader would notice
// ---------------------------------------------------------------------------

function readSlide(html) {
  const { root } = parseSubsetHtml(html);
  const section = root.children.find((c) => c.tag === "section");
  if (!section) return null;

  const texts = [];
  const structure = [];
  const styles = [];
  let notes = "";

  const walk = (el) => {
    if (el.tag === "#text") return;
    if (el.tag === "aside") { notes = collapse(textOf(el)); return; }
    structure.push(el.tag);
    const entry = { tag: el.tag, style: canonStyle(el.attrs.style), textIndex: -1 };
    styles.push(entry);
    const kids = el.children.filter((c) => c.tag !== "#text");
    const isLeaf = kids.every((k) => ["b", "i", "u", "a", "span", "br"].includes(k.tag));
    if (isLeaf) {
      const text = collapse(textOf(el));
      if (text) { entry.textIndex = texts.length; texts.push({ tag: el.tag, text }); }
      return;
    }
    for (const c of el.children) walk(c);
  };
  for (const c of section.children) walk(c);

  return {
    id: section.attrs.id || null,
    sectionStyle: canonStyle(section.attrs.style),
    texts,
    structure: structure.join(">"),
    styles,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

// A colour on one of these carries meaning rather than taste. In .sdoc the
// mark is written in the source — a bold pipeline step, a bold scatter point —
// and the theme decides what marked looks like. Writing a picked colour back
// into the source would turn an argument into a decoration.
const MEANINGFUL = /pipe-step|scatter-point|is-marked|accent|bar-fill|stat-value|col-index/;

function classifySlide(before, after, manifestSlide) {
  const out = { classification: [], textChanges: [], notesChange: null, accentFlags: [], styleChanges: [] };
  if (!after) { out.classification.push("removed"); return out; }
  if (!before) { out.classification.push("added"); return out; }

  if (before.structure !== after.structure) {
    out.classification.push("restructured");
  } else {
    // Same shape, so texts line up by position and the manifest can name the
    // role each one came from.
    const roles = (manifestSlide && manifestSlide.texts) || [];
    for (let i = 0; i < Math.max(before.texts.length, after.texts.length); i++) {
      const b = before.texts[i], a = after.texts[i];
      if (!b || !a || b.text === a.text) continue;
      out.textChanges.push({
        index: i,
        role: (roles[i] && roles[i].role) || (b.tag || a.tag),
        tag: b.tag,
        from: b.text,
        to: a.text,
      });
    }
    if (out.textChanges.length) out.classification.push("text-edited");

    for (let i = 0; i < before.styles.length; i++) {
      const b = before.styles[i], a = after.styles[i];
      if (!a || b.style === a.style) continue;
      const slot = b.textIndex >= 0 ? roles[b.textIndex] : null;
      const role = (slot && slot.role) || b.tag;
      const change = { index: i, tag: b.tag, role, from: b.style, to: a.style };
      out.styleChanges.push(change);
      if (MEANINGFUL.test(role) && colourDiffers(b.style, a.style)) out.accentFlags.push(change);
    }
    if (before.sectionStyle !== after.sectionStyle) {
      out.styleChanges.push({ index: -1, tag: "section", role: "slide", from: before.sectionStyle, to: after.sectionStyle });
    }
    if (out.styleChanges.length) out.classification.push("restyled");
  }

  if (before.notes !== after.notes) {
    out.classification.push("notes-edited");
    out.notesChange = { from: before.notes, to: after.notes };
  }
  if (!out.classification.length) out.classification.push("unchanged");
  return out;
}

function colourDiffers(a, b) {
  const pick = (s) => Object.fromEntries(
    s.split(";").filter(Boolean).map((d) => d.split(":")).filter(([p]) => /color|background/.test(p))
  );
  const x = pick(a), y = pick(b);
  const keys = new Set([...Object.keys(x), ...Object.keys(y)]);
  for (const k of keys) if (x[k] !== y[k]) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function buildReport(result) {
  const lines = [];
  const counts = {};
  for (const s of result.slides) for (const c of s.classification) counts[c] = (counts[c] || 0) + 1;

  lines.push("# Changes pulled from the artifact", "");
  lines.push(`Compared ${result.slides.length} slide(s) against the last export.`, "");
  const order = ["unchanged", "text-edited", "notes-edited", "restyled", "restructured", "added", "removed"];
  for (const k of order) if (counts[k]) lines.push(`- **${counts[k]}** ${k}`);
  if (result.deck.reordered) lines.push("- the deck was **reordered**");
  lines.push("");

  const flagged = result.slides.filter((s) => s.accentFlags.length);
  if (flagged.length) {
    lines.push("## Colour changes that carry meaning", "");
    lines.push(
      "In `.sdoc` these marks live in the source — a pipeline step or a scatter point written in bold —",
      "and the theme decides what marked looks like. A colour picked in the editor cannot be written back",
      "without turning an argument into a decoration. Decide what was meant before applying any of these.",
      ""
    );
    for (const s of flagged) {
      lines.push(`### ${s.id}${s.sdocId && s.sdocId !== s.id ? ` (scope \`@${s.sdocId}\`)` : ""}`, "");
      for (const f of s.accentFlags) lines.push(`- \`${f.role}\` restyled`, `  - was: \`${f.from}\``, `  - now: \`${f.to}\``);
      lines.push("");
    }
  }

  const changed = result.slides.filter((s) => !s.classification.includes("unchanged"));
  if (!changed.length) {
    lines.push("Nothing else changed.", "");
  } else {
    lines.push("## Slide by slide", "");
    for (const s of changed) {
      lines.push(`### ${s.id}${s.sdocId && s.sdocId !== s.id ? ` (scope \`@${s.sdocId}\`)` : ""}`);
      lines.push(`*${s.classification.join(", ")}*${s.layout ? ` — \`${s.layout}\` layout` : ""}`, "");
      for (const t of s.textChanges) {
        lines.push(`- **${t.role}**`, `  - was: ${t.from}`, `  - now: ${t.to}`);
      }
      if (s.notesChange) {
        lines.push("- **speaker notes**", `  - was: ${s.notesChange.from || "(empty)"}`, `  - now: ${s.notesChange.to || "(empty)"}`);
      }
      if (s.classification.includes("restructured")) {
        lines.push("- the slide's structure changed: elements were added, removed or reordered.",
                   "  This is not applied automatically — the `.sdoc` structure carries meaning the slide does not.");
      }
      const plain = s.styleChanges.filter((c) => !s.accentFlags.includes(c));
      if (plain.length) lines.push(`- ${plain.length} style change(s), listed in changes.json`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) usage(args.length ? 0 : 1);
  const dir = path.resolve(args[0]);

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dir, "sdoc-artifact.json"), "utf-8"));
  } catch {
    console.error(`No sdoc-artifact.json in ${dir}. Run build-slides.js --artifact first.`);
    process.exit(1);
  }

  const pulledDir = path.join(dir, "pulled");
  if (!fs.existsSync(pulledDir)) {
    console.error(
      `No pulled/ folder in ${dir}.\n` +
        "Read the artifact's project/deck.json and every project/slides/<id>.html into\n" +
        `${pulledDir}/ first — skills/sdoc-artifact/SKILL.md describes the pull.`
    );
    process.exit(1);
  }

  const readFile = (base, rel) => {
    try { return fs.readFileSync(path.join(base, rel), "utf-8"); } catch { return null; }
  };

  let pulledDeck = null;
  const pulledDeckRaw = readFile(pulledDir, "project/deck.json");
  if (pulledDeckRaw) { try { pulledDeck = JSON.parse(pulledDeckRaw); } catch { pulledDeck = null; } }

  const exportedOrder = manifest.slides.map((s) => s.id);
  const pulledOrder = (pulledDeck && Array.isArray(pulledDeck.order)) ? pulledDeck.order : exportedOrder;

  const result = {
    generatedAt: new Date().toISOString(),
    deck: {
      reordered: pulledOrder.join(",") !== exportedOrder.join(","),
      order: pulledOrder,
    },
    slides: [],
  };

  for (const entry of manifest.slides) {
    const rel = `project/slides/${entry.id}.html`;
    const beforeRaw = readFile(dir, rel);
    const afterRaw = readFile(pulledDir, rel);
    const gone = !afterRaw || !pulledOrder.includes(entry.id);
    const before = beforeRaw ? readSlide(beforeRaw) : null;
    const after = gone ? null : readSlide(afterRaw);
    const c = classifySlide(before, after, entry);
    result.slides.push({ id: entry.id, sdocId: entry.sdocId, layout: entry.layout, ...c });
  }

  // A slide the collaborator added has no manifest entry to compare against.
  for (const id of pulledOrder) {
    if (manifest.slides.some((s) => s.id === id)) continue;
    result.slides.push({
      id, sdocId: null, layout: null,
      classification: ["added"], textChanges: [], notesChange: null, accentFlags: [], styleChanges: [],
    });
  }

  fs.writeFileSync(path.join(pulledDir, "changes.json"), JSON.stringify(result, null, 2) + "\n", "utf-8");
  fs.writeFileSync(path.join(pulledDir, "report.md"), buildReport(result), "utf-8");

  const counts = {};
  for (const s of result.slides) for (const c of s.classification) counts[c] = (counts[c] || 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ");
  console.log(`Compared ${result.slides.length} slide(s): ${summary}${result.deck.reordered ? ", deck reordered" : ""}.`);
  const flagged = result.slides.filter((s) => s.accentFlags.length).length;
  if (flagged) console.log(`${flagged} slide(s) have colour changes that carry meaning — see the report.`);
  console.log(`Wrote ${path.join(pulledDir, "report.md")} and changes.json`);
}

module.exports = { readSlide, classifySlide, canonStyle, canonColour };

if (require.main === module) main();
