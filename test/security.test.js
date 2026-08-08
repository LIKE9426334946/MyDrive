'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SESSION_TTL_MS,
  constantTimeEqual,
  createSessionToken,
  parseCookies,
  verifySessionToken
} = require('../backend/security');

const secret = 'test-secret-that-is-longer-than-thirty-two-characters';

test('constantTimeEqual compares credentials without coercion surprises', () => {
  assert.equal(constantTimeEqual('noart', 'noart'), true);
  assert.equal(constantTimeEqual('noart', 'Noart'), false);
  assert.equal(constantTimeEqual('short', 'much-longer'), false);
});

test('session token is valid for 30 days and then expires', () => {
  const now = Date.UTC(2026, 7, 8);
  const token = createSessionToken('noart', secret, now);
  assert.equal(verifySessionToken(token, secret, now + SESSION_TTL_MS - 1).username, 'noart');
  assert.equal(verifySessionToken(token, secret, now + SESSION_TTL_MS), null);
});

test('tampered session token is rejected', () => {
  const token = createSessionToken('noart', secret);
  assert.equal(verifySessionToken(`${token}x`, secret), null);
  assert.equal(verifySessionToken(token, `${secret}x`), null);
});

test('cookie parser handles encoded values', () => {
  assert.deepEqual(parseCookies('first=hello%20world; mydrive_session=abc.def'), {
    first: 'hello world',
    mydrive_session: 'abc.def'
  });
});
