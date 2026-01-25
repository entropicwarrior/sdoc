#!/usr/bin/env python3
import json
import os
from pathlib import Path
from typing import Dict, List, Optional, Tuple


ROOT = Path(__file__).resolve().parent.parent
CONFIG_FILENAME = "sdoc.config.json"
OUTPUT_DIR = ROOT / "web"
SDOC_WEB_JS = OUTPUT_DIR / "sdoc-web.js"
SDOC_DATA_JS = OUTPUT_DIR / "sdoc-data.js"
INDEX_HTML = OUTPUT_DIR / "index.html"

EXCLUDE_DIRS = {".git", "node_modules", ".vscode", "web", "out", "__pycache__"}


def rel_posix(path: Path) -> Optional[str]:
    try:
        return path.relative_to(ROOT).as_posix()
    except ValueError:
        return None


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def write_text(path: Path, content: str) -> None:
    path.write_text(content, encoding="utf-8")


def is_heading_line(line: str) -> bool:
    stripped = line.lstrip()
    if stripped.startswith("\\#"):
        return False
    return stripped.startswith("#")


def parse_heading(line: str) -> Tuple[str, Optional[str]]:
    stripped = line.lstrip()
    i = 0
    while i < len(stripped) and stripped[i] == "#":
        i += 1
    raw = stripped[i:].strip()

    # trailing @id
    title = raw
    ident = None
    parts = raw.split()
    if parts and parts[-1].startswith("@") and len(parts[-1]) > 1:
        if parts[-1][1:].replace("-", "").replace("_", "").isalnum():
            ident = parts[-1][1:]
            title = " ".join(parts[:-1]).strip()
    return title, ident


def extract_title(text: str) -> str:
    for line in text.splitlines():
        if is_heading_line(line):
            title, _ = parse_heading(line)
            if title:
                return title
    return "Untitled"


def extract_meta_style_paths(text: str) -> Tuple[Optional[str], List[str]]:
    lines = text.splitlines()
    stack = []
    pending_heading = None
    code_fence = False
    top_nodes = []

    for line in lines:
        trimmed_left = line.lstrip()
        trimmed = trimmed_left.strip()

        if trimmed.startswith("```"):
            code_fence = not code_fence
            continue
        if code_fence:
            continue

        if trimmed == "":
            if stack:
                stack[-1]["paragraphs"].append("")
            continue

        if is_heading_line(trimmed_left):
            pending_heading = parse_heading(trimmed_left)
            continue

        if trimmed == "{":
            if pending_heading:
                title, ident = pending_heading
                node = {"title": title, "id": ident, "children": [], "paragraphs": []}
                if stack:
                    stack[-1]["children"].append(node)
                else:
                    top_nodes.append(node)
                stack.append(node)
                pending_heading = None
            continue

        if trimmed == "}":
            if stack:
                stack.pop()
            continue

        if stack:
            stack[-1]["paragraphs"].append(trimmed_left.strip())

    meta_node = None
    for node in top_nodes:
        if (node.get("id") or "").lower() == "meta":
            meta_node = node
            break

    if not meta_node:
        return None, []

    style_path = None
    style_append_paths: List[str] = []

    for child in meta_node.get("children", []):
        key = child.get("title", "").strip().lower()
        text_lines = [line for line in child.get("paragraphs", []) if line.strip()]
        if not text_lines:
            continue
        if key == "style":
            style_path = text_lines[0].strip()
        elif key in ("styleappend", "style-append"):
            style_append_paths.extend([line.strip() for line in text_lines if line.strip()])

    return style_path, style_append_paths


def load_config_chain(file_path: Path) -> Dict:
    start_dir = file_path.parent
    root_dir = ROOT
    chain = []
    current = start_dir
    while True:
        cfg = current / CONFIG_FILENAME
        if cfg.exists():
            try:
                data = json.loads(read_text(cfg))
                chain.append((current, data))
            except json.JSONDecodeError:
                pass
        if current == root_dir:
            break
        if current.parent == current:
            break
        current = current.parent

    merged = {
        "style": None,
        "styleAppend": [],
        "header": "",
        "footer": ""
    }

    for base_dir, data in reversed(chain):
        if not isinstance(data, dict):
            continue
        style = data.get("style")
        if isinstance(style, str):
            merged["style"] = (base_dir / style).resolve()

        style_append = data.get("styleAppend")
        if style_append:
            items = style_append if isinstance(style_append, list) else [style_append]
            for item in items:
                if isinstance(item, str):
                    merged["styleAppend"].append((base_dir / item).resolve())

        header = data.get("header")
        if isinstance(header, str):
            merged["header"] = header

        footer = data.get("footer")
        if isinstance(footer, str):
            merged["footer"] = footer

    return merged


def collect_sdoc_files() -> List[Path]:
    results = []
    for root, dirs, files in os.walk(ROOT):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for name in files:
            if name.endswith(".sdoc"):
                results.append(Path(root) / name)
    return sorted(results)


def choose_root_doc(docs: List[Dict]) -> Optional[str]:
    if not docs:
        return None
    preferred_names = {"index.sdoc", "readme.sdoc"}
    candidates = [doc for doc in docs if Path(doc["path"]).name.lower() in preferred_names]
    pool = candidates if candidates else docs

    def sort_key(doc: Dict) -> Tuple[int, str]:
        parts = doc["path"].split("/")
        return (len(parts), doc["path"])

    return sorted(pool, key=sort_key)[0]["id"]


def build_css_map(paths: List[Path]) -> Dict[str, str]:
    css_map: Dict[str, str] = {}
    for path in paths:
        rel = rel_posix(path)
        if not rel:
            continue
        if rel in css_map:
            continue
        try:
            css_map[rel] = read_text(path)
        except OSError:
            continue
    return css_map


def build_site() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    sdoc_web_source = read_text(ROOT / "src" / "sdoc.js")
    sdoc_web_source = sdoc_web_source.replace("module.exports = {", "window.SDOC = {")
    write_text(SDOC_WEB_JS, sdoc_web_source)

    docs = []
    css_paths: List[Path] = []

    for sdoc_path in collect_sdoc_files():
        content = read_text(sdoc_path)
        title = extract_title(content)
        rel_path = rel_posix(sdoc_path)
        if not rel_path:
            continue

        config = load_config_chain(sdoc_path)
        style_key = None
        style_append_keys: List[str] = []

        if config.get("style"):
            style_path = Path(config["style"])
            if style_path.exists():
                css_paths.append(style_path)
                style_key = rel_posix(style_path)

        for item in config.get("styleAppend", []):
            style_path = Path(item)
            if style_path.exists():
                css_paths.append(style_path)
                key = rel_posix(style_path)
                if key:
                    style_append_keys.append(key)

        meta_style, meta_append = extract_meta_style_paths(content)
        if meta_style:
            style_path = (sdoc_path.parent / meta_style).resolve()
            if style_path.exists():
                css_paths.append(style_path)
        for meta_item in meta_append:
            style_path = (sdoc_path.parent / meta_item).resolve()
            if style_path.exists():
                css_paths.append(style_path)

        docs.append({
            "id": rel_path,
            "path": rel_path,
            "dir": "" if Path(rel_path).parent.as_posix() == "." else str(Path(rel_path).parent.as_posix()),
            "title": title,
            "content": content,
            "config": {
                "header": config.get("header", ""),
                "footer": config.get("footer", ""),
                "styleKey": style_key,
                "styleAppendKeys": style_append_keys
            }
        })

    css_map = build_css_map(css_paths)

    from datetime import datetime, timezone

    root_doc_id = choose_root_doc(docs)

    data = {
        "root": ROOT.name,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "rootDocId": root_doc_id,
        "docs": docs,
        "cssMap": css_map
    }

    write_text(SDOC_DATA_JS, "window.SDOC_DATA = " + json.dumps(data, ensure_ascii=False) + ";")

    write_text(OUTPUT_DIR / "viewer.css", build_viewer_css())
    write_text(INDEX_HTML, build_index_html())


def build_viewer_css() -> str:
    return """
:root {
  --bg: #0c0f16;
  --panel: #131824;
  --panel-2: #1a2030;
  --panel-3: #22283a;
  --text: #e8eaf0;
  --muted: #9ca3b4;
  --accent: #63d1ff;
  --border: rgba(255, 255, 255, 0.08);
  --shadow: 0 10px 30px rgba(0, 0, 0, 0.3);
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: "Space Grotesk", "IBM Plex Sans", "Noto Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  height: 100vh;
}

#app {
  display: grid;
  grid-template-columns: 320px 1fr;
  width: 100%;
  height: 100%;
  transition: grid-template-columns 0.2s ease;
}

#app.sidebar-collapsed {
  grid-template-columns: 0 1fr;
}

#sidebar {
  background: linear-gradient(180deg, #141a28 0%, #0f121a 100%);
  border-right: 1px solid var(--border);
  padding: 18px 16px 24px;
  overflow: auto;
  transition: transform 0.2s ease;
  user-select: none;
}

#app.sidebar-collapsed #sidebar {
  transform: translateX(-100%);
  width: 0;
  padding: 0;
  overflow: hidden;
}

.sidebar-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}

.brand {
  font-size: 1.1rem;
  font-weight: 700;
}

.collapse-btn,
.open-btn {
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 10px;
  cursor: pointer;
}

#app.sidebar-collapsed .open-btn {
  display: inline-flex;
}

.open-btn {
  display: none;
}

.controls {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 12px;
  margin-bottom: 16px;
  box-shadow: var(--shadow);
}

.control-section {
  margin-bottom: 12px;
}

.control-section:last-child {
  margin-bottom: 0;
}

.control-label {
  font-size: 0.8rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  margin-bottom: 6px;
}

.segmented {
  display: flex;
  gap: 6px;
}

.segmented button {
  flex: 1;
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid var(--border);
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
}

.segmented button.active {
  border-color: var(--accent);
  color: var(--accent);
}

.selection {
  display: grid;
  gap: 6px;
}

.chip {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 0.9rem;
}

.chip.is-disabled {
  opacity: 0.55;
}

.chip-label {
  font-weight: 700;
  color: var(--accent);
}

.chip-clear {
  margin-left: auto;
  border: none;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  font-size: 1rem;
}

.chip-clear.is-hidden {
  visibility: hidden;
  pointer-events: none;
}

.chip-clear:disabled {
  opacity: 0.4;
  cursor: default;
}

.hint {
  font-size: 0.78rem;
  color: var(--muted);
  margin-top: 6px;
}

#search {
  width: 100%;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  margin-bottom: 16px;
  user-select: text;
}

#tree {
  font-size: 0.95rem;
  line-height: 1.4;
}

.tree-item {
  cursor: pointer;
  padding: 4px 6px;
  border-radius: 6px;
  color: var(--text);
}

.tree-item.active {
  background: rgba(99, 209, 255, 0.15);
  color: var(--accent);
}

.tree-item.compare {
  border: 1px dashed rgba(99, 209, 255, 0.5);
}

details.tree-folder {
  margin-bottom: 6px;
}

details.tree-folder summary {
  cursor: pointer;
  list-style: none;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 6px;
  color: var(--muted);
}

details.tree-folder summary::-webkit-details-marker {
  display: none;
}

details.tree-folder summary::before {
  content: "▸";
  font-size: 0.75rem;
  transform: rotate(0deg);
  transition: transform 0.15s ease;
}

details.tree-folder[open] summary::before {
  transform: rotate(90deg);
}

.tree-children {
  margin-left: 14px;
  border-left: 1px solid var(--border);
  padding-left: 10px;
  margin-top: 4px;
}

.hidden {
  display: none;
}

#main {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.main-topbar {
  background: var(--panel);
  border-bottom: 1px solid var(--border);
  padding: 10px 14px;
  display: flex;
  align-items: center;
  gap: 12px;
}

.doc-title {
  font-weight: 600;
}

#panes {
  flex: 1;
  display: grid;
  background: #0a0c10;
}

#panes.layout-single {
  grid-template-columns: 1fr;
}

#panes.layout-vertical {
  grid-template-columns: 1fr 1fr;
}

#panes.layout-horizontal {
  grid-template-rows: 1fr 1fr;
}

.pane {
  position: relative;
  border-right: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  background: #fff;
}

.pane:last-child {
  border-right: none;
  border-bottom: none;
}

.pane-label {
  position: absolute;
  top: 8px;
  right: 12px;
  font-size: 0.75rem;
  color: var(--muted);
  background: rgba(0, 0, 0, 0.4);
  padding: 2px 6px;
  border-radius: 4px;
  z-index: 2;
}

.pane-empty {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #6b7280;
  font-size: 0.95rem;
  background: #f5f6f8;
  z-index: 1;
}

.pane-content {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  background: #fff;
  z-index: 2;
}

#panes.layout-single .pane[data-pane="b"] {
  display: none;
}
"""


def build_index_html() -> str:
    return """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>SDOC Viewer</title>
  <link rel="stylesheet" href="viewer.css" />
</head>
<body>
  <div id="app" class="sidebar-open">
    <aside id="sidebar">
      <div class="sidebar-top">
        <div class="brand">SDOC Viewer</div>
        <button class="collapse-btn" id="collapseBtn">Hide</button>
      </div>

      <div class="controls">
        <div class="control-section">
          <div class="control-label">Layout</div>
          <div class="segmented">
            <button data-layout="single" class="active">Single</button>
            <button data-layout="vertical">Split L/R</button>
            <button data-layout="horizontal">Split T/B</button>
          </div>
        </div>

        <div class="control-section">
          <div class="control-label">Selection</div>
          <div class="selection">
            <div class="chip" id="chipA"><span class="chip-label">A</span><span class="chip-text"></span></div>
            <div class="chip" id="chipB"><span class="chip-label">B</span><span class="chip-text"></span><button class="chip-clear" id="clearB">×</button></div>
          </div>
          <div class="hint">Click to open. Shift+Click to compare.</div>
        </div>
      </div>

      <input id="search" placeholder="Filter files..." />
      <nav id="tree"></nav>
    </aside>

    <section id="main">
      <header class="main-topbar">
        <button class="open-btn" id="openBtn">Menu</button>
        <div class="doc-title" id="docTitle">Select a document</div>
      </header>
      <div id="panes" class="layout-single">
        <div class="pane" data-pane="a">
          <div class="pane-label">A</div>
          <div class="pane-empty" data-empty="a">Select a document</div>
          <div class="pane-content" data-pane-content="a"></div>
        </div>
        <div class="pane" data-pane="b">
          <div class="pane-label">B</div>
          <div class="pane-empty" data-empty="b">Shift+Click a document to compare</div>
          <div class="pane-content" data-pane-content="b"></div>
        </div>
      </div>
    </section>
  </div>

  <script src="sdoc-web.js"></script>
  <script src="sdoc-data.js"></script>
  <script>
    const data = window.SDOC_DATA || {};
    const docs = data.docs || [];
    const cssMap = data.cssMap || {};
    const rootDocId = data.rootDocId || (docs[0] && docs[0].id);

    const app = document.getElementById("app");
    const treeRoot = document.getElementById("tree");
    const searchInput = document.getElementById("search");
    const panes = document.getElementById("panes");
    const buttons = document.querySelectorAll("button[data-layout]");
    const chipA = document.getElementById("chipA");
    const chipB = document.getElementById("chipB");
    const chipAText = chipA.querySelector(".chip-text");
    const chipBText = chipB.querySelector(".chip-text");
    const clearB = document.getElementById("clearB");
    const collapseBtn = document.getElementById("collapseBtn");
    const openBtn = document.getElementById("openBtn");
    const docTitle = document.getElementById("docTitle");
    const paneA = document.querySelector('.pane[data-pane="a"] .pane-content');
    const paneB = document.querySelector('.pane[data-pane="b"] .pane-content');
    const emptyA = document.querySelector('[data-empty="a"]');
    const emptyB = document.querySelector('[data-empty="b"]');

    let selection = { a: null, b: null };
    let currentLayout = "single";
    let preferredSplit = "vertical";

    function buildTree() {
      const root = {};
      docs.forEach((doc) => {
        const parts = doc.path.split("/");
        let node = root;
        parts.forEach((part, idx) => {
          node[part] = node[part] || {};
          if (idx === parts.length - 1) {
            node[part].__doc = doc;
          }
          node = node[part];
        });
      });
      return root;
    }

    function createDocItem(doc) {
      const item = document.createElement("div");
      item.className = "tree-item";
      item.textContent = doc.path.split("/").pop().replace(/\\.sdoc$/, "");
      item.title = doc.title;
      item.dataset.docId = doc.id;
      item.addEventListener("click", (event) => {
        handleDocClick(doc, event.shiftKey);
      });
      return item;
    }

    function renderTree(node, container) {
      Object.keys(node)
        .filter((key) => key !== "__doc")
        .sort()
        .forEach((key) => {
          const entry = node[key];
          const doc = entry.__doc;
          const childKeys = Object.keys(entry).filter((k) => k !== "__doc");

          if (childKeys.length) {
            const details = document.createElement("details");
            details.className = "tree-folder";
            details.open = true;
            const summary = document.createElement("summary");
            summary.textContent = key;
            details.appendChild(summary);

            const children = document.createElement("div");
            children.className = "tree-children";
            if (doc) {
              children.appendChild(createDocItem(doc));
            }
            renderTree(entry, children);
            details.appendChild(children);
            container.appendChild(details);
          } else if (doc) {
            container.appendChild(createDocItem(doc));
          }
        });
    }

    function resolvePath(base, rel) {
      if (!rel) return "";
      if (rel.startsWith("/")) return rel.replace(/^\\//, "");
      const stack = base.split("/").filter((part) => part && part !== ".");
      rel.split("/").forEach((part) => {
        if (part === "." || part === "") return;
        if (part === "..") stack.pop();
        else stack.push(part);
      });
      return stack.join("/");
    }

    function resolveCss(doc, meta) {
      if (meta && meta.stylePath) {
        const key = resolvePath(doc.dir, meta.stylePath);
        return cssMap[key] || "";
      }
      if (doc.config.styleKey) {
        return cssMap[doc.config.styleKey] || "";
      }
      return "";
    }

    function resolveCssAppend(doc, meta) {
      const css = [];
      if (doc.config.styleAppendKeys) {
        doc.config.styleAppendKeys.forEach((key) => {
          if (cssMap[key]) css.push(cssMap[key]);
        });
      }
      if (meta && meta.styleAppendPath) {
        const parts = meta.styleAppendPath.split(/\\n+/).map((p) => p.trim()).filter(Boolean);
        parts.forEach((part) => {
          const key = resolvePath(doc.dir, part);
          if (cssMap[key]) css.push(cssMap[key]);
        });
      }
      return css.join("\\n");
    }

    function renderDoc(doc) {
      const parsed = window.SDOC.parseSdoc(doc.content);
      const metaResult = window.SDOC.extractMeta(parsed.nodes);
      const cssOverride = resolveCss(doc, metaResult.meta);
      const cssAppend = resolveCssAppend(doc, metaResult.meta);

      return window.SDOC.renderHtmlDocumentFromParsed(
        { nodes: metaResult.nodes, errors: parsed.errors },
        doc.title,
        {
          meta: metaResult.meta,
          config: {
            header: doc.config.header || "",
            footer: doc.config.footer || ""
          },
          cssOverride: cssOverride || undefined,
          cssAppend: cssAppend || undefined
        }
      );
    }

    function parseDocHtml(html) {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const styleEl = parsed.querySelector("style");
      const css = styleEl ? styleEl.textContent || "" : "";
      const bodyHtml = parsed.body ? parsed.body.innerHTML : html;
      return { css, bodyHtml };
    }

    function scopeCssForShadow(css) {
      if (!css) return "";
      let scoped = css.replace(/:root\\b/g, ":host");
      scoped = scoped.replace(/(^|[\\s,{>])body(?![\\w-])/g, "$1:host");
      scoped += "\\n:host { display: block; height: 100%; width: 100%; }\\n";
      return scoped;
    }

    function ensureShadowRoot(pane) {
      if (pane.shadowRoot) return pane.shadowRoot;
      return pane.attachShadow({ mode: "open" });
    }

    function setEmptyState(emptyEl, isVisible) {
      emptyEl.classList.toggle("hidden", !isVisible);
      emptyEl.hidden = !isVisible;
    }

    function renderPaneError(pane, message) {
      const shadow = ensureShadowRoot(pane);
      const safeMessage = String(message || "Unknown render error");
      shadow.innerHTML = `
        <style>
          :host { display: block; height: 100%; width: 100%; background: #fff; color: #1f2937; font-family: "Source Sans 3", "Noto Sans", "Segoe UI", "Helvetica Neue", Arial, sans-serif; }
          .sdoc-render-error { padding: 24px; }
          .sdoc-render-error h2 { margin: 0 0 8px; font-size: 1.1rem; }
          .sdoc-render-error pre { white-space: pre-wrap; background: #f5f6f8; border: 1px solid #e2e8f0; padding: 12px; border-radius: 8px; }
        </style>
        <div class="sdoc-render-error">
          <h2>Render error</h2>
          <pre>${safeMessage}</pre>
        </div>
      `;
    }

    function findDocById(id) {
      return docs.find((doc) => doc.id === id);
    }

    function docIdFromHash() {
      const raw = decodeURIComponent(window.location.hash || "").replace(/^#/, "");
      if (!raw) return null;
      if (raw.startsWith("doc=")) return raw.slice(4);
      return raw;
    }

    function selectDocById(id) {
      const doc = findDocById(id);
      if (!doc) return false;
      selection.a = doc;
      selection.b = null;
      updateLayout("single");
      return true;
    }

    function updatePane(pane, emptyEl, doc) {
      if (!doc) {
        if (pane.shadowRoot) {
          pane.shadowRoot.innerHTML = "";
        } else {
          pane.textContent = "";
        }
        setEmptyState(emptyEl, true);
        return;
      }
      setEmptyState(emptyEl, false);
      let html = "";
      try {
        html = renderDoc(doc);
      } catch (err) {
        renderPaneError(pane, err && err.message ? err.message : err);
        return;
      }
      const parts = parseDocHtml(html);
      const shadow = ensureShadowRoot(pane);
      const scopedCss = scopeCssForShadow(parts.css);
      shadow.innerHTML = `<style>${scopedCss}</style>${parts.bodyHtml}`;
    }

    function updateLayout(layout) {
      currentLayout = layout;
      panes.className = "";
      panes.classList.add(`layout-${layout}`);
      buttons.forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.layout === layout);
      });
      if (layout !== "single") {
        preferredSplit = layout;
      }
      if (layout === "single") {
        selection.b = null;
      }
      updateUI();
    }

    function updateSelectionChips() {
      chipAText.textContent = selection.a ? selection.a.title : "None selected";
      chipBText.textContent = selection.b ? selection.b.title : "Compare (shift-click)";
      const compareEnabled = currentLayout !== "single";
      chipB.classList.toggle("is-disabled", !compareEnabled);
      clearB.disabled = !selection.b || !compareEnabled;
      clearB.classList.toggle("is-hidden", !selection.b || !compareEnabled);
    }

    function updateTreeHighlight() {
      document.querySelectorAll(".tree-item").forEach((el) => {
        const id = el.dataset.docId;
        const isA = selection.a && id === selection.a.id;
        const isB = selection.b && id === selection.b.id;
        el.classList.toggle("active", isA);
        el.classList.toggle("compare", isB);
      });
    }

    function updateUI() {
      updateSelectionChips();
      updateTreeHighlight();
      docTitle.textContent = selection.a ? selection.a.title : "Select a document";

      updatePane(paneA, emptyA, selection.a);

      if (currentLayout === "single") {
        updatePane(paneB, emptyB, null);
      } else {
        updatePane(paneB, emptyB, selection.b);
      }
    }

    function handleDocClick(doc, isShift) {
      if (isShift) {
        if (selection.b && selection.b.id === doc.id) {
          selection.b = null;
        } else if (selection.a && selection.a.id === doc.id) {
          selection.b = doc;
        } else if (!selection.a) {
          selection.a = doc;
        } else {
          selection.b = doc;
        }
        if (selection.b && currentLayout === "single") {
          updateLayout(preferredSplit);
        } else {
          updateUI();
        }
        return;
      }

      selection.a = doc;
      selection.b = null;
      if (currentLayout !== "single") {
        updateLayout("single");
      } else {
        updateUI();
      }
    }

    function filterTree(query) {
      const q = query.toLowerCase();
      document.querySelectorAll(".tree-item").forEach((el) => {
        const doc = findDocById(el.dataset.docId);
        const text = (el.textContent + " " + (doc ? doc.title : "")).toLowerCase();
        const matches = !q || text.includes(q);
        el.classList.toggle("hidden", !matches);
      });

      document.querySelectorAll(".tree-folder").forEach((folder) => {
        const visible = folder.querySelector(".tree-item:not(.hidden)");
        folder.classList.toggle("hidden", !visible && q);
        if (q) {
          folder.open = true;
        }
      });
    }

    collapseBtn.addEventListener("click", () => {
      app.classList.add("sidebar-collapsed");
    });

    openBtn.addEventListener("click", () => {
      app.classList.remove("sidebar-collapsed");
    });

    buttons.forEach((btn) => {
      btn.addEventListener("click", () => updateLayout(btn.dataset.layout));
    });

    clearB.addEventListener("click", () => {
      selection.b = null;
      updateLayout("single");
    });

    searchInput.addEventListener("input", (e) => {
      filterTree(e.target.value);
    });

    const tree = buildTree();
    renderTree(tree, treeRoot);

    window.addEventListener("hashchange", () => {
      const hashId = docIdFromHash();
      if (hashId) {
        selectDocById(hashId);
      }
    });

    const initialHashId = docIdFromHash();
    if (!(initialHashId && selectDocById(initialHashId))) {
      if (rootDocId) {
        const rootDoc = findDocById(rootDocId);
        if (rootDoc) {
          selection.a = rootDoc;
        }
      } else if (docs.length) {
        selection.a = docs[0];
      }
      updateLayout("single");
    }
  </script>
</body>
</html>
"""


if __name__ == "__main__":
    build_site()
