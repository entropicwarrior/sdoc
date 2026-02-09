#!/usr/bin/env python3
import argparse
import http.server
import json
import os
import sys
import webbrowser
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse


CONFIG_FILENAME = "sdoc.config.json"
EXCLUDE_DIRS = {".git", "node_modules", ".vscode", "_sdoc_site", "web", "out", "__pycache__"}

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_DIR = SCRIPT_DIR.parent


def find_sdoc_js(source_dir: Path) -> Path:
    candidates = [
        source_dir / "src" / "sdoc.js",
        REPO_DIR / "src" / "sdoc.js",
    ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    print("Error: Could not find sdoc.js", file=sys.stderr)
    print("Searched:", file=sys.stderr)
    for c in candidates:
        print(f"  {c}", file=sys.stderr)
    sys.exit(1)


def find_site_template_dir(source_dir: Path) -> Path:
    candidates = [
        source_dir / "src" / "site-template",
        REPO_DIR / "src" / "site-template",
    ]
    for candidate in candidates:
        if (candidate / "viewer.css").exists() and (candidate / "index.html").exists():
            return candidate
    print("Error: Could not find site-template directory", file=sys.stderr)
    print("Searched:", file=sys.stderr)
    for c in candidates:
        print(f"  {c}", file=sys.stderr)
    sys.exit(1)


def rel_posix(path: Path, root: Path) -> Optional[str]:
    try:
        return path.relative_to(root).as_posix()
    except ValueError:
        return None


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


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
            # K&R: heading line ends with "{" — treat as heading + open brace
            heading_text = trimmed_left
            opens_brace = False
            if trimmed.endswith("{"):
                heading_text = trimmed_left.rstrip()[:-1]
                opens_brace = True

            pending_heading = parse_heading(heading_text)

            if opens_brace and pending_heading:
                title, ident = pending_heading
                node = {"title": title, "id": ident, "children": [], "paragraphs": []}
                if stack:
                    stack[-1]["children"].append(node)
                else:
                    top_nodes.append(node)
                stack.append(node)
                pending_heading = None
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


def load_config_chain(file_path: Path, root_dir: Path) -> Dict:
    start_dir = file_path.parent
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


def collect_sdoc_files(root: Path) -> List[Path]:
    results = []
    for dirpath, dirs, files in os.walk(root):
        dirs[:] = [d for d in dirs if d not in EXCLUDE_DIRS]
        for name in files:
            if name.endswith(".sdoc"):
                results.append(Path(dirpath) / name)
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


def build_css_map(paths: List[Path], root: Path) -> Dict[str, str]:
    css_map: Dict[str, str] = {}
    for p in paths:
        rel = rel_posix(p, root)
        if not rel:
            continue
        if rel in css_map:
            continue
        try:
            css_map[rel] = read_text(p)
        except OSError:
            continue
    return css_map


def build_manifest(source_dir: Path) -> Dict:
    source_dir = source_dir.resolve()
    docs = []
    css_paths: List[Path] = []

    for sdoc_path in collect_sdoc_files(source_dir):
        content = read_text(sdoc_path)
        title = extract_title(content)
        rp = rel_posix(sdoc_path, source_dir)
        if not rp:
            continue

        config = load_config_chain(sdoc_path, source_dir)
        style_key = None
        style_append_keys: List[str] = []

        if config.get("style"):
            style_path = Path(config["style"])
            if style_path.exists():
                css_paths.append(style_path)
                style_key = rel_posix(style_path, source_dir)

        for item in config.get("styleAppend", []):
            style_path = Path(item)
            if style_path.exists():
                css_paths.append(style_path)
                key = rel_posix(style_path, source_dir)
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

        doc_dir = Path(rp).parent.as_posix()
        docs.append({
            "id": rp,
            "path": rp,
            "dir": "" if doc_dir == "." else doc_dir,
            "title": title,
            "config": {
                "header": config.get("header", ""),
                "footer": config.get("footer", ""),
                "styleKey": style_key,
                "styleAppendKeys": style_append_keys
            }
        })

    css_map = build_css_map(css_paths, source_dir)
    root_doc_id = choose_root_doc(docs)

    return {
        "rootDocId": root_doc_id,
        "docs": docs,
        "cssMap": css_map
    }


class SdocHandler(http.server.BaseHTTPRequestHandler):
    source_dir: Path
    template_dir: Path
    sdoc_js_path: Path

    def log_message(self, format, *args):
        # Quieter logging: just method + path
        sys.stderr.write(f"{args[0]}\n")

    def do_GET(self):
        parsed = urlparse(self.path)
        pathname = parsed.path

        if pathname in ("/", "/index.html"):
            self._serve_file(self.template_dir / "index.html", "text/html")
        elif pathname == "/viewer.css":
            self._serve_file(self.template_dir / "viewer.css", "text/css")
        elif pathname == "/sdoc-web.js":
            self._serve_sdoc_web_js()
        elif pathname == "/api/manifest":
            self._serve_manifest()
        elif pathname == "/api/content":
            qs = parse_qs(parsed.query)
            rel_path = qs.get("path", [None])[0]
            self._serve_content(rel_path)
        else:
            self.send_error(404, "Not found")

    def _serve_file(self, file_path: Path, content_type: str):
        try:
            data = file_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.end_headers()
            self.wfile.write(data)
        except OSError:
            self.send_error(500, "Internal server error")

    def _serve_sdoc_web_js(self):
        try:
            source = read_text(self.sdoc_js_path)
            source = source.replace("module.exports = {", "window.SDOC = {")
            self.send_response(200)
            self.send_header("Content-Type", "application/javascript")
            self.end_headers()
            self.wfile.write(source.encode("utf-8"))
        except OSError:
            self.send_error(500, "Could not read sdoc.js")

    def _serve_manifest(self):
        manifest = build_manifest(self.source_dir)
        data = json.dumps(manifest, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(data)

    def _serve_content(self, rel_path: Optional[str]):
        if not rel_path:
            self.send_error(400, "Missing path parameter")
            return

        # Path traversal protection
        resolved = (self.source_dir / rel_path).resolve()
        if not str(resolved).startswith(str(self.source_dir.resolve())):
            self.send_error(403, "Forbidden")
            return

        if not str(resolved).endswith(".sdoc"):
            self.send_error(403, "Forbidden")
            return

        try:
            content = resolved.read_text(encoding="utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(content.encode("utf-8"))
        except OSError:
            self.send_error(404, "File not found")


def main():
    parser = argparse.ArgumentParser(
        description="Serve SDOC files with a local document viewer."
    )
    parser.add_argument(
        "source_dir",
        nargs="?",
        default=".",
        help="Directory containing .sdoc files (default: current directory)"
    )
    parser.add_argument(
        "-p", "--port",
        type=int,
        default=4070,
        help="Port to serve on (default: 4070)"
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="Don't open browser automatically"
    )
    args = parser.parse_args()

    source_dir = Path(args.source_dir).resolve()
    if not source_dir.is_dir():
        print(f"Error: {source_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    sdoc_js_path = find_sdoc_js(source_dir)
    template_dir = find_site_template_dir(source_dir)

    # Check for .sdoc files
    sdoc_files = collect_sdoc_files(source_dir)
    if not sdoc_files:
        print("No .sdoc files found.", file=sys.stderr)
        sys.exit(1)

    SdocHandler.source_dir = source_dir
    SdocHandler.template_dir = template_dir
    SdocHandler.sdoc_js_path = sdoc_js_path

    server = http.server.HTTPServer(("", args.port), SdocHandler)
    url = f"http://localhost:{args.port}"
    print(f"Serving {len(sdoc_files)} documents from {source_dir}")
    print(f"  {url}")
    print("Press Ctrl+C to stop.")

    if not args.no_open:
        webbrowser.open(url)

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        server.server_close()


if __name__ == "__main__":
    main()
