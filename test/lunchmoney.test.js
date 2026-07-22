'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');

const { describeLmFailure } = require('../src/lunchmoney');

// describeLmFailure is the single point that turns a raw LunchMoney API
// failure into an actionable hint — every lmRequest() throw site appends it,
// so every consumer (IPC handlers, error banners, toasts) gets the same
// useful context automatically. See CHANGELOG: the $0 transaction views were
// caused by exactly this class of failure going unclassified and silently
// swallowed into fake empty data.

test('describeLmFailure: 401/403 point at reconnecting the API key', () => {
  assert.match(describeLmFailure({ status: 401 }), /reconnect it in Settings/i);
  assert.match(describeLmFailure({ status: 403 }), /reconnect it in Settings/i);
});

test('describeLmFailure: 429 points at rate limiting', () => {
  assert.match(describeLmFailure({ status: 429 }), /rate-limiting/i);
});

test('describeLmFailure: 5xx points at a temporary server error', () => {
  assert.match(describeLmFailure({ status: 500 }), /server/i);
  assert.match(describeLmFailure({ status: 503 }), /server/i);
});

test('describeLmFailure: node network error codes point at a network problem', () => {
  assert.match(describeLmFailure({ code: 'ECONNRESET', message: 'socket hang up' }), /network problem/i);
  assert.match(describeLmFailure({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' }), /network problem/i);
});

test('describeLmFailure: "Premature close" body-stream errors point at a network problem', () => {
  // The bug this whole mechanism was built to catch: a response whose BODY
  // stream closes mid-read, well after headers arrived successfully.
  assert.match(describeLmFailure({ message: 'Premature close' }), /network problem/i);
  assert.match(describeLmFailure({ message: 'LunchMoney response body could not be read: Premature close' }), /network problem/i);
});

test('describeLmFailure: unexpected response shape points at a temporary issue, not user data', () => {
  assert.match(
    describeLmFailure({ status: 200, message: 'LunchMoney returned a non-JSON response for GET /transactions' }),
    /unexpected response/i
  );
  assert.match(
    describeLmFailure({ status: 200, message: 'Unexpected LunchMoney response for GET /transactions: no "transactions" array in body' }),
    /unexpected response/i
  );
});

test('describeLmFailure: an ordinary/unrecognized error gets no hint (null)', () => {
  assert.equal(describeLmFailure({ status: 400, message: 'bad request' }), null);
  assert.equal(describeLmFailure(null), null);
});
