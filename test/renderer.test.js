/**
 * Tests for SDOC Renderer
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { SdocRenderer } from '../src/renderer.js';

test('Renderer should render basic document', () => {
  const renderer = new SdocRenderer();
  const content = `
@document {
  title: "Test Document"
  author: "Test Author"
}
  `.trim();

  const html = renderer.render(content);
  
  assert(html.includes('<!DOCTYPE html>'));
  assert(html.includes('Test Document'));
  assert(html.includes('Test Author'));
});

test('Renderer should render sections with numbering', () => {
  const renderer = new SdocRenderer();
  const content = `
@section {
  title: "First Section"
}

@section {
  title: "Second Section"
}
  `.trim();

  const html = renderer.render(content);
  
  assert(html.includes('First Section'));
  assert(html.includes('Second Section'));
  assert(html.includes('class="section-number">1<'));
  assert(html.includes('class="section-number">2<'));
});

test('Renderer should render nested sections with hierarchical numbering', () => {
  const renderer = new SdocRenderer();
  const content = `
@section {
  title: "Parent"
  
  @section {
    title: "Child 1"
  }
  
  @section {
    title: "Child 2"
  }
}
  `.trim();

  const html = renderer.render(content);
  
  assert(html.includes('class="section-number">1<'));
  assert(html.includes('class="section-number">1.1<'));
  assert(html.includes('class="section-number">1.2<'));
});

test('Renderer should render text blocks', () => {
  const renderer = new SdocRenderer();
  const content = `
@section {
  title: "Test"
  
  @text {
    This is a paragraph.
  }
}
  `.trim();

  const html = renderer.render(content);
  
  assert(html.includes('<p>This is a paragraph.</p>'));
  assert(html.includes('class="sdoc-text"'));
});

test('Renderer should render lists', () => {
  const renderer = new SdocRenderer();
  const content = `
@section {
  title: "Test"
  
  @list {
    - Item 1
    - Item 2
  }
}
  `.trim();

  const html = renderer.render(content);
  
  assert(html.includes('<ul>'));
  assert(html.includes('<li>Item 1</li>'));
  assert(html.includes('<li>Item 2</li>'));
});

test('Renderer should render code blocks', () => {
  const renderer = new SdocRenderer();
  const content = `
@section {
  title: "Test"
  
  @code {
    lang: "javascript"
    
    console.log("test");
  }
}
  `.trim();

  const html = renderer.render(content);
  
  assert(html.includes('<pre>'));
  assert(html.includes('<code class="language-javascript">'));
  assert(html.includes('console.log'));
});

test('Renderer should handle inline formatting', () => {
  const renderer = new SdocRenderer();
  const content = `
@section {
  title: "Test"
  
  @text {
    This has *italic* and **bold** and \`code\`.
  }
}
  `.trim();

  const html = renderer.render(content);
  
  assert(html.includes('<em>italic</em>'));
  assert(html.includes('<strong>bold</strong>'));
  assert(html.includes('<code>code</code>'));
});

test('Renderer should escape HTML characters', () => {
  const renderer = new SdocRenderer();
  const content = `
@document {
  title: "Test <script>alert('xss')</script>"
}
  `.trim();

  const html = renderer.render(content);
  
  // Check that dangerous HTML is properly escaped in the content
  assert(html.includes('&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;'));
  // Make sure it's not executable (the title tag should contain escaped version)
  const titleMatch = html.match(/<h1 class="document-title">([^<]+)<\/h1>/);
  assert(titleMatch !== null);
  assert(titleMatch[1].includes('&lt;script&gt;'));
});

test('Renderer should include IDs in rendered blocks', () => {
  const renderer = new SdocRenderer();
  const content = `
@section {
  title: "Test Section"
  
  @text {
    Test text
  }
}
  `.trim();

  const html = renderer.render(content);
  
  assert(html.includes('id="section-1"'));
  assert(html.includes('id="text-1"'));
});

test('Renderer should include CSS styles', () => {
  const renderer = new SdocRenderer();
  const content = `
@document {
  title: "Test"
}
  `.trim();

  const html = renderer.render(content);
  
  assert(html.includes('<style>'));
  assert(html.includes('.sdoc-document'));
  assert(html.includes('.section-title'));
});
