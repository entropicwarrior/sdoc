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

This generates the viewer in `web/` — open `web/index.html` in a browser.
