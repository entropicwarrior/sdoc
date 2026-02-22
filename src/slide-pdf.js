// SDOC Slides — PDF export via headless Chrome.
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

function exportPdf(htmlPath, pdfPath) {
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

    // 13.333 x 7.5 inches = 16:9 landscape (standard presentation aspect ratio)
    const args = [
      "--headless",
      "--disable-gpu",
      "--no-pdf-header-footer",
      "--print-to-pdf=" + resolvedPdf,
      "--print-to-pdf-paper-width=13.333",
      "--print-to-pdf-paper-height=7.5",
      fileUrl,
    ];

    execFile(chrome, args, { timeout: 30000 }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(`Chrome PDF export failed: ${err.message}\n${stderr}`));
      } else {
        resolve(resolvedPdf);
      }
    });
  });
}

module.exports = { findChrome, exportPdf };
