/**
 * Tests for SDOC Parser
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { SdocParser } from '../src/parser.js';

test('Parser should parse document metadata', () => {
  const parser = new SdocParser();
  const content = `
@document {
  title: "Test Document"
  author: "Test Author"
  version: "1.0"
}
  `.trim();

  const ast = parser.parse(content);
  
  assert.strictEqual(ast.type, 'document');
  assert.strictEqual(ast.metadata.title, 'Test Document');
  assert.strictEqual(ast.metadata.author, 'Test Author');
  assert.strictEqual(ast.metadata.version, '1.0');
});

test('Parser should parse sections', () => {
  const parser = new SdocParser();
  const content = `
@section {
  title: "Section 1"
}
  `.trim();

  const ast = parser.parse(content);
  
  assert.strictEqual(ast.children.length, 1);
  assert.strictEqual(ast.children[0].type, 'section');
  assert.strictEqual(ast.children[0].properties.title, 'Section 1');
  assert(ast.children[0].id.startsWith('section-'));
});

test('Parser should parse nested sections', () => {
  const parser = new SdocParser();
  const content = `
@section {
  title: "Parent Section"
  
  @section {
    title: "Child Section"
  }
}
  `.trim();

  const ast = parser.parse(content);
  
  assert.strictEqual(ast.children.length, 1);
  assert.strictEqual(ast.children[0].children.length, 1);
  assert.strictEqual(ast.children[0].children[0].type, 'section');
  assert.strictEqual(ast.children[0].children[0].properties.title, 'Child Section');
});

test('Parser should parse text blocks', () => {
  const parser = new SdocParser();
  const content = `
@section {
  title: "Test"
  
  @text {
    This is a paragraph.
  }
}
  `.trim();

  const ast = parser.parse(content);
  
  assert.strictEqual(ast.children[0].children.length, 1);
  assert.strictEqual(ast.children[0].children[0].type, 'text');
  assert.strictEqual(ast.children[0].children[0].content.trim(), 'This is a paragraph.');
});

test('Parser should parse list blocks', () => {
  const parser = new SdocParser();
  const content = `
@section {
  title: "Test"
  
  @list {
    - Item 1
    - Item 2
    - Item 3
  }
}
  `.trim();

  const ast = parser.parse(content);
  
  assert.strictEqual(ast.children[0].children.length, 1);
  assert.strictEqual(ast.children[0].children[0].type, 'list');
  assert(ast.children[0].children[0].content.includes('- Item 1'));
  assert(ast.children[0].children[0].content.includes('- Item 2'));
});

test('Parser should parse code blocks', () => {
  const parser = new SdocParser();
  const content = `
@section {
  title: "Test"
  
  @code {
    lang: "javascript"
    
    console.log("Hello");
  }
}
  `.trim();

  const ast = parser.parse(content);
  
  assert.strictEqual(ast.children[0].children.length, 1);
  assert.strictEqual(ast.children[0].children[0].type, 'code');
  assert.strictEqual(ast.children[0].children[0].properties.lang, 'javascript');
  assert(ast.children[0].children[0].content.includes('console.log'));
});

test('Parser should handle inline formatting', () => {
  const parser = new SdocParser();
  
  let result = parser.parseInline('This is *italic* text');
  assert(result.includes('<em>italic</em>'));
  
  result = parser.parseInline('This is **bold** text');
  assert(result.includes('<strong>bold</strong>'));
  
  result = parser.parseInline('This is `code` text');
  assert(result.includes('<code>code</code>'));
});

test('Parser should generate unique IDs', () => {
  const parser = new SdocParser();
  const content = `
@section {
  title: "Section 1"
}

@section {
  title: "Section 2"
}
  `.trim();

  const ast = parser.parse(content);
  
  assert.strictEqual(ast.children.length, 2);
  assert.strictEqual(ast.children[0].id, 'section-1');
  assert.strictEqual(ast.children[1].id, 'section-2');
});

test('Parser should handle multiple block types', () => {
  const parser = new SdocParser();
  const content = `
@section {
  title: "Test Section"
  
  @text {
    Some text here.
  }
  
  @list {
    - Item 1
  }
  
  @code {
    lang: "python"
    
    print("Hello")
  }
}
  `.trim();

  const ast = parser.parse(content);
  
  assert.strictEqual(ast.children[0].children.length, 3);
  assert.strictEqual(ast.children[0].children[0].type, 'text');
  assert.strictEqual(ast.children[0].children[1].type, 'list');
  assert.strictEqual(ast.children[0].children[2].type, 'code');
});
