/**
 * Integration tests for SDOC
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync, writeFileSync, unlinkSync } from 'fs';
import { execSync } from 'child_process';
import { renderToHtml, parse } from '../src/index.js';

test('Integration: parse and render complete example', () => {
  const sdocContent = readFileSync('./examples/basic.sdoc', 'utf-8');
  
  // Parse
  const ast = parse(sdocContent);
  assert(ast.type === 'document');
  assert(ast.metadata.title === 'Getting Started with SDOC');
  assert(ast.children.length > 0);
  
  // Render
  const html = renderToHtml(sdocContent);
  assert(html.includes('<!DOCTYPE html>'));
  assert(html.includes('Getting Started with SDOC'));
  assert(html.includes('class="section-number">1<'));
  assert(html.includes('class="section-number">2<'));
});

test('Integration: CLI produces valid HTML', () => {
  const testInput = './examples/quick-reference.sdoc';
  const testOutput = '/tmp/test-output.html';
  
  try {
    // Run CLI
    execSync(`node src/cli.js ${testInput} ${testOutput}`, {
      cwd: process.cwd(),
      encoding: 'utf-8'
    });
    
    // Verify output exists and is valid
    const html = readFileSync(testOutput, 'utf-8');
    assert(html.includes('<!DOCTYPE html>'));
    assert(html.includes('SDOC Quick Reference'));
    assert(html.includes('class="sdoc-document"'));
    
    // Clean up
    unlinkSync(testOutput);
  } catch (error) {
    assert.fail(`CLI test failed: ${error.message}`);
  }
});

test('Integration: handles nested sections correctly', () => {
  const content = `
@document {
  title: "Test"
}

@section {
  title: "Parent"
  
  @section {
    title: "Child 1"
    
    @section {
      title: "Grandchild"
    }
  }
  
  @section {
    title: "Child 2"
  }
}

@section {
  title: "Another Parent"
}
  `.trim();
  
  const html = renderToHtml(content);
  
  // Check numbering
  assert(html.includes('class="section-number">1<'));
  assert(html.includes('class="section-number">1.1<'));
  assert(html.includes('class="section-number">1.1.1<'));
  assert(html.includes('class="section-number">1.2<'));
  assert(html.includes('class="section-number">2<'));
});

test('Integration: unique IDs are generated correctly', () => {
  const content = `
@document {
  title: "Test"
}

@section {
  title: "Section 1"
  
  @text {
    First text
  }
  
  @text {
    Second text
  }
}
  `.trim();
  
  const html = renderToHtml(content);
  
  // Check for unique IDs
  assert(html.includes('id="section-1"'));
  assert(html.includes('id="text-1"'));
  assert(html.includes('id="text-2"'));
});

test('Integration: handles all block types', () => {
  const content = `
@document {
  title: "All Blocks Test"
}

@section {
  title: "Test Section"
  
  @text {
    Some text with *formatting*
  }
  
  @list {
    - Item 1
    - Item 2
  }
  
  @code {
    lang: "javascript"
    
    console.log("test");
  }
}
  `.trim();
  
  const html = renderToHtml(content);
  
  assert(html.includes('class="sdoc-text"'));
  assert(html.includes('class="sdoc-list"'));
  assert(html.includes('class="sdoc-code"'));
  assert(html.includes('language-javascript'));
});
