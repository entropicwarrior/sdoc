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
// 1920 x 1080 CSS px is exactly 20 x 11.25 in at 96 dpi, so screen and PDF
// are the same geometry by construction.
//
// 1920 rather than the 1280 this started at, because that is the canvas a
// Claude Slides artifact is fixed at, so the export copies lengths across
// instead of scaling them.
//
// That is the whole of what it buys. A deck is scaled to the window whatever
// the box, so nothing changes on screen; only the physical page a PDF and a
// .pptx are cut to. In particular it does NOT lift the theme's small type
// over that format's 24px minimum: an em is a ratio, so a 0.7em footer is
// 0.7em of whatever the base is and lands in the same place either way.
// Raising it is a separate thing the exporter does, and still has to.
const DEFAULT_THEME_CONFIG = {
  slide: { width: 1920, height: 1080 },
  page: { width: 20, height: 11.25 },
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

// The drilldown chevron used to be a pseudo-element on .slide-has-details.
// It is now two real elements, .nav-up and .nav-down, which the runtime shows
// and hides per position. A theme derived from the default before that change
// still carries the old rule, and the old rule still renders: `content` on
// .slide-has-details::after paints a chevron of its own whatever the renderer
// emits. The result is two chevrons a few pixels apart on every spine slide
// that has details, and nothing in the build otherwise notices, because the
// duplicate is in the theme and the original is in the renderer.
//
// Only a rule that actually paints something is worth warning about, so a
// `content` of none/normal/empty is left alone.
const NO_CONTENT = new Set(["none", "normal", '""', "''"]);

function staleChevronWarnings(css) {
  // Comments first: a theme that merely *documents* the old rule is fine.
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const warnings = [];
  // Innermost declaration blocks: the selector cannot contain braces, so this
  // also reaches rules nested inside @media without tripping on the wrapper.
  const rule = /([^{}]*)\{([^{}]*)\}/g;
  let match;
  while ((match = rule.exec(stripped)) !== null) {
    const selector = match[1];
    if (!/\.slide-has-details\s*::?after\b/.test(selector)) continue;
    const content = /(?:^|[;{\s])content\s*:\s*([^;]+)/i.exec(match[2]);
    if (!content) continue;
    if (NO_CONTENT.has(content[1].trim().toLowerCase())) continue;
    warnings.push(
      "theme still draws the old drilldown chevron with " +
      "`.slide-has-details::after { content: ... }`. That is now a duplicate of " +
      ".nav-down, which the renderer emits and the runtime drives, so spine " +
      "slides with details show two chevrons. Remove the rule from the theme."
    );
    break; // one rule is enough to say it; listing every copy adds no information
  }
  return warnings;
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
    warnings.push(...staleChevronWarnings(raw));
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

module.exports = { loadTheme, inlineCssAssets, readThemeConfig, staleChevronWarnings, DEFAULT_THEME_CONFIG };
