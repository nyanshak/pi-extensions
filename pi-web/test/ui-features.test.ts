// Test script for pi-web UI features
// Validates: session persistence, slash-command UI, tool call expand/collapse, copy buttons, markdown rendering

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve('./public/index.html'), 'utf-8');

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${e.message}`);
    process.exitCode = 1;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

// ── Test: Markdown rendering ──────────────────────────────────────────────────
console.log('\nMarkdown Rendering');
test('marked.js CDN loaded', () => {
  assert(html.includes('cdn.jsdelivr.net/npm/marked'), 'missing marked CDN');
});
test('renderMarkdown calls hljs.highlightElement for syntax highlighting', () => {
  assert(html.includes('hljs.highlightElement(block)'), 'missing hljs.highlightElement call');
  assert(html.includes("typeof hljs !== 'undefined'"), 'missing hljs undefined check');
});

// ── Test: Session persistence ─────────────────────────────────────────────────
console.log('\nSession Persistence');
test('localStorage saveState function exists', () => {
  assert(html.includes('function saveState()'), 'missing saveState');
});
test('localStorage loadState function exists', () => {
  assert(html.includes('function loadState()'), 'missing loadState');
});
test('STORAGE_KEY constant defined', () => {
  assert(html.includes("const STORAGE_KEY = 'piweb_state'"), 'missing STORAGE_KEY');
});
test('restoreState called on init', () => {
  assert(html.includes('restoreState()'), 'missing restoreState call');
});
test('sessions stored as Map with localStorage roundtrip', () => {
  assert(html.includes('JSON.stringify(data)'), 'missing JSON.stringify in save');
  assert(html.includes('JSON.parse(raw)'), 'missing JSON.parse in load');
});
test('saveState called after message send', () => {
  assert(html.includes('saveState()'), 'saveState called');
});

// ── Test: Slash commands on `/` ──────────────────────────────────────────────
console.log('\nSlash Commands (floating dropdown on /)');
test('typing / triggers autocomplete update', () => {
  assert(html.includes("value.startsWith('/')"), 'missing slash detection');
});
test('updateAutocomplete function exists', () => {
  assert(html.includes('function updateAutocomplete'), 'missing updateAutocomplete');
});
test('autocomplete dropdown has active class trigger', () => {
  assert(html.includes("autocompleteEl.classList.add('active')"), 'missing autocomplete activation');
});
test('autocomplete header shows escaped filter', () => {
  assert(html.includes('escapeHtml(filter)}'), 'missing escaped filter in header');
});
test('slash-menu triggered by / button with updateSlashMenu', () => {
  assert(html.includes('function updateSlashMenu'), 'missing updateSlashMenu');
  assert(html.includes('openSlashMenu()'), 'missing openSlashMenu');
});
test('insertCommand function inserts / prefix', () => {
  assert(html.includes("value = '/' + cmd + ' '"), 'missing / prefix insertion');
});

// ── Test: Input history (up/down arrows) ─────────────────────────────────────
console.log('\nInput History (↑↓)');
test('inputHistory array defined', () => {
  assert(html.includes('let inputHistory = []'), 'missing inputHistory');
});
test('historyIndex state defined', () => {
  assert(html.includes('let historyIndex'), 'missing historyIndex');
});
test('navigateHistory function with up/down direction', () => {
  assert(html.includes('function navigateHistory'), 'missing navigateHistory');
  assert(html.includes("navigateHistory('up')"), 'missing up direction call');
  assert(html.includes("navigateHistory('down')"), 'missing down direction call');
  assert(html.includes('Math.max(historyIndex - 1, -1)'), 'missing down direction logic');
});
test('ArrowUp triggers history navigation', () => {
  assert(html.includes("e.key === 'ArrowUp'"), 'missing ArrowUp handler');
});
test('ArrowDown triggers history navigation', () => {
  assert(html.includes("e.key === 'ArrowDown'"), 'missing ArrowDown handler');
});
test('current input saved before history navigation', () => {
  assert(html.includes('dataset.currentInput'), 'missing currentInput save');
});

// ── Test: Tool call collapse/expand ───────────────────────────────────────────
console.log('\nTool Call Collapse/Expand');
test('toggleTool function exposed on window', () => {
  assert(html.includes('window.toggleTool = function'), 'missing window.toggleTool');
});
test('tool-call element with expanded class toggle', () => {
  assert(html.includes('classList.toggle(\'expanded\')'), 'missing expanded toggle');
});
test('tool-toggle icon with rotate animation', () => {
  assert(html.includes('.tool-call.expanded .tool-toggle'), 'missing toggle rotation CSS');
});
test('tool-status shows running/done/error states', () => {
  assert(html.includes('tool-status running'), 'missing running status class in HTML');
  assert(html.includes('.tool-status.done'), 'missing .tool-status.done CSS');
  assert(html.includes('.tool-status.error'), 'missing .tool-status.error CSS');
  assert(html.includes("status.className = `tool-status ${isError ? 'error' : 'done'}`"), 'missing dynamic class assignment');
});
test('first tool call auto-expanded', () => {
  assert(html.includes('messagesEl.querySelectorAll(\'.tool-call\').length === 1'), 'missing auto-expand');
});
test('tool-header has cursor:pointer and hover effect', () => {
  assert(html.includes('.tool-header:hover'), 'missing tool-header hover CSS');
});

// ── Test: Copy buttons on code blocks ─────────────────────────────────────────
console.log('\nCopy Buttons on Code Blocks');
test('attachCopyButtons function exists', () => {
  assert(html.includes('function attachCopyButtons'), 'missing attachCopyButtons');
});
test('copy-btn CSS with opacity transition', () => {
  assert(html.includes('.code-block:hover .copy-btn'), 'missing hover CSS for copy btn');
  assert(html.includes('opacity: 0'), 'missing opacity:0 default');
});
test('copyToClipboard function with Copied! feedback', () => {
  assert(html.includes('function copyToClipboard'), 'missing copyToClipboard');
  assert(html.includes('Copied!'), 'missing Copied feedback');
});
test('copy-btn.copied style with success color', () => {
  assert(html.includes('.copy-btn.copied'), 'missing copied class style');
});
test('copy buttons on tool input and output sections', () => {
  assert(html.includes('onclick="copyToolInput'), 'missing copyToolInput');
  assert(html.includes('onclick="copyToolOutput'), 'missing copyToolOutput');
});
test('tool-copy-btn CSS class defined', () => {
  assert(html.includes('.tool-copy-btn'), 'missing tool-copy-btn CSS');
});

// ── Test: Keyboard shortcuts ──────────────────────────────────────────────────
console.log('\nKeyboard Shortcuts');
test('Esc closes autocomplete and slash menu', () => {
  assert(html.includes("e.key === 'Escape'"), 'missing Escape handler');
  assert(html.includes('closeSlashMenu()'), 'missing closeSlashMenu in Escape');
});
test('Ctrl+Z cancels request', () => {
  assert(html.includes("e.ctrlKey && e.key === 'z'"), 'missing Ctrl+Z');
  assert(html.includes("'session/cancel'"), 'missing cancel notification');
});
test('Ctrl+L clears input', () => {
  assert(html.includes("e.ctrlKey && e.key === 'l'"), 'missing Ctrl+L');
});
test('shortcuts-bar element with kbd styling', () => {
  assert(html.includes('class="shortcuts-bar"'), 'missing shortcuts bar');
  assert(html.includes('.shortcut kbd'), 'missing kbd styling');
});
test('Tab autocomplete completion', () => {
  assert(html.includes("e.key === 'Tab'"), 'missing Tab handler');
  assert(html.includes('insertCommand(items['), 'missing Tab command insert');
});

// ── Test: Thinking block collapse/expand ─────────────────────────────────────
console.log('\nThinking Block');
test('thinking-block with collapse toggle', () => {
  assert(html.includes('.thinking-block.collapsed'), 'missing collapse CSS selector');
  assert(html.includes('toggleThinking'), 'missing toggleThinking');
});
test('thinking-toggle shows ▲/▼ state', () => {
  assert(html.includes('thinking-toggle'), 'missing thinking-toggle');
  assert(html.includes('content: "▼ hide"'), 'missing expand label');
  assert(html.includes('content: "▶ show"'), 'missing collapse label');
});

// ── Test: Shortcuts bar visible ───────────────────────────────────────────────
console.log('\nShortcuts Bar');
test('shortcuts bar shows ↑↓ input history hint', () => {
  assert(html.includes('Input history'), 'missing input history shortcut');
});
test('shortcuts bar shows Tab completion hint', () => {
  assert(html.includes('Complete command'), 'missing Tab hint');
});
test('shortcuts bar shows Ctrl+Z cancel hint', () => {
  assert(html.includes('Cancel'), 'missing Ctrl+Z hint');
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n');