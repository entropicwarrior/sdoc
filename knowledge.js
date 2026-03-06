const path = require('path');

// Knowledge files shipped with this package for consumption by MCP servers
// and other knowledge infrastructure. Each entry has a cache key and absolute path.
module.exports.knowledgeFiles = [
  { key: 'specification.sdoc', path: path.join(__dirname, 'lexica', 'specification.sdoc') },
  { key: 'sdoc-authoring.sdoc', path: path.join(__dirname, 'docs', 'reference', 'sdoc-authoring.sdoc') },
  { key: 'slide-authoring.sdoc', path: path.join(__dirname, 'docs', 'reference', 'slide-authoring.sdoc') },
];

// Backward compat — prefer knowledgeFiles for explicit file enumeration
module.exports.knowledgeDir = path.join(__dirname, 'lexica');
