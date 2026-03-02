// SDOC — PDF export via headless Chrome.
// Zero dependencies: uses child_process to shell out to the system Chrome/Chromium.

const { execFile } = require("child_process");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CHROME_PATHS = {
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  ],
  linux: [
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ],
  win32: [
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  ],
};

function findChrome() {
  if (process.env.CHROME_PATH) {
    return process.env.CHROME_PATH;
  }

  const platform = os.platform();
  const candidates = CHROME_PATHS[platform] || [];

  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (fs.existsSync(candidate)) return candidate;
    } else {
      try {
        const result = execFileSync("which", [candidate], { encoding: "utf-8" }).trim();
        if (result) return result;
      } catch {
        // not found, try next
      }
    }
  }

  return null;
}

// Generic PDF export. Options:
//   paperWidth  — inches (default 8.27 = A4)
//   paperHeight — inches (default 11.69 = A4)
//   noHeaderFooter — suppress Chrome header/footer (default true)
function chromePdf(htmlPath, pdfPath, options = {}) {
  return new Promise((resolve, reject) => {
    const chrome = findChrome();
    if (!chrome) {
      reject(new Error(
        "Chrome/Chromium not found. Install Google Chrome or set CHROME_PATH environment variable."
      ));
      return;
    }

    const fileUrl = "file://" + path.resolve(htmlPath);
    const resolvedPdf = path.resolve(pdfPath);

    // Use a temporary user-data-dir so headless Chrome doesn't conflict
    // with any running browser session (Chrome 112+ new headless shares
    // the browser process by default, which corrupts PDF output).
    const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "sdoc-chrome-"));

    const paperWidth = options.paperWidth ?? 8.27;
    const paperHeight = options.paperHeight ?? 11.69;

    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--user-data-dir=" + tmpProfile,
      "--print-to-pdf=" + resolvedPdf,
      "--print-to-pdf-paper-width=" + paperWidth,
      "--print-to-pdf-paper-height=" + paperHeight,
    ];

    if (options.noHeaderFooter !== false) {
      args.push("--no-pdf-header-footer");
    }

    args.push(fileUrl);

    execFile(chrome, args, { timeout: 30000 }, (err, _stdout, stderr) => {
      // Clean up temp profile
      fs.rm(tmpProfile, { recursive: true, force: true }, () => {});

      if (err) {
        reject(new Error(`Chrome PDF export failed: ${err.message}\n${stderr}`));
      } else {
        resolve(resolvedPdf);
      }
    });
  });
}

// Slide PDF: 16:9 landscape (13.333 x 7.5 inches)
function exportSlidePdf(htmlPath, pdfPath) {
  return chromePdf(htmlPath, pdfPath, { paperWidth: 13.333, paperHeight: 7.5 });
}

// Document PDF: A4 portrait (8.27 x 11.69 inches)
function exportDocPdf(htmlPath, pdfPath) {
  return chromePdf(htmlPath, pdfPath);
}

module.exports = { findChrome, exportSlidePdf, exportDocPdf, chromePdf };
