import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createAuth } from '../agent/dist/auth.js';

test('a server without a passphrase lets every request through', () => {
  const auth = createAuth('');
  assert.equal(auth.required, false);
  assert.equal(auth.verify({}), true);
  assert.equal(auth.signIn('anything').ok, true);
});

test('a wrong passphrase is refused', () => {
  const auth = createAuth('correct-horse');
  const result = auth.signIn('wrong');
  assert.equal(result.ok, false);
  assert.equal(result.token, undefined);
});

test('the right passphrase hands out a session', () => {
  const auth = createAuth('correct-horse');
  const result = auth.signIn('correct-horse');
  assert.equal(result.ok, true);
  assert.equal(typeof result.token, 'string');
  assert.equal(auth.verify({ cookie: 'alma_session=' + result.token }), true);
  assert.equal(auth.verify({ authorization: 'Bearer ' + result.token }), true);
});

test('a request without a session is refused', () => {
  const auth = createAuth('correct-horse');
  assert.equal(auth.verify({}), false);
  assert.equal(auth.verify({ cookie: 'alma_session=made-up' }), false);
});

test('signing out ends the session', () => {
  const auth = createAuth('correct-horse');
  const token = auth.signIn('correct-horse').token;
  assert.equal(auth.verify({ cookie: 'alma_session=' + token }), true);
  auth.signOut({ cookie: 'alma_session=' + token });
  assert.equal(auth.verify({ cookie: 'alma_session=' + token }), false);
});
