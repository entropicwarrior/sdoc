/**
 * SDOC HTML Renderer
 * Renders SDOC AST to HTML
 */

import { SdocParser } from './parser.js';

export class SdocRenderer {
  constructor() {
    this.parser = new SdocParser();
    this.sectionCounters = [];
  }

  /**
   * Render SDOC content to HTML
   */
  render(content) {
    const ast = this.parser.parse(content);
    return this.renderAst(ast);
  }

  /**
   * Render AST to HTML
   */
  renderAst(ast) {
    this.sectionCounters = [];
    
    let html = '<!DOCTYPE html>\n<html lang="en">\n<head>\n';
    html += '<meta charset="UTF-8">\n';
    html += '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n';
    html += `<title>${ast.metadata.title || 'SDOC Document'}</title>\n`;
    html += this.getStyles();
    html += '</head>\n<body>\n';
    html += '<div class="sdoc-document">\n';

    // Render metadata
    if (ast.metadata.title) {
      html += `<h1 class="document-title">${this.escapeHtml(ast.metadata.title)}</h1>\n`;
    }
    if (ast.metadata.author) {
      html += `<div class="document-author">By ${this.escapeHtml(ast.metadata.author)}</div>\n`;
    }
    if (ast.metadata.version) {
      html += `<div class="document-version">Version ${this.escapeHtml(ast.metadata.version)}</div>\n`;
    }

    // Render children
    for (const child of ast.children) {
      html += this.renderBlock(child, 1);
    }

    html += '</div>\n</body>\n</html>';
    return html;
  }

  /**
   * Render a block
   */
  renderBlock(block, level = 1) {
    let html = '';

    switch (block.type) {
      case 'section':
        html += this.renderSection(block, level);
        break;
      case 'text':
        html += this.renderText(block);
        break;
      case 'list':
        html += this.renderList(block);
        break;
      case 'code':
        html += this.renderCode(block);
        break;
      default:
        html += `<!-- Unknown block type: ${block.type} -->\n`;
    }

    return html;
  }

  /**
   * Render a section with auto-numbering
   */
  renderSection(block, level) {
    // Update section counters
    while (this.sectionCounters.length < level) {
      this.sectionCounters.push(0);
    }
    while (this.sectionCounters.length > level) {
      this.sectionCounters.pop();
    }
    this.sectionCounters[level - 1]++;

    const sectionNumber = this.sectionCounters.join('.');
    const title = block.properties.title || 'Untitled Section';
    const headingLevel = Math.min(level + 1, 6); // h2 to h6

    let html = `<section id="${block.id}" class="sdoc-section level-${level}">\n`;
    html += `<h${headingLevel} class="section-title">`;
    html += `<span class="section-number">${sectionNumber}</span> `;
    html += this.escapeHtml(title);
    html += `</h${headingLevel}>\n`;

    // Render children
    for (const child of block.children) {
      html += this.renderBlock(child, level + 1);
    }

    html += '</section>\n';
    return html;
  }

  /**
   * Render a text block
   */
  renderText(block) {
    const content = this.parser.parseInline(block.content);
    return `<div id="${block.id}" class="sdoc-text">\n<p>${content}</p>\n</div>\n`;
  }

  /**
   * Render a list block
   */
  renderList(block) {
    const lines = block.content.split('\n').filter(line => line.trim());
    let html = `<div id="${block.id}" class="sdoc-list">\n<ul>\n`;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('-')) {
        const itemContent = this.parser.parseInline(trimmed.substring(1).trim());
        html += `<li>${itemContent}</li>\n`;
      }
    }

    html += '</ul>\n</div>\n';
    return html;
  }

  /**
   * Render a code block
   */
  renderCode(block) {
    const lang = block.properties.lang || 'plaintext';
    const code = this.escapeHtml(block.content);
    
    let html = `<div id="${block.id}" class="sdoc-code">\n`;
    html += `<pre><code class="language-${lang}">${code}</code></pre>\n`;
    html += '</div>\n';
    
    return html;
  }

  /**
   * Escape HTML special characters
   */
  escapeHtml(text) {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }

  /**
   * Get CSS styles for the document
   */
  getStyles() {
    return `<style>
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
  line-height: 1.6;
  color: #333;
  max-width: 900px;
  margin: 0 auto;
  padding: 20px;
  background: #f5f5f5;
}

.sdoc-document {
  background: white;
  padding: 40px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.document-title {
  color: #2c3e50;
  border-bottom: 3px solid #3498db;
  padding-bottom: 10px;
  margin-bottom: 10px;
}

.document-author,
.document-version {
  color: #7f8c8d;
  font-size: 0.9em;
  margin-bottom: 5px;
}

.sdoc-section {
  margin: 30px 0;
}

.section-title {
  color: #2c3e50;
  margin-top: 30px;
  margin-bottom: 15px;
}

.section-number {
  color: #3498db;
  font-weight: bold;
  margin-right: 5px;
}

.sdoc-text {
  margin: 15px 0;
}

.sdoc-text p {
  margin: 10px 0;
  text-align: justify;
}

.sdoc-list {
  margin: 15px 0;
}

.sdoc-list ul {
  margin: 10px 0;
  padding-left: 30px;
}

.sdoc-list li {
  margin: 5px 0;
}

.sdoc-code {
  margin: 15px 0;
}

.sdoc-code pre {
  background: #f4f4f4;
  border: 1px solid #ddd;
  border-radius: 4px;
  padding: 15px;
  overflow-x: auto;
}

.sdoc-code code {
  font-family: 'Courier New', Courier, monospace;
  font-size: 0.9em;
  color: #e74c3c;
}

em {
  font-style: italic;
}

strong {
  font-weight: bold;
}

code {
  background: #f4f4f4;
  padding: 2px 6px;
  border-radius: 3px;
  font-family: 'Courier New', Courier, monospace;
  font-size: 0.9em;
}
</style>\n`;
  }
}

export default SdocRenderer;
