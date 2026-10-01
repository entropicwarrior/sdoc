#!/usr/bin/env node
// Rewrites `sdoc-asset:<file>` placeholders in an export folder to the
// `/_blob/<id>` urls an upload returned.
//
// The exporter cannot know these ids: an asset gets one only when it is
// uploaded, which happens through Claude's Artifact tool rather than from a
// script. So the export writes a placeholder and this closes the loop, driven
// by the manifest — where the publish step records each upload.
//
// Doing it here rather than by hand-editing slide files is the point: a blob
// id is a long opaque string, there is one per image, and a single wrong
// character is an image that silently does not load.
//
//   node tools/artifact-resolve-assets.js <export-dir> [--set name=/_blob/id ...]
//
// --set records an upload in the manifest first, so the usual flow is one call
// carrying every id the publish step just collected.

const fs = require("fs");
const path = require("path");

function usage(code) {
  console.log(
    "Usage: artifact-resolve-assets <export-dir> [--set <file>=/_blob/<id>]...\n\n" +
      "  Rewrites sdoc-asset: placeholders using the blob ids in sdoc-artifact.json.\n" +
      "  --set records an id in the manifest before rewriting."
  );
  process.exit(code);
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) usage(args.length ? 0 : 1);

  const dir = path.resolve(args[0]);
  const sets = [];
  for (let i = 1; i < args.length; i++) {
    if (args[i] === "--set" && i + 1 < args.length) {
      const pair = args[++i];
      const eq = pair.indexOf("=");
      if (eq === -1) { console.error(`--set needs <file>=/_blob/<id>, got "${pair}"`); process.exit(1); }
      sets.push({ name: pair.slice(0, eq), blob: pair.slice(eq + 1) });
    } else {
      console.error(`unknown argument "${args[i]}"`);
      process.exit(1);
    }
  }

  const manifestPath = path.join(dir, "sdoc-artifact.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
  } catch {
    console.error(`No sdoc-artifact.json in ${dir}. Run build-slides.js --artifact first.`);
    process.exit(1);
  }
  manifest.assets = manifest.assets || {};

  for (const { name, blob } of sets) {
    if (!manifest.assets[name]) {
      console.error(`"${name}" is not an asset of this export; the slides never reference it.`);
      process.exit(1);
    }
    if (!/^\/?_blob\/[A-Za-z0-9_-]+$/.test(blob)) {
      console.error(`"${blob}" is not a /_blob/<id> url. Use the url the upload returned, verbatim.`);
      process.exit(1);
    }
    manifest.assets[name].blob = blob.startsWith("/") ? blob : "/" + blob;
  }

  const unresolved = Object.entries(manifest.assets).filter(([, a]) => !a.blob).map(([n]) => n);

  // Every file in the project folder, since a placeholder can sit in deck.json
  // (a font face) as well as in a slide.
  const projectDir = path.join(dir, "project");
  const files = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  if (fs.existsSync(projectDir)) walk(projectDir);

  let rewritten = 0;
  const stillMissing = new Set();
  for (const file of files) {
    const before = fs.readFileSync(file, "utf-8");
    const after = before.replace(/sdoc-asset:([^"'\s>]+)/g, (match, name) => {
      const asset = manifest.assets[name];
      if (asset && asset.blob) { rewritten++; return asset.blob; }
      stillMissing.add(name);
      return match;
    });
    if (after !== before) fs.writeFileSync(file, after, "utf-8");
  }

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");

  console.log(`Resolved ${rewritten} reference(s) in ${files.length} file(s).`);
  if (stillMissing.size) {
    console.error(
      `\n${stillMissing.size} asset(s) have no blob id yet, so their placeholders are unchanged:\n` +
        [...stillMissing].map((n) => `  ${n}`).join("\n") +
        "\n\nUpload each one, then pass its url back with --set <file>=/_blob/<id>."
    );
    process.exit(1);
  }
  if (unresolved.length === 0 && rewritten === 0) console.log("Nothing to resolve: this deck references no assets.");
}

main();
