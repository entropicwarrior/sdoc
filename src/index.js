/**
 * Main SDOC module
 */

export { SdocParser } from './parser.js';
export { SdocRenderer } from './renderer.js';

import { SdocParser } from './parser.js';
import { SdocRenderer } from './renderer.js';

/**
 * Parse and render SDOC content to HTML
 */
export function renderToHtml(sdocContent) {
  const renderer = new SdocRenderer();
  return renderer.render(sdocContent);
}

/**
 * Parse SDOC content to AST
 */
export function parse(sdocContent) {
  const parser = new SdocParser();
  return parser.parse(sdocContent);
}

export default {
  SdocParser,
  SdocRenderer,
  renderToHtml,
  parse
};
