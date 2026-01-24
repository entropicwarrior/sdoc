/**
 * SDOC Parser
 * Parses .sdoc files into an Abstract Syntax Tree (AST)
 */

export class SdocParser {
  constructor() {
    this.reset();
  }

  reset() {
    this.idCounters = {};
  }

  /**
   * Generate a unique ID for a block
   */
  generateId(blockType, title = '') {
    if (!this.idCounters[blockType]) {
      this.idCounters[blockType] = 0;
    }
    this.idCounters[blockType]++;
    
    const id = `${blockType}-${this.idCounters[blockType]}`;
    return id;
  }

  /**
   * Parse an SDOC document
   */
  parse(content) {
    this.reset();
    const lines = content.split('\n');
    const ast = {
      type: 'document',
      metadata: {},
      children: []
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i].trim();
      
      if (line.startsWith('@document')) {
        const result = this.parseBlock(lines, i, 'document');
        ast.metadata = result.block.properties;
        i = result.nextIndex;
      } else if (line.startsWith('@section')) {
        const result = this.parseBlock(lines, i, 'section');
        ast.children.push(result.block);
        i = result.nextIndex;
      } else {
        i++;
      }
    }

    return ast;
  }

  /**
   * Parse a block (section, text, list, code, etc.)
   */
  parseBlock(lines, startIndex, blockType) {
    const block = {
      type: blockType,
      id: this.generateId(blockType),
      properties: {},
      content: '',
      children: []
    };

    let i = startIndex;
    let braceCount = 0;
    let foundOpenBrace = false;
    let contentLines = [];

    // Find opening brace (might be on the same line as @blocktype or on next line)
    while (i < lines.length && !foundOpenBrace) {
      const line = lines[i].trim();
      if (line.includes('{')) {
        foundOpenBrace = true;
        braceCount = 1;
      }
      i++;
    }

    if (!foundOpenBrace) {
      return { block, nextIndex: startIndex + 1 };
    }

    // Parse block content
    while (i < lines.length && braceCount > 0) {
      const line = lines[i];
      const trimmedLine = line.trim();

      if (trimmedLine === '}') {
        braceCount--;
        if (braceCount === 0) {
          break;
        }
      } else if (trimmedLine === '{') {
        braceCount++;
      }

      // Check for properties (key: value)
      if (trimmedLine.includes(':') && !trimmedLine.startsWith('@')) {
        const colonIndex = trimmedLine.indexOf(':');
        const key = trimmedLine.substring(0, colonIndex).trim();
        let value = trimmedLine.substring(colonIndex + 1).trim();
        
        // Remove quotes if present
        if (value.startsWith('"') && value.endsWith('"')) {
          value = value.substring(1, value.length - 1);
        }
        
        block.properties[key] = value;
      }
      // Check for nested blocks
      else if (trimmedLine.startsWith('@')) {
        const nestedType = trimmedLine.substring(1).split(/\s+/)[0];
        const result = this.parseBlock(lines, i, nestedType);
        block.children.push(result.block);
        i = result.nextIndex;
        continue;
      }
      // Regular content
      else if (trimmedLine !== '' && braceCount > 0) {
        contentLines.push(line);
      }

      i++;
    }

    block.content = contentLines.join('\n').trim();

    return { block, nextIndex: i + 1 };
  }

  /**
   * Parse inline formatting (*, **, `)
   */
  parseInline(text) {
    if (!text) return text;
    
    // Handle code first to avoid conflicts
    text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
    
    // Bold
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    
    // Italic
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    
    return text;
  }
}

export default SdocParser;
