#!/usr/bin/env node

/**
 * SDOC CLI Tool
 * Converts .sdoc files to HTML
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, basename } from 'path';
import { SdocRenderer } from './renderer.js';

function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('SDOC - Smart Documentation');
    console.log('');
    console.log('Usage: sdoc <input.sdoc> [output.html]');
    console.log('');
    console.log('Options:');
    console.log('  input.sdoc   - Input SDOC file');
    console.log('  output.html  - Output HTML file (optional, defaults to input name with .html extension)');
    console.log('');
    console.log('Example:');
    console.log('  sdoc document.sdoc');
    console.log('  sdoc document.sdoc output.html');
    process.exit(0);
  }

  const inputFile = resolve(args[0]);
  let outputFile;

  if (args.length > 1) {
    outputFile = resolve(args[1]);
  } else {
    const inputBase = basename(inputFile, '.sdoc');
    outputFile = resolve(`${inputBase}.html`);
  }

  try {
    // Read input file
    console.log(`Reading: ${inputFile}`);
    const content = readFileSync(inputFile, 'utf-8');

    // Render to HTML
    console.log('Rendering to HTML...');
    const renderer = new SdocRenderer();
    const html = renderer.render(content);

    // Write output file
    console.log(`Writing: ${outputFile}`);
    writeFileSync(outputFile, html, 'utf-8');

    console.log('✓ Done!');
    console.log(`\nOpen ${outputFile} in a browser to view the result.`);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

main();
