#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Dict, List, Optional, Tuple


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
    for path in paths:
        rel = rel_posix(path, root)
        if not rel:
            continue
        if rel in css_map:
            continue
        try:
            css_map[rel] = read_text(path)
        except OSError:
            continue
    return css_map


def build_site(source_dir: Path, output_dir: Path) -> None:
    source_dir = source_dir.resolve()
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    sdoc_js_path = find_sdoc_js(source_dir)
    sdoc_web_source = read_text(sdoc_js_path)
    sdoc_web_source = sdoc_web_source.replace("module.exports = {", "window.SDOC = {")
    write_text(output_dir / "sdoc-web.js", sdoc_web_source)

    template_dir = find_site_template_dir(source_dir)

    docs = []
    css_paths: List[Path] = []

    for sdoc_path in collect_sdoc_files(source_dir):
        content = read_text(sdoc_path)
        title = extract_title(content)
        rel_path = rel_posix(sdoc_path, source_dir)
        if not rel_path:
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

    css_map = build_css_map(css_paths, source_dir)

    from datetime import datetime, timezone

    root_doc_id = choose_root_doc(docs)

    data = {
        "root": source_dir.name,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "rootDocId": root_doc_id,
        "docs": docs,
        "cssMap": css_map
    }

    write_text(output_dir / "sdoc-data.js", "window.SDOC_DATA = " + json.dumps(data, ensure_ascii=False) + ";")
    shutil.copy2(template_dir / "viewer.css", output_dir / "viewer.css")
    shutil.copy2(template_dir / "index.html", output_dir / "index.html")

    print(f"Built {len(docs)} documents \u2192 {output_dir}")


def main():
    parser = argparse.ArgumentParser(
        description="Build a self-contained static SDOC viewer site."
    )
    parser.add_argument(
        "source_dir",
        nargs="?",
        default=".",
        help="Directory containing .sdoc files (default: current directory)"
    )
    parser.add_argument(
        "-o", "--output",
        default=None,
        help="Output directory (default: _sdoc_site/ inside source_dir)"
    )
    args = parser.parse_args()

    source_dir = Path(args.source_dir).resolve()
    if not source_dir.is_dir():
        print(f"Error: {source_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    if args.output:
        output_dir = Path(args.output).resolve()
    else:
        output_dir = source_dir / "_sdoc_site"

    build_site(source_dir, output_dir)


if __name__ == "__main__":
    main()
