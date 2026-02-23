#!/usr/bin/env node
/**
 * Generate INDEX.sdoc for a lexica/ directory.
 *
 * Usage:
 *   node tools/generate_index.js [lexica-dir]
 *
 * Defaults to ./lexica/ if no argument given. Scans all .sdoc files in the
 * directory, extracts title, type, and @about, and writes INDEX.sdoc.
 */

const fs = require("fs");
const path = require("path");
const { parseSdoc, extractMeta, extractAbout, inferType } = require("../src/sdoc");

const lexicaDir = process.argv[2] || path.join(process.cwd(), "lexica");

if (!fs.existsSync(lexicaDir)) {
  console.error("Directory not found: " + lexicaDir);
  process.exit(1);
}

const files = fs.readdirSync(lexicaDir)
  .filter((f) => f.endsWith(".sdoc") && f !== "INDEX.sdoc")
  .sort();

if (!files.length) {
  console.error("No .sdoc files found in " + lexicaDir);
  process.exit(1);
}

const entries = [];
for (const file of files) {
  const content = fs.readFileSync(path.join(lexicaDir, file), "utf8");
  const parsed = parseSdoc(content);

  // Extract title from first scope
  let title = file;
  for (const node of parsed.nodes) {
    if (node.type === "scope" && node.title) {
      title = node.title;
      break;
    }
  }

  const meta = extractMeta(parsed.nodes);
  const type = inferType(file, meta.meta) || "unknown";
  const about = extractAbout(parsed.nodes);

  entries.push({ file, title, type, about });
}

// Build INDEX.sdoc
const date = new Date().toISOString().split("T")[0];
const lines = [
  "# Knowledge Index @index",
  "{",
  "    # Meta @meta",
  "    {",
  `        generated: ${date}`,
  "    }",
  "",
];

for (const entry of entries) {
  const aboutText = entry.about
    ? entry.about.replace(/\s+/g, " ").trim()
    : "(No @about section.)";

  // Wrap about text at ~72 chars with 8-space indent
  const prefix = `    - **${entry.file}** (${entry.type}) — `;
  const maxLen = 76;
  const indent = "      ";
  const words = (prefix + aboutText).split(/\s+/);
  const wrapped = [];
  let current = "";
  for (const word of words) {
    const lineIndent = wrapped.length === 0 ? "" : indent;
    if (current && (lineIndent + current + " " + word).length > maxLen) {
      wrapped.push(current);
      current = word;
    } else {
      current = current ? current + " " + word : word;
    }
  }
  if (current) wrapped.push(current);

  lines.push("    " + wrapped[0]);
  for (let i = 1; i < wrapped.length; i++) {
    lines.push(indent + wrapped[i]);
  }
}

lines.push("}");
lines.push("");

const output = lines.join("\n");
const outputPath = path.join(lexicaDir, "INDEX.sdoc");
fs.writeFileSync(outputPath, output, "utf8");
console.log("Generated " + outputPath + " (" + entries.length + " entries)");
