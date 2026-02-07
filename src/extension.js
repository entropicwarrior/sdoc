const fs = require("fs");
const path = require("path");
const vscode = require("vscode");
const { parseSdoc, extractMeta, renderHtmlDocumentFromParsed } = require("./sdoc");

const PREVIEW_VIEW_TYPE = "sdoc.preview";
const CONFIG_FILENAME = "sdoc.config.json";

const panels = new Map();

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

  context.subscriptions.push(previewCommand, previewToSideCommand);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId !== "sdoc") {
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
      enableScripts: false,
      retainContextWhenHidden: true,
      localResourceRoots: localRoots
    }
  );

  panel.onDidDispose(() => {
    panels.delete(key);
  });

  panels.set(key, panel);
  updatePreview(document);
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

  let html = renderHtmlDocumentFromParsed(
    { nodes: metaResult.nodes, errors: parsed.errors },
    title,
    {
      meta: metaResult.meta,
      config,
      cssOverride: cssOverride || undefined,
      cssAppend: cssAppendParts.join("\n")
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

module.exports = {
  activate,
  deactivate
};
