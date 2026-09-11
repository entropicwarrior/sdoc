// SDOC Slides — theme loading.
//
// A theme is a directory holding `theme.css`, optionally `theme.js`, and
// optionally assets the CSS refers to: web fonts, background images, textures.
//
// Loading a theme inlines those assets. Every `url(...)` in the stylesheet
// that names a path relative to the theme directory is replaced by a `data:`
// URI, so the built deck stays a single self-contained file that renders the
// same offline, on another machine, and inside headless Chrome during PDF
// export. Absolute URLs, protocol-relative URLs and existing `data:` URIs are
// left alone.

const fs = require("fs");
const path = require("path");

const MIME_TYPES = {
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
};

function isExternal(url) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url);
}

// Replaces relative url(...) references in `css` with data: URIs read from
// `baseDir`. Returns { css, inlined, missing }.
function inlineCssAssets(css, baseDir) {
  const inlined = [];
  const missing = [];

  const out = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (match, _quote, url) => {
    const target = url.trim();
    if (!target || isExternal(target)) return match;

    // Strip any ?query or #fragment before resolving against the file system.
    const clean = target.replace(/[?#].*$/, "");
    const filePath = path.resolve(baseDir, clean);

    // Refuse to read outside the theme directory.
    const relative = path.relative(baseDir, filePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      missing.push(target);
      return match;
    }

    if (!fs.existsSync(filePath)) {
      missing.push(target);
      return match;
    }

    const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
    const data = fs.readFileSync(filePath).toString("base64");
    inlined.push(relative);
    return `url("data:${mime};base64,${data}")`;
  });

  return { css: out, inlined, missing };
}

// The design box and print page a theme uses when it declares none.
// 1280 x 720 CSS px is exactly 13.333 x 7.5 in at 96 dpi, so screen and PDF
// are the same geometry by construction.
const DEFAULT_THEME_CONFIG = {
  slide: { width: 1280, height: 720 },
  page: { width: 13.333, height: 7.5 },
  // How the slide meets a window of a different shape: contain, cover or
  // stretch. The CLI's --fit overrides whatever a theme declares.
  fit: "contain",
};

function readThemeConfig(themeDir) {
  const jsonPath = path.join(themeDir, "theme.json");
  if (!fs.existsSync(jsonPath)) return { config: { ...DEFAULT_THEME_CONFIG }, warning: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    return {
      config: {
        fit: DEFAULT_THEME_CONFIG.fit,
        ...parsed,
        slide: { ...DEFAULT_THEME_CONFIG.slide, ...(parsed.slide || {}) },
        page: { ...DEFAULT_THEME_CONFIG.page, ...(parsed.page || {}) },
      },
      warning: null,
    };
  } catch (err) {
    return {
      config: { ...DEFAULT_THEME_CONFIG },
      warning: `theme.json could not be parsed (${err.message}); using the default design box`,
    };
  }
}

// Reads a theme directory. `fallbackDir` supplies theme.js when the theme
// ships none, which is how a theme opts into the default runtime (keyboard
// navigation, touch, fit-to-window scaling) without copying it.
function loadTheme(themeDir, fallbackDir) {
  const resolved = path.resolve(themeDir);
  const cssPath = path.join(resolved, "theme.css");
  const jsPath = path.join(resolved, "theme.js");

  const warnings = [];
  let themeCss = "";
  let themeJs = "";

  const { config: themeConfig, warning: configWarning } = readThemeConfig(resolved);
  if (configWarning) warnings.push(configWarning);

  if (fs.existsSync(cssPath)) {
    const raw = fs.readFileSync(cssPath, "utf-8");
    const { css, missing } = inlineCssAssets(raw, resolved);
    themeCss = css;
    for (const ref of missing) {
      warnings.push(`theme asset not found, left as a plain reference: ${ref}`);
    }
  } else {
    warnings.push(`theme.css not found at ${cssPath}`);
  }

  if (fs.existsSync(jsPath)) {
    themeJs = fs.readFileSync(jsPath, "utf-8");
  } else if (fallbackDir) {
    const fallbackJs = path.join(path.resolve(fallbackDir), "theme.js");
    if (fs.existsSync(fallbackJs)) {
      themeJs = fs.readFileSync(fallbackJs, "utf-8");
    }
  }

  return { themeCss, themeJs, themeConfig, warnings, dir: resolved };
}

module.exports = { loadTheme, inlineCssAssets, readThemeConfig, DEFAULT_THEME_CONFIG };
