# SDOC - Smart Documentation

A modern, machine-ready documentation format with explicit scoping, automatic numbering, and unique IDs.

![Example SDOC Rendering](https://github.com/user-attachments/assets/6f5b9e3e-903c-4efa-9880-155c20e014d9)

## Features

- **Explicit Scopes**: All content blocks are explicitly scoped using `@blocktype` syntax
- **Automatic Numbering**: Sections and subsections are numbered automatically (1, 1.1, 1.2, 2, etc.)
- **Unique IDs**: Every entity gets a unique identifier for cross-referencing
- **Machine-Ready**: Structured format that's easy to parse and process programmatically
- **Human-Readable**: Clean, readable syntax similar to markdown

## Installation

```bash
npm install sdoc
```

## Quick Start

### 1. Create an SDOC file

Create a file `document.sdoc`:

```sdoc
@document {
  title: "My First Document"
  author: "Your Name"
  version: "1.0"
}

@section {
  title: "Introduction"
  
  @text {
    This is my first SDOC document with *automatic numbering* and **explicit structure**.
  }
  
  @list {
    - Easy to read
    - Easy to parse
    - Automatically numbered
  }
}
```

### 2. Convert to HTML

```bash
npx sdoc document.sdoc
```

This generates `document.html` which you can open in a browser.

## CLI Usage

```bash
sdoc <input.sdoc> [output.html]
```

## Programmatic Usage

```javascript
import { renderToHtml, parse } from 'sdoc';

// Render to HTML
const sdocContent = `
@document {
  title: "Example"
}

@section {
  title: "Hello World"
  
  @text {
    This is a paragraph.
  }
}
`;

const html = renderToHtml(sdocContent);
console.log(html);

// Or parse to AST
const ast = parse(sdocContent);
console.log(ast);
```

## Format Specification

See [SPEC.md](./SPEC.md) for the complete format specification.

### Block Types

- `@document` - Document metadata (title, author, version)
- `@section` - Numbered sections (can be nested)
- `@text` - Text paragraphs
- `@list` - Bulleted lists
- `@code` - Code blocks with syntax highlighting

### Inline Formatting

- `*text*` - Italic
- `**text**` - Bold
- `` `code` `` - Inline code

## Examples

See the [examples](./examples) directory for sample SDOC files.

## Development

```bash
# Run tests
npm test

# Run example
npm run example
```

## License

MIT
