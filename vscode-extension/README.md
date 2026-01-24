# VSCode Extension for SDOC

This directory contains a VSCode extension for syntax highlighting of SDOC files.

## Features

- Syntax highlighting for `.sdoc` files
- Auto-closing of braces and quotes
- Bracket matching
- Proper indentation

## Installation

1. Copy this directory to your VSCode extensions folder:
   - **Windows**: `%USERPROFILE%\.vscode\extensions\`
   - **macOS/Linux**: `~/.vscode/extensions/`

2. Reload VSCode

3. Open any `.sdoc` file to see syntax highlighting

## Developing

To modify the syntax highlighting:

1. Edit `syntaxes/sdoc.tmLanguage.json`
2. Reload VSCode with `Ctrl+Shift+P` > "Developer: Reload Window"

## Publishing

To publish this extension to the VSCode Marketplace:

```bash
npm install -g vsce
vsce package
vsce publish
```

See [VSCode Extension Publishing](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) for more details.
