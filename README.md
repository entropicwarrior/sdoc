# sdoc
Smart Documentation

## VSCode Extension
```
npm install
npm run package
code --install-extension dist/sdoc-*.vsix
```

## Static Viewer
Build a static HTML viewer (sidebar + split panes) for all `.sdoc` files:
```
python3 tools/build_site.py
```

This generates the viewer in `_sdoc_site/` — open `_sdoc_site/index.html` in a browser.

Or use the **SDOC: Build Site** command from the VSCode Command Palette.
