const fs = require("fs");
const os = require("os");
const path = require("path");
const vscode = require("vscode");
const { parseSdoc, extractMeta, renderHtmlDocumentFromParsed } = require("./sdoc");

const PREVIEW_VIEW_TYPE = "sdoc.preview";
const CONFIG_FILENAME = "sdoc.config.json";

const panels = new Map();
let suppressNextUpdate = false;

function activate(context) {
  const previewCommand = vscode.commands.registerCommand("sdoc.preview", () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open an SDOC file to preview.");
      return;
    }
    if (editor.document.languageId !== "sdoc") {
      vscode.window.showInformationMessage("SDOC preview works with .sdoc files.");
      return;
    }
    showPreview(editor.document, editor.viewColumn);
  });

  const previewToSideCommand = vscode.commands.registerCommand("sdoc.previewToSide", () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage("Open an SDOC file to preview.");
      return;
    }
    if (editor.document.languageId !== "sdoc") {
      vscode.window.showInformationMessage("SDOC preview works with .sdoc files.");
      return;
    }
    showPreview(editor.document, vscode.ViewColumn.Beside);
  });

  const exportHtmlCommand = vscode.commands.registerCommand("sdoc.exportHtml", () => {
    exportHtml();
  });

  const openInBrowserCommand = vscode.commands.registerCommand("sdoc.openInBrowser", () => {
    openInBrowser();
  });

  context.subscriptions.push(previewCommand, previewToSideCommand, exportHtmlCommand, openInBrowserCommand);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== "sdoc") {
        return;
      }
      if (suppressNextUpdate) {
        suppressNextUpdate = false;
        return;
      }
      updatePreview(event.document);
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (document.languageId === "sdoc") {
        updatePreview(document);
        return;
      }

      const filePath = document.uri.fsPath;
      if (!filePath) {
        return;
      }

      if (path.basename(filePath) === CONFIG_FILENAME || filePath.endsWith(".css")) {
        updateAllPreviews();
      }
    })
  );

  context.subscriptions.push(
    vscode.workspace.onDidCloseTextDocument((document) => {
      const key = document.uri.toString();
      const panel = panels.get(key);
      if (panel) {
        panel.dispose();
        panels.delete(key);
      }
    })
  );
}

function deactivate() {
  panels.forEach((panel) => panel.dispose());
  panels.clear();
}

function showPreview(document, viewColumn) {
  const key = document.uri.toString();
  const existing = panels.get(key);

  if (existing) {
    existing.reveal(viewColumn, true);
    updatePreview(document);
    return;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const docDir = vscode.Uri.file(path.dirname(document.uri.fsPath));
  const localRoots = [docDir];
  if (workspaceFolder) {
    localRoots.push(workspaceFolder.uri);
  }

  const panel = vscode.window.createWebviewPanel(
    PREVIEW_VIEW_TYPE,
    buildTitle(document.uri),
    viewColumn ?? vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: localRoots
    }
  );

  panel.webview.onDidReceiveMessage((message) => {
    handleWebviewMessage(message, document);
  });

  panel.onDidDispose(() => {
    panels.delete(key);
  });

  panels.set(key, panel);
  updatePreview(document);
}

function handleWebviewMessage(message, document) {
  switch (message.type) {
    case "navigateToLine":
      navigateToLine(document, message.line);
      break;
    case "editParagraph":
      editParagraphInSource(document, message.lineStart, message.lineEnd, message.newText);
      break;
  }
}

function navigateToLine(document, line) {
  const lineIndex = Math.max(0, line - 1);
  const position = new vscode.Position(lineIndex, 0);
  const selection = new vscode.Selection(position, position);
  vscode.window.showTextDocument(document.uri, {
    viewColumn: vscode.ViewColumn.One,
    selection,
    preserveFocus: false
  });
}

function editParagraphInSource(document, lineStart, lineEnd, newText) {
  const startIndex = Math.max(0, lineStart - 1);
  const endIndex = Math.max(0, lineEnd - 1);

  const firstLine = document.lineAt(startIndex);
  const indentMatch = firstLine.text.match(/^(\s*)/);
  const indent = indentMatch ? indentMatch[1] : "";

  const newLines = newText.split("\n").map((l, i) => (i === 0 ? indent + l : indent + l));
  const newContent = newLines.join("\n");

  const range = new vscode.Range(
    new vscode.Position(startIndex, 0),
    new vscode.Position(endIndex, document.lineAt(endIndex).text.length)
  );

  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, range, newContent);

  suppressNextUpdate = true;
  vscode.workspace.applyEdit(edit);
}

function updatePreview(document) {
  const key = document.uri.toString();
  const panel = panels.get(key);
  if (!panel) {
    return;
  }
  panel.title = buildTitle(document.uri);
  panel.webview.html = buildHtml(document, panel.title, panel.webview);
}

function buildTitle(uri) {
  const name = uri.fsPath ? path.basename(uri.fsPath) : uri.path.split("/").pop() ?? "SDOC";
  return `SDOC Preview: ${name}`;
}

function buildWebviewScript() {
  return `
(function() {
  const vscodeApi = acquireVsCodeApi();

  // Click-to-navigate
  document.addEventListener('click', function(e) {
    // Skip if clicking inside contenteditable or toggle
    if (e.target.closest('[contenteditable]') && !e.target.classList.contains('sdoc-toggle')) {
      return;
    }
    if (e.target.classList.contains('sdoc-toggle')) {
      return;
    }
    const el = e.target.closest('[data-line]');
    if (el) {
      const line = parseInt(el.getAttribute('data-line'), 10);
      if (!isNaN(line)) {
        vscodeApi.postMessage({ type: 'navigateToLine', line: line });
      }
    }
  });

  // Collapsible scopes
  document.addEventListener('click', function(e) {
    if (!e.target.classList.contains('sdoc-toggle')) {
      return;
    }
    e.stopPropagation();
    const scope = e.target.closest('.sdoc-scope');
    if (scope) {
      scope.classList.toggle('sdoc-collapsed');
      saveCollapseState();
    }
  });

  function saveCollapseState() {
    const collapsed = [];
    document.querySelectorAll('.sdoc-scope.sdoc-collapsed').forEach(function(el) {
      const heading = el.querySelector(':scope > .sdoc-heading');
      if (!heading) return;
      const id = heading.getAttribute('id');
      const line = heading.getAttribute('data-line');
      collapsed.push(id || ('line:' + line));
    });
    vscodeApi.setState({ collapsed: collapsed });
  }

  function restoreCollapseState() {
    const state = vscodeApi.getState();
    if (!state || !state.collapsed) return;
    state.collapsed.forEach(function(key) {
      var el;
      if (key.startsWith('line:')) {
        var line = key.slice(5);
        var heading = document.querySelector('.sdoc-heading[data-line="' + line + '"]');
        el = heading ? heading.closest('.sdoc-scope') : null;
      } else {
        var heading = document.getElementById(key);
        el = heading ? heading.closest('.sdoc-scope') : null;
      }
      if (el) {
        el.classList.add('sdoc-collapsed');
      }
    });
  }

  restoreCollapseState();

  // Inline editing
  document.addEventListener('focusout', function(e) {
    var el = e.target;
    if (el.tagName !== 'P' || !el.classList.contains('sdoc-paragraph') || !el.hasAttribute('contenteditable')) {
      return;
    }
    var lineStart = parseInt(el.getAttribute('data-line'), 10);
    var lineEnd = parseInt(el.getAttribute('data-line-end') || el.getAttribute('data-line'), 10);
    if (isNaN(lineStart)) return;
    var newText = el.innerText;
    vscodeApi.postMessage({ type: 'editParagraph', lineStart: lineStart, lineEnd: lineEnd, newText: newText });
  });

  document.addEventListener('keydown', function(e) {
    var el = e.target;
    if (!el.hasAttribute('contenteditable')) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      el.blur();
    }
    if (e.key === 'Escape') {
      el.blur();
    }
  });
})();
`;
}

function buildCollapseCss() {
  return `
  /* Collapsible scope toggles */
  .sdoc-heading:has(.sdoc-toggle) {
    position: relative;
  }

  .sdoc-toggle {
    position: absolute;
    left: -1.4em;
    top: 0;
    bottom: 0;
    width: 1.2em;
    cursor: pointer;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .sdoc-toggle::before {
    content: '';
    display: block;
    width: 0.45em;
    height: 0.45em;
    border-right: 2px solid var(--sdoc-muted);
    border-bottom: 2px solid var(--sdoc-muted);
    transition: transform 0.15s;
    transform: rotate(45deg);
    position: absolute;
    top: 0.18em;
    left: 50%;
    margin-left: -0.3em;
  }

  .sdoc-scope:hover > .sdoc-heading > .sdoc-toggle {
    opacity: 1;
  }

  .sdoc-scope.sdoc-collapsed > .sdoc-heading > .sdoc-toggle {
    opacity: 0.6;
  }

  .sdoc-scope.sdoc-collapsed > .sdoc-heading > .sdoc-toggle::before {
    transform: rotate(-45deg);
    margin-left: -0.15em;
  }

  .sdoc-scope.sdoc-collapsed > .sdoc-scope-children {
    display: none;
  }
`;
}

function buildInteractiveCss() {
  return `
  /* Interactive preview styles */
  [data-line] {
    cursor: pointer;
  }

  [data-line]:hover {
    outline: 1px dashed var(--sdoc-border);
    outline-offset: 2px;
  }

  p.sdoc-paragraph[contenteditable]:hover {
    outline: 1px solid var(--sdoc-border);
    outline-offset: 2px;
  }

  p.sdoc-paragraph[contenteditable]:focus {
    outline: 2px solid var(--sdoc-accent);
    outline-offset: 2px;
    cursor: text;
  }
${buildCollapseCss()}
`;
}

function buildHtml(document, title, webview) {
  const parsed = parseSdoc(document.getText());
  const metaResult = extractMeta(parsed.nodes);
  const config = loadConfigForDocument(document);
  const metaStyles = resolveMetaStyles(metaResult.meta, document.uri.fsPath);

  const cssOverride = metaStyles.styleCss ?? loadCss(config.style);
  const cssAppendParts = [];
  if (config.styleAppend && config.styleAppend.length) {
    for (const stylePath of config.styleAppend) {
      const css = loadCss(stylePath);
      if (css) {
        cssAppendParts.push(css);
      }
    }
  }
  if (metaStyles.styleAppendCss) {
    cssAppendParts.push(metaStyles.styleAppendCss);
  }
  cssAppendParts.push(buildInteractiveCss());

  let html = renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    title,
    {
      meta: metaResult.meta,
      config,
      cssOverride: cssOverride || undefined,
      cssAppend: cssAppendParts.join("\n"),
      script: buildWebviewScript(),
      renderOptions: { editable: true }
    }
  );

  if (webview) {
    const docDir = path.dirname(document.uri.fsPath);
    html = rewriteLocalImages(html, docDir, webview);
  }

  return html;
}

function rewriteLocalImages(html, docDir, webview) {
  return html.replace(/(<img\s[^>]*src=")([^"]+)(")/g, (match, before, src, after) => {
    if (/^https?:\/\//i.test(src) || src.startsWith("data:")) {
      return match;
    }
    const absPath = path.isAbsolute(src) ? src : path.join(docDir, src);
    const fileUri = vscode.Uri.file(absPath);
    const webviewUri = webview.asWebviewUri(fileUri);
    return before + webviewUri.toString() + after;
  });
}

function updateAllPreviews() {
  for (const [key, panel] of panels.entries()) {
    const uri = vscode.Uri.parse(key);
    vscode.workspace.openTextDocument(uri).then((doc) => {
      panel.title = buildTitle(uri);
      panel.webview.html = buildHtml(doc, panel.title, panel.webview);
    });
  }
}

function loadConfigForDocument(document) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const startDir = document.uri.fsPath ? path.dirname(document.uri.fsPath) : "";
  const rootDir = workspaceFolder ? workspaceFolder.uri.fsPath : path.parse(startDir).root;

  const chain = [];
  let current = startDir;
  while (current) {
    const configPath = path.join(current, CONFIG_FILENAME);
    if (fs.existsSync(configPath)) {
      const parsed = readJson(configPath);
      if (parsed) {
        chain.push({ dir: current, config: parsed });
      }
    }

    if (current === rootDir) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  const merged = { style: null, styleAppend: [], header: "", footer: "" };
  for (const entry of chain.reverse()) {
    mergeConfig(merged, entry.config, entry.dir);
  }
  return merged;
}

function mergeConfig(target, config, baseDir) {
  if (!config || typeof config !== "object") {
    return;
  }
  if (typeof config.style === "string") {
    target.style = resolvePath(baseDir, config.style);
  }

  if (config.styleAppend) {
    const list = Array.isArray(config.styleAppend) ? config.styleAppend : [config.styleAppend];
    for (const item of list) {
      if (typeof item === "string") {
        target.styleAppend.push(resolvePath(baseDir, item));
      }
    }
  }

  if (typeof config.header === "string") {
    target.header = config.header;
  }

  if (typeof config.footer === "string") {
    target.footer = config.footer;
  }
}

function resolveMetaStyles(meta, documentPath) {
  const docDir = documentPath ? path.dirname(documentPath) : "";
  const result = {
    styleCss: null,
    styleAppendCss: null
  };

  if (meta && meta.stylePath) {
    const stylePath = resolvePath(docDir, meta.stylePath);
    result.styleCss = loadCss(stylePath);
  }

  if (meta && meta.styleAppendPath) {
    const styleAppendPath = resolvePath(docDir, meta.styleAppendPath);
    result.styleAppendCss = loadCss(styleAppendPath);
  }

  return result;
}

function resolvePath(baseDir, target) {
  if (!target) {
    return "";
  }
  if (path.isAbsolute(target)) {
    return target;
  }
  return path.join(baseDir, target);
}

function loadCss(filePath) {
  if (!filePath) {
    return null;
  }
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function readJson(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getActivePreviewDocument() {
  for (const [key, panel] of panels.entries()) {
    if (panel.active) {
      return vscode.workspace.openTextDocument(vscode.Uri.parse(key));
    }
  }
  return null;
}

function buildCollapseScript() {
  return `
(function() {
  document.addEventListener('click', function(e) {
    if (!e.target.classList.contains('sdoc-toggle')) return;
    e.stopPropagation();
    var scope = e.target.closest('.sdoc-scope');
    if (scope) scope.classList.toggle('sdoc-collapsed');
  });
})();
`;
}

function buildCleanHtml(document) {
  const parsed = parseSdoc(document.getText());
  const metaResult = extractMeta(parsed.nodes);
  const config = loadConfigForDocument(document);
  const metaStyles = resolveMetaStyles(metaResult.meta, document.uri.fsPath);

  const cssOverride = metaStyles.styleCss ?? loadCss(config.style);
  const cssAppendParts = [];
  if (config.styleAppend && config.styleAppend.length) {
    for (const stylePath of config.styleAppend) {
      const css = loadCss(stylePath);
      if (css) {
        cssAppendParts.push(css);
      }
    }
  }
  if (metaStyles.styleAppendCss) {
    cssAppendParts.push(metaStyles.styleAppendCss);
  }

  const title = path.basename(document.uri.fsPath, ".sdoc");

  cssAppendParts.push(buildCollapseCss());

  return renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    title,
    {
      meta: metaResult.meta,
      config,
      cssOverride: cssOverride || undefined,
      cssAppend: cssAppendParts.join("\n"),
      script: buildCollapseScript()
    }
  );
}

async function exportHtml() {
  const docPromise = getActivePreviewDocument();
  if (!docPromise) {
    vscode.window.showInformationMessage("No SDOC preview is active.");
    return;
  }

  const document = await docPromise;
  const baseName = path.basename(document.uri.fsPath, ".sdoc") + ".html";
  const defaultUri = vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), baseName));

  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: { "HTML": ["html"] }
  });

  if (!target) {
    return;
  }

  const html = buildCleanHtml(document);
  fs.writeFileSync(target.fsPath, html, "utf8");
  vscode.window.showInformationMessage(`Exported: ${path.basename(target.fsPath)}`);
}

async function openInBrowser() {
  const docPromise = getActivePreviewDocument();
  if (!docPromise) {
    vscode.window.showInformationMessage("No SDOC preview is active.");
    return;
  }

  const document = await docPromise;
  const html = buildCleanHtml(document);

  const tmpDir = os.tmpdir();
  const baseName = path.basename(document.uri.fsPath, ".sdoc") + ".html";
  const tmpPath = path.join(tmpDir, `sdoc-${baseName}`);
  fs.writeFileSync(tmpPath, html, "utf8");

  vscode.env.openExternal(vscode.Uri.file(tmpPath));
}

module.exports = {
  activate,
  deactivate
};
