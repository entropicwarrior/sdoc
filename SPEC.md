# SDOC Format Specification

## Overview

SDOC (Smart Documentation) is a modern documentation format designed to be both human-readable and machine-friendly. Unlike traditional markdown, SDOC provides explicit scoping, automatic numbering, and unique IDs for all entities.

## File Extension

`.sdoc`

## Key Features

1. **Explicit Scopes**: All content blocks are explicitly scoped using delimiters
2. **Automatic Numbering**: Sections and items are automatically numbered
3. **Unique IDs**: Every entity gets a unique identifier for referencing
4. **Machine-Ready**: Structured format that's easy to parse

## Syntax

### Document Structure

```sdoc
@document {
  title: "Document Title"
  author: "Author Name"
  version: "1.0"
}

@section {
  title: "Section Title"
  
  @text {
    This is a paragraph of text.
  }
  
  @list {
    - First item
    - Second item
    - Third item
  }
}
```

### Block Types

#### Document Block
Defines document metadata. Should appear at the beginning of the file.

```sdoc
@document {
  title: "My Document"
  author: "John Doe"
  version: "1.0"
}
```

#### Section Block
Creates a numbered section. Sections can be nested for subsections.

```sdoc
@section {
  title: "Main Section"
  
  @section {
    title: "Subsection"
  }
}
```

#### Text Block
Contains plain text content. Supports inline formatting.

```sdoc
@text {
  This is a paragraph with *emphasis* and **strong** text.
}
```

#### List Block
Creates an automatically numbered or bulleted list.

```sdoc
@list {
  - Item one
  - Item two
  - Item three
}
```

#### Code Block
Contains code with syntax highlighting.

```sdoc
@code {
  lang: "javascript"
  
  function hello() {
    console.log("Hello, World!");
  }
}
```

### Inline Formatting

- `*text*` - Italic/emphasis
- `**text**` - Bold/strong
- `` `code` `` - Inline code

### Auto-Generated IDs

Each block automatically receives a unique ID based on:
1. Block type
2. Position in document
3. Content hash (for stability)

Example: `section-1`, `section-1-1`, `text-1`, `list-2`

### Auto-Numbering

Sections are automatically numbered (1, 1.1, 1.2, 2, 2.1, etc.)
List items are automatically numbered or bulleted based on context.

## Example Document

```sdoc
@document {
  title: "Getting Started with SDOC"
  author: "Documentation Team"
  version: "1.0"
}

@section {
  title: "Introduction"
  
  @text {
    SDOC is a modern documentation format designed for both humans and machines.
  }
  
  @list {
    - Easy to read
    - Easy to parse
    - Automatically numbered
  }
}

@section {
  title: "Features"
  
  @section {
    title: "Explicit Scoping"
    
    @text {
      All content is explicitly scoped within blocks.
    }
  }
  
  @section {
    title: "Auto Numbering"
    
    @text {
      Sections and lists are numbered automatically.
    }
  }
}
```

## Rendering

SDOC files can be rendered to:
- HTML (for browsers)
- PDF (for printing)
- JSON (for programmatic access)
- Markdown (for compatibility)
