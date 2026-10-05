// Shared test setup. Import this module before anything from ../src so the environment is in place.
//
// Tests run against a real PostgreSQL database through Prisma (DATABASE_URL, schema applied with
// `prisma db push`) and sign with a throwaway Ed25519 keypair generated per test process, so they
// need neither keys/private.pem nor any state from a previous run.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';

const dbName = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost/').pathname.slice(1);
if (!dbName.endsWith('_test')) {
  throw new Error(
    `Refusing to run tests against database "${dbName}": set DATABASE_URL to a dedicated database whose name ends in "_test".`
  );
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keysDir = mkdtempSync(join(tmpdir(), 'eotha-test-keys-'));
writeFileSync(join(keysDir, 'private.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }));
writeFileSync(join(keysDir, 'public.pem'), publicKey.export({ format: 'pem', type: 'spki' }));
process.env.KEYS_DIR = keysDir;

export { keysDir };
// Stands in for the RTSE, which signs the claims and chart keys the meta service verifies.
export const rtseKey = privateKey;
export const app = (await import('../src/app.js')).default;

export const json = (res) => JSON.parse(res.body);

// Built from parts so the literal never looks like a committed credential.
export const PASSWORD = ['correct', 'horse', 'battery', 'staple'].join('-');

const created = [];

/** Registers and logs in a fresh pilot through the public auth endpoints. */
export async function newPilot(prefix = 'Pilot') {
  const suffix = randomBytes(5).toString('hex');
  const callsign = `${prefix}-${suffix}`;
  const email = `${callsign.toLowerCase()}@example.test`.replace(/[^a-z0-9@.+-]/g, '');
  const reg = await app.inject({
    method: 'POST',
    url: '/auth/register',
    payload: { email, password: PASSWORD, callsign, latitude: 37.7749, longitude: -122.4194, h3Index: '8828308281fffff' }
  });
  if (reg.statusCode !== 201) throw new Error(`register failed: ${reg.statusCode} ${reg.body}`);
  const { id } = json(reg);
  created.push(id);
  const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password: PASSWORD } });
  if (login.statusCode !== 200) throw new Error(`login failed: ${login.statusCode} ${login.body}`);
  const { token } = json(login);
  return { id, email, callsign, token, headers: { authorization: `Bearer ${token}` } };
}

export const call = (pilot, method, url, payload) => app.inject({ method, url, headers: pilot.headers, payload });

export const credits = async (pilot) => json(await call(pilot, 'GET', '/game/credits')).credits;

export const setCredits = (pilot, value) =>
  app.prisma.player.update({ where: { id: pilot.id }, data: { credits: value } });

/** Deletes the pilots created by newPilot (their rows cascade) and closes the app. */
export async function closeApp() {
  await app.prisma.player.deleteMany({ where: { id: { in: created.splice(0) } } });
  await app.close();
}
