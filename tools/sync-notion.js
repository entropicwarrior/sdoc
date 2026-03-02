#!/usr/bin/env node
// SDOC Notion Sync — push SDOC files to Notion pages.
//
// Usage:
//   node tools/sync-notion.js <file.sdoc> [--page-id <id>] [options]
//   node tools/sync-notion.js <directory>  [options]
//
// Options:
//   --page-id <id>   Override Notion page ID (single-file mode only)
//   --token <tok>    Notion integration token (default: $NOTION_TOKEN)
//   --dry-run        Render blocks to stdout, no API calls
//   --verbose        Print progress to stderr
//   --help           Show usage
//
// Files opt in to sync by setting `notion-page: <page-id>` in their @meta scope.
// When given a directory, scans recursively for .sdoc files with this property.

const fs = require("fs");
const path = require("path");
const { parseSdoc, extractMeta, resolveIncludes } = require("../src/sdoc");
const { renderNotionBlocks } = require("../src/notion-renderer");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTION_API_VERSION = "2022-06-28";
const NOTION_BASE_URL = "https://api.notion.com/v1";
const BATCH_SIZE = 100;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(exitCode) {
  console.error("Usage:");
  console.error("  sync-notion <file.sdoc> [--page-id <id>] [--token <tok>] [--dry-run] [--verbose]");
  console.error("  sync-notion <directory>  [--token <tok>] [--dry-run] [--verbose]");
  console.error("");
  console.error("Files opt in via `notion-page: <page-id>` in @meta.");
  console.error("Token defaults to $NOTION_TOKEN env var.");
  process.exit(exitCode === undefined ? 1 : exitCode);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    inputPath: null,
    pageId: null,
    token: process.env.NOTION_TOKEN || null,
    dryRun: false,
    verbose: false
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--page-id" && i + 1 < args.length) {
      opts.pageId = args[++i];
    } else if (args[i] === "--token" && i + 1 < args.length) {
      opts.token = args[++i];
    } else if (args[i] === "--dry-run") {
      opts.dryRun = true;
    } else if (args[i] === "--verbose") {
      opts.verbose = true;
    } else if (args[i] === "--help" || args[i] === "-h") {
      usage(0);
    } else if (!opts.inputPath) {
      opts.inputPath = args[i];
    } else {
      console.error("Unknown argument: " + args[i]);
      usage();
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

function findSdocFiles(dir) {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== "node_modules" && entry.name !== ".git") {
      results.push(...findSdocFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".sdoc")) {
      results.push(fullPath);
    }
  }
  return results;
}

function extractNotionPageId(filePath) {
  const text = fs.readFileSync(filePath, "utf-8");
  const parsed = parseSdoc(text);
  const { meta } = extractMeta(parsed.nodes);
  const props = meta.properties || {};
  const pageId = props["notion-page"] || props["notion_page"] || null;
  return pageId ? pageId.trim() : null;
}

function discoverFiles(inputPath) {
  const resolved = path.resolve(inputPath);
  const allSdoc = findSdocFiles(resolved);
  const withNotion = [];
  for (const f of allSdoc) {
    const pageId = extractNotionPageId(f);
    if (pageId) {
      withNotion.push({ file: f, pageId });
    }
  }
  return withNotion;
}

// ---------------------------------------------------------------------------
// Notion API client
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function notionRequest(method, apiPath, token, body) {
  const url = NOTION_BASE_URL + apiPath;
  const headers = {
    "Authorization": "Bearer " + token,
    "Notion-Version": NOTION_API_VERSION,
    "Content-Type": "application/json"
  };

  const response = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error("Notion API " + response.status + " " + method + " " + apiPath + ": " + text);
  }

  return response.json();
}

async function notionRequestWithRetry(method, apiPath, token, body, maxRetries) {
  maxRetries = maxRetries || 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await notionRequest(method, apiPath, token, body);
    } catch (err) {
      if (attempt < maxRetries && err.message.includes("429")) {
        const delay = Math.pow(2, attempt) * 1000;
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// Page sync operations
// ---------------------------------------------------------------------------

async function clearPage(pageId, token, verbose) {
  let cursor = undefined;
  let deleted = 0;

  do {
    const params = cursor ? "?start_cursor=" + cursor : "";
    const result = await notionRequestWithRetry("GET", "/blocks/" + pageId + "/children" + params, token);

    for (const block of result.results) {
      await notionRequestWithRetry("DELETE", "/blocks/" + block.id, token);
      deleted++;
    }

    cursor = result.has_more ? result.next_cursor : undefined;
  } while (cursor);

  if (verbose) {
    console.error("  Deleted " + deleted + " existing blocks");
  }
}

function extractOverflow(blocks) {
  const overflow = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const key = block.type;
    const children = block[key] && block[key].children;
    if (children && children.length > BATCH_SIZE) {
      overflow.push({ index: i, extra: children.slice(BATCH_SIZE) });
      block[key].children = children.slice(0, BATCH_SIZE);
    }
  }
  return overflow;
}

async function appendBlocks(pageId, blocks, token, verbose) {
  for (let i = 0; i < blocks.length; i += BATCH_SIZE) {
    const batch = blocks.slice(i, i + BATCH_SIZE);
    const overflow = extractOverflow(batch);

    const result = await notionRequestWithRetry("PATCH", "/blocks/" + pageId + "/children", token, {
      children: batch
    });

    if (verbose) {
      console.error("  Appended blocks " + (i + 1) + "–" + Math.min(i + BATCH_SIZE, blocks.length) + " of " + blocks.length);
    }

    // Append overflow children to blocks that exceeded the 100-child limit
    for (const { index, extra } of overflow) {
      const createdId = result.results[index].id;
      if (verbose) {
        console.error("  Appending " + extra.length + " overflow children to block " + createdId);
      }
      await appendBlocks(createdId, extra, token, verbose);
    }
  }
}

function makeBannerBlock(filePath) {
  return {
    type: "callout",
    callout: {
      rich_text: [{
        type: "text",
        text: {
          content: "Auto-synced from " + filePath + " — do not edit in Notion",
          link: null
        },
        annotations: {
          bold: false, italic: true, strikethrough: false,
          underline: false, code: false, color: "default"
        }
      }],
      icon: { type: "emoji", emoji: "🔄" },
      color: "gray_background"
    }
  };
}

// ---------------------------------------------------------------------------
// Sync logic
// ---------------------------------------------------------------------------

async function syncFile(filePath, pageId, opts) {
  const relativePath = path.relative(process.cwd(), filePath);
  const text = fs.readFileSync(filePath, "utf-8");
  const parsed = parseSdoc(text);

  if (parsed.errors.length > 0 && opts.verbose) {
    for (const err of parsed.errors) {
      console.error("  Warning: line " + err.line + ": " + err.message);
    }
  }

  const { nodes, meta } = extractMeta(parsed.nodes);

  // Resolve code includes if any
  const baseDir = path.dirname(filePath);
  await resolveIncludes(nodes, (src) => {
    const resolved = path.resolve(baseDir, src);
    return fs.readFileSync(resolved, "utf-8");
  });

  const blocks = renderNotionBlocks(nodes);
  const allBlocks = [makeBannerBlock(relativePath), ...blocks];

  if (opts.dryRun) {
    console.log(JSON.stringify(allBlocks, null, 2));
    return;
  }

  if (!opts.token) {
    console.error("Error: Notion token required. Set NOTION_TOKEN env var or use --token.");
    process.exit(1);
  }

  if (opts.verbose) {
    console.error("Syncing " + relativePath + " → " + pageId);
  }

  await clearPage(pageId, opts.token, opts.verbose);
  await appendBlocks(pageId, allBlocks, opts.token, opts.verbose);

  console.log("Synced: " + relativePath + " → " + pageId + " (" + allBlocks.length + " blocks)");
}

async function main() {
  const opts = parseArgs();

  if (!opts.inputPath) {
    usage();
  }

  const resolved = path.resolve(opts.inputPath);
  if (!fs.existsSync(resolved)) {
    console.error("Not found: " + resolved);
    process.exit(1);
  }

  const stat = fs.statSync(resolved);

  if (stat.isFile()) {
    // Single file mode
    let pageId = opts.pageId;
    if (!pageId) {
      pageId = extractNotionPageId(resolved);
    }
    if (!pageId) {
      console.error("Error: No notion-page found in @meta and no --page-id provided.");
      process.exit(1);
    }
    await syncFile(resolved, pageId, opts);
  } else if (stat.isDirectory()) {
    // Directory scan mode
    const files = discoverFiles(resolved);
    if (files.length === 0) {
      console.error("No .sdoc files with notion-page in @meta found in " + resolved);
      process.exit(0);
    }
    if (opts.verbose) {
      console.error("Found " + files.length + " file(s) to sync");
    }
    for (const entry of files) {
      await syncFile(entry.file, entry.pageId, opts);
    }
  }
}

main().catch((err) => {
  console.error("Error: " + err.message);
  process.exit(1);
});
