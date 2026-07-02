'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { reflowItems } = require('../src/pdf/extract');

// Locks the reflow algorithm to pdf-parse's render_page behavior: same-Y items
// concatenate; a change in transform[5] inserts a newline. Item shape mirrors
// pdfjs getTextContent items (transform[5] is the baseline Y).
const item = (str, y) => ({ str, transform: [1, 0, 0, 1, 0, y] });

test('reflowItems: same Y concatenates, Y change inserts newline', () => {
  const items = [
    item('07DEC', 700), item(' ', 700), item('HI-LO', 700),
    item('03JAN', 680), item(' SALARY', 680),
  ];
  assert.equal(reflowItems(items), '07DEC HI-LO\n03JAN SALARY');
});

test('reflowItems: first item never gets a leading newline', () => {
  assert.equal(reflowItems([item('A', 500), item('B', 400)]), 'A\nB');
});

test('reflowItems: undefined str items are skipped', () => {
  const items = [item('X', 100), { transform: [1, 0, 0, 1, 0, 100] }, item('Y', 100)];
  assert.equal(reflowItems(items), 'XY');
});
