# sdoc
Smart Documentation

## Static Viewer
Build a static HTML viewer (sidebar + split panes) for all `.sdoc` files:
```
python3 tools/build_site.py
```

This generates:
- `web/index.html` (viewer UI)
- `web/sdoc-web.js` (browser renderer)
- `web/sdoc-data.js` (embedded docs + styles)

Open `web/index.html` in a browser (or serve `web/` with a simple HTTP server).
