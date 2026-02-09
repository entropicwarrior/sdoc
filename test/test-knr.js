const { parseSdoc, renderHtmlDocument } = require('../src/sdoc.js');
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; console.log('  PASS: ' + name); }
  catch(e) { fail++; console.log('  FAIL: ' + name + ' — ' + e.message); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

console.log('--- K&R Style Tests ---');

test('# Title { ... }', () => {
  const r = parseSdoc('# Title {\n  Hello\n}');
  assert(r.errors.length === 0, 'errors: ' + JSON.stringify(r.errors));
  assert(r.nodes[0].title === 'Title');
  assert(r.nodes[0].children[0].text === 'Hello');
});

test('# Title @id { ... }', () => {
  const r = parseSdoc('# Title @myid {\n  Hello\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === 'Title');
  assert(r.nodes[0].id === 'myid');
});

test('# List {[.]', () => {
  const r = parseSdoc('# Stuff {[.]\n  - A\n  - B\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === 'list');
  assert(r.nodes[0].children[0].listType === 'bullet');
  assert(r.nodes[0].children[0].items.length === 2);
});

test('# List {[#]', () => {
  const r = parseSdoc('# Stuff {[#]\n  1. A\n  2. B\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].listType === 'number');
});

test('# Table {[table]', () => {
  const r = parseSdoc('# Data {[table]\n  Name | Age\n  Alice | 30\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === 'table');
  assert(r.nodes[0].children[0].headers[0] === 'Name');
  assert(r.nodes[0].children[0].rows[0][0] === 'Alice');
});

test('- Item {', () => {
  const r = parseSdoc('{[.]\n  - Item {\n    Body text\n  }\n}');
  assert(r.errors.length === 0);
  const item = r.nodes[0].items[0];
  assert(item.title === 'Item');
  assert(item.children[0].text === 'Body text');
});

test('- Item {[.]', () => {
  const r = parseSdoc('{[.]\n  - Parent {[.]\n    - Child A\n    - Child B\n  }\n}');
  assert(r.errors.length === 0);
  const item = r.nodes[0].items[0];
  assert(item.title === 'Parent');
  assert(item.children[0].type === 'list');
  assert(item.children[0].items.length === 2);
});

test('# { empty title with K&R', () => {
  const r = parseSdoc('# {\n  Content\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === '');
  assert(r.nodes[0].children[0].text === 'Content');
});

test('K&R with trailing whitespace', () => {
  const r = parseSdoc('# Title {   \n  Content\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === 'Title');
});

test('Nested K&R scopes', () => {
  const r = parseSdoc('# Outer {\n  # Inner {\n    Deep content\n  }\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === 'Outer');
  assert(r.nodes[0].children[0].title === 'Inner');
  assert(r.nodes[0].children[0].children[0].text === 'Deep content');
});

console.log('\n--- Regression Tests ---');

test('Allman style still works', () => {
  const r = parseSdoc('# Title\n{\n  Hello\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === 'Title');
});

test('Inline blocks still work', () => {
  const r = parseSdoc('# Name\n{ John Doe }');
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].text === 'John Doe');
});

test('Empty inline block', () => {
  const r = parseSdoc('# Empty\n{ }');
  assert(r.errors.length === 0);
  assert(r.nodes[0].children.length === 0);
});

test('Allman list block', () => {
  const r = parseSdoc('# List\n{[.]\n  - A\n  - B\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].type === 'list');
});

test('Headingless scope', () => {
  const r = parseSdoc('{\n  Content\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].hasHeading === false);
});

test('Existing spec file parses cleanly', () => {
  const text = fs.readFileSync(path.join(__dirname, '..', 'spec', 'specification.sdoc'), 'utf-8');
  const r = parseSdoc(text);
  assert(r.errors.length === 0, 'spec errors: ' + JSON.stringify(r.errors));
});

test('Existing test files parse cleanly', () => {
  for (const f of ['test-inline-blocks.sdoc', 'test-edge-cases.sdoc']) {
    const fp = path.join(__dirname, f);
    const r = parseSdoc(fs.readFileSync(fp, 'utf-8'));
    assert(r.errors.length === 0, f + ' had errors');
  }
});

test('Inline block on list item (not K&R)', () => {
  const r = parseSdoc('{[.]\n  - Item { some data }\n}');
  assert(r.errors.length === 0);
});

test('Task list item with K&R', () => {
  const r = parseSdoc('{[.]\n  - [x] Done task {\n    Details here\n  }\n}');
  assert(r.errors.length === 0);
  const item = r.nodes[0].items[0];
  assert(item.task && item.task.checked === true);
  assert(item.title === 'Done task');
  assert(item.children[0].text === 'Details here');
});

test('Unchecked task with K&R', () => {
  const r = parseSdoc('{[.]\n  - [ ] Pending task {\n    Details\n  }\n}');
  assert(r.errors.length === 0);
  const item = r.nodes[0].items[0];
  assert(item.task && item.task.checked === false);
  assert(item.title === 'Pending task');
});

test('HTML rendering works for K&R', () => {
  const html = renderHtmlDocument('# Hello {\n  World\n}', 'Test');
  assert(html.includes('Hello'));
  assert(html.includes('World'));
});

test('Mixed K&R and Allman in same document', () => {
  const doc = `# Doc {
  # Section A {
    Content A
  }
  # Section B
  {
    Content B
  }
}`;
  const r = parseSdoc(doc);
  assert(r.errors.length === 0);
  assert(r.nodes[0].children[0].title === 'Section A');
  assert(r.nodes[0].children[1].title === 'Section B');
});

test('K&R with @id before list opener', () => {
  const r = parseSdoc('# Features @feat {[.]\n  - A\n  - B\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === 'Features');
  assert(r.nodes[0].id === 'feat');
  assert(r.nodes[0].children[0].type === 'list');
});

test('K&R with @id before table opener', () => {
  const r = parseSdoc('# Data @tbl {[table]\n  Name | Age\n  Alice | 30\n}');
  assert(r.errors.length === 0);
  assert(r.nodes[0].title === 'Data');
  assert(r.nodes[0].id === 'tbl');
  assert(r.nodes[0].children[0].type === 'table');
});

console.log('\n--- Results: ' + pass + ' passed, ' + fail + ' failed ---');
if (fail > 0) process.exit(1);
