# sdoc
Smart Documentation

## VSCode Extension
```
npm install
npm run package
code --install-extension dist/sdoc-*.vsix
```

## Document Server
Browse all `.sdoc` files with a local HTTP server (sidebar + split panes):
```
python3 tools/serve_docs.py
```

Or use the **SDOC: Browse Documents** command from the VSCode Command Palette.

The viewer opens in your browser. Edits to `.sdoc` files are reflected on refresh.
