'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { yearMonthOf, yearOf, eachMonthInRange } = require('../src/date-utils');

test('yearMonthOf / yearOf: string-slice parsing (no timezone shift)', () => {
  // Jan 1 must stay in January regardless of local timezone.
  assert.deepEqual(yearMonthOf('2024-01-01'), { year: 2024, month: 1 });
  assert.equal(yearOf('2024-01-01'), 2024);
  assert.equal(yearMonthOf('garbage'), null);
  assert.equal(yearOf(''), null);
});

test('eachMonthInRange: inclusive, within a year', () => {
  assert.deepEqual(eachMonthInRange('2024-01-15', '2024-03-31'), [
    { year: 2024, month: 1 },
    { year: 2024, month: 2 },
    { year: 2024, month: 3 },
  ]);
});

test('eachMonthInRange: crosses the year boundary', () => {
  assert.deepEqual(eachMonthInRange('2020-12-05', '2021-01-05'), [
    { year: 2020, month: 12 },
    { year: 2021, month: 1 },
  ]);
});

test('eachMonthInRange: single month and inverted/invalid ranges', () => {
  assert.deepEqual(eachMonthInRange('2024-06-10', '2024-06-20'), [{ year: 2024, month: 6 }]);
  assert.deepEqual(eachMonthInRange('2024-06-01', '2024-05-01'), []); // inverted
  assert.deepEqual(eachMonthInRange('bad', '2024-05-01'), []);
});
