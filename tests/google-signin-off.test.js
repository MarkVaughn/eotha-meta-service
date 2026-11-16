import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { app, closeApp } from './helpers.js';

before(async () => { await app.ready(); });
after(async () => { await closeApp(); });

// No GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET here: the provider is off and its routes do not exist.
test('without Google credentials the Google routes are not registered', async () => {
  assert.equal(app.googleSignIn, false);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/google/start', payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: 'POST', url: '/auth/google/exchange', payload: { code: 'x' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/auth/callback/google?code=x&state=y' })).statusCode, 404);
  const context = await app.betterAuth.$context;
  assert.equal(context.socialProviders.length, 0);
});
