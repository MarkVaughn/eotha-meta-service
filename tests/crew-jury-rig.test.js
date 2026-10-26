import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { addCrew, app, call, closeApp, credits, dockedReceipt, json, newPilot, setCredits } from './helpers.js';
import { computeShipAttributes, defaultComponents, hullBudget, totalSubsystemPoints } from '../src/config/components.js';
import { ENGINEER_JURY_RIG_TYPES, engineerJuryRigSlots } from '../src/config/crew.js';

before(async () => { await app.ready(); });
after(closeApp);
const NEUTRAL = 'Q08';
const engineer = (extra = {}) => ({ crewClass: 'ENGINEER', rank: 'MASTER', morale: 75, status: 'ACTIVE', quirkId: NEUTRAL, juryRigComponentTypes: [], ...extra });
const attributes = (components, crew) => computeShipAttributes(components, 0, [], [crew]);
const row = (id) => app.prisma.crewMember.findUnique({ where: { id } });
const shipOf = (pilot) => app.prisma.spaceship.findFirst({ where: { playerId: pilot.id, active: true } });
const loadout = async (pilot) => json(await call(pilot, 'GET', '/ship/loadout'));
async function setup(rank = 'MASTER', extra = {}) {
  const pilot = await newPilot('Overdrive');
  const crew = await addCrew(pilot, { ...engineer({ rank }), ...extra });
  await setCredits(pilot, 1000);
  return { pilot, crew };
}
const configure = (p, crew, componentTypes, extra = {}) => call(p, 'POST', '/game/crew/jury-rig', {
  crewId: crew.id, componentTypes, dockedReceipt: dockedReceipt(p), ...extra
});
async function setTier(p, type, tier) {
  const ship = await shipOf(p);
  return app.prisma.shipComponentRecord.update({ where: { spaceshipId_type: { spaceshipId: ship.id, type } }, data: { tier } });
}

describe('Engineer effective operation (pure attributes)', () => {
  test('eligible types and rank slots are exactly the final captain rule', () => {
    assert.deepEqual(ENGINEER_JURY_RIG_TYPES, ['ENGINES', 'ENERGY', 'RADAR', 'SHIELDS']);
    assert.deepEqual(['NOVICE', 'ADEPT', 'MASTER'].map((rank) => engineerJuryRigSlots(engineer({ rank }))), [0, 1, 2]);
    assert.equal(engineerJuryRigSlots({ crewClass: 'PILOT', rank: 'MASTER' }), 0);
  });
  test('each installed selected eligible type operates exactly one tier higher, with no stored tier/point change', () => {
    for (const type of ENGINEER_JURY_RIG_TYPES) {
      const components = defaultComponents().map((c) => ({ ...c, ...(c.type === 'SHIELDS' && { tier: 1 }) }));
      const before = structuredClone(components);
      const selected = attributes(components, engineer({ juryRigComponentTypes: [type] }));
      const effective = components.map((c) => c.type === type ? { ...c, tier: 2 } : c);
      assert.deepEqual(selected, attributes(effective, engineer()));
      assert.deepEqual(components, before);
      assert.equal(totalSubsystemPoints(components), 7);
      if (type === 'ENGINES') assert.equal(selected.max_speed_mps, 40);
      if (type === 'ENERGY') assert.equal(selected.energy_capacity, 200);
      if (type === 'RADAR') assert.equal(selected.radar_range_m, 1000);
      if (type === 'SHIELDS') assert.equal(selected.max_shield_hp, 120);
    }
  });
  test('Novice gives zero selections, Adept one and Master two; no general hull-budget bonus', () => {
    const components = defaultComponents();
    const selected = ['ENGINES', 'RADAR'];
    assert.equal(attributes(components, engineer({ rank: 'NOVICE', juryRigComponentTypes: selected })).max_speed_mps, 20);
    const adept = attributes(components, engineer({ rank: 'ADEPT', juryRigComponentTypes: selected }));
    assert.deepEqual([adept.max_speed_mps, adept.radar_range_m], [40, 500]);
    const master = attributes(components, engineer({ juryRigComponentTypes: selected }));
    assert.deepEqual([master.max_speed_mps, master.radar_range_m], [40, 1000]);
    for (const rank of ['NOVICE', 'ADEPT', 'MASTER']) assert.equal(hullBudget(1, [], [engineer({ rank })]), 6);
  });
  test('T0 never materializes equipment, T4 becomes T5, and T5 never becomes T6', () => {
    const base = defaultComponents();
    assert.equal(attributes(base, engineer({ juryRigComponentTypes: ['SHIELDS'] })).max_shield_hp, 0);
    for (const tier of [4, 5]) {
      const components = base.map((c) => c.type === 'ENGINES' ? { ...c, tier } : c);
      assert.equal(attributes(components, engineer({ juryRigComponentTypes: ['ENGINES'] })).max_speed_mps, 343);
    }
  });
  test('excluded types never gain operation tiers, even from tampered stored selections', () => {
    const components = defaultComponents();
    for (const type of ['HULL', 'LIFE_SUPPORT', 'CARGO', 'SENSORS', 'WEAPONS', 'STEALTH', 'COMMS']) {
      assert.deepEqual(attributes(components, engineer({ juryRigComponentTypes: [type] })), attributes(components, engineer()));
    }
  });
  test('morale 49 or standby disables immediately without clearing selections; 50 enables exactly one tier', () => {
    const components = defaultComponents();
    for (const extra of [{ morale: 49 }, { morale: 0 }, { status: 'STANDBY' }]) {
      const member = engineer({ ...extra, juryRigComponentTypes: ['RADAR'] });
      assert.deepEqual(attributes(components, member), attributes(components, { ...member, juryRigComponentTypes: [] }));
      assert.deepEqual(member.juryRigComponentTypes, ['RADAR']);
    }
    assert.equal(attributes(components, engineer({ morale: 50, juryRigComponentTypes: ['RADAR'] })).radar_range_m, 1000);
    assert.equal(attributes(components, engineer({ morale: 90, juryRigComponentTypes: ['RADAR'] })).radar_range_m, 1000);
  });
});

describe('POST /game/crew/jury-rig', () => {
  test('requires signed, fresh, owned docking proof and matching optional station; refused requests have no effects', async () => {
    const { pilot, crew } = await setup();
    const request = { crewId: crew.id, componentTypes: ['RADAR'] };
    assert.equal((await call(pilot, 'POST', '/game/crew/jury-rig', request)).statusCode, 403);
    const proof = dockedReceipt(pilot);
    for (const extra of [
      { dockedReceipt: { ...proof, dockedAtMs: 0 } },
      { dockedReceipt: dockedReceipt('other-pilot') },
      { dockedReceipt: dockedReceipt(pilot, { dockedAtMs: 0, issuedAtMs: Date.now() - 120_000 }) },
      { stationId: '00000000-0000-4000-8000-000000000000', dockedReceipt: proof }
    ]) {
      const res = await call(pilot, 'POST', '/game/crew/jury-rig', { ...request, ...extra });
      assert.equal(res.statusCode, 403, res.body);
    }
    assert.deepEqual((await row(crew.id)).juryRigComponentTypes, []);
    assert.equal((await shipOf(pilot)).lastCrewDockedAtMs, null);
    assert.equal(await credits(pilot), 1000);
  });
  test('rank slot limits, unique types, eligible types and owner/active Engineer identity are enforced', async () => {
    for (const [rank, types, status] of [
      ['NOVICE', ['RADAR'], 409], ['NOVICE', [], 200],
      ['ADEPT', ['ENGINES', 'RADAR'], 409], ['ADEPT', ['RADAR'], 200],
      ['MASTER', ['ENGINES', 'RADAR'], 200]
    ]) {
      const { pilot, crew } = await setup(rank);
      const res = await configure(pilot, crew, types);
      assert.equal(res.statusCode, status, res.body);
    }
    const { pilot, crew } = await setup();
    for (const types of [['RADAR', 'RADAR'], ['HULL'], ['LIFE_SUPPORT'], ['CARGO'], ['ENGINES', 'RADAR', 'ENERGY']]) {
      assert.equal((await configure(pilot, crew, types)).statusCode, 400);
    }
    const other = await newPilot('OtherOverdrive');
    assert.equal((await configure(other, crew, ['RADAR'])).statusCode, 404);
    const pilotCrew = await addCrew(pilot, { crewClass: 'PILOT' });
    assert.equal(json(await configure(pilot, pilotCrew, ['RADAR'])).error, 'crew_not_engineer');
    const standby = await addCrew(pilot, { ...engineer(), status: 'STANDBY', spaceshipId: null });
    assert.equal(json(await configure(pilot, standby, ['RADAR'])).error, 'crew_not_active');
  });
  test('T0 and missing components are rejected with COMPONENT_NOT_INSTALLED; T5 is rejected as pointless', async () => {
    const { pilot, crew } = await setup();
    const before = await loadout(pilot);
    const zero = await configure(pilot, crew, ['SHIELDS']);
    assert.equal(zero.statusCode, 409, zero.body);
    assert.equal(json(zero).error, 'COMPONENT_NOT_INSTALLED');
    const ship = await shipOf(pilot);
    await app.prisma.shipComponentRecord.delete({ where: { spaceshipId_type: { spaceshipId: ship.id, type: 'SHIELDS' } } });
    assert.equal(json(await configure(pilot, crew, ['SHIELDS'])).error, 'COMPONENT_NOT_INSTALLED');
    await setTier(pilot, 'RADAR', 5);
    const maximum = await configure(pilot, crew, ['RADAR']);
    assert.equal(maximum.statusCode, 409, maximum.body);
    assert.equal(json(maximum).error, 'jury_rig_already_max_tier');
    assert.deepEqual((await row(crew.id)).juryRigComponentTypes, []);
    assert.equal(await credits(pilot), 1000);
    assert.equal(before.components.find((c) => c.type === 'SHIELDS').tier, 0);
  });
  test('configuration signs effective attributes but preserves stored component tiers, points, health and credits', async () => {
    const { pilot, crew } = await setup();
    const before = await loadout(pilot);
    const res = await configure(pilot, crew, ['ENGINES', 'RADAR']);
    assert.equal(res.statusCode, 200, res.body);
    const body = json(res);
    assert.deepEqual(body.crew.juryRig, { selectedComponentTypes: ['ENGINES', 'RADAR'], slots: 2, active: true });
    assert.deepEqual([body.ship_attributes.max_speed_mps, body.ship_attributes.radar_range_m], [40, 1000]);
    assert.deepEqual(app.jwt.verify(body.token).ship_attributes, body.ship_attributes);
    const after = await loadout(pilot);
    assert.deepEqual(after.components, before.components);
    assert.equal(totalSubsystemPoints(after.components), 6);
    assert.equal(await credits(pilot), 1000);
    assert.deepEqual((await row(crew.id)).juryRigComponentTypes, ['ENGINES', 'RADAR']);
    const clear = await configure(pilot, crew, []);
    assert.equal(clear.statusCode, 200, clear.body);
    assert.deepEqual([json(clear).ship_attributes.max_speed_mps, json(clear).ship_attributes.radar_range_m], [20, 500]);
    assert.deepEqual((await row(crew.id)).juryRigComponentTypes, []);
  });
  test('every installed eligible category can be configured through the route', async () => {
    const { pilot, crew } = await setup();
    await setTier(pilot, 'SHIELDS', 1);
    const cases = [['ENGINES', 'max_speed_mps', 40], ['ENERGY', 'energy_capacity', 200], ['RADAR', 'radar_range_m', 1000], ['SHIELDS', 'max_shield_hp', 120]];
    for (const [type, attr, value] of cases) {
      const res = await configure(pilot, crew, [type]);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(json(res).ship_attributes[attr], value);
    }
  });
  test('morale loss through a deferred payout drops effective operation immediately while retaining selections', async () => {
    const { pilot, crew } = await setup('ADEPT', { morale: 60 });
    assert.equal((await configure(pilot, crew, ['RADAR'])).statusCode, 200);
    // Configuration consumes shore leave; isolate the next payout's 60 -> 35 transition.
    await app.prisma.crewMember.update({ where: { id: crew.id }, data: { morale: 60 } });
    const planetId = `overdrive-${crew.id}`;
    await app.prisma.planetChart.create({ data: { playerId: pilot.id, planetId, systemH3: '8828308283fffff', completedAtMs: BigInt(Date.now()), signature: 'x', surveyJson: {} } });
    const res = await call(pilot, 'POST', '/game/charts/sell', { planetId, stationId: 'station-overdrive', deferCrewPay: true });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(app.jwt.verify(json(res).token).ship_attributes.radar_range_m, 500);
    assert.equal((await row(crew.id)).morale, 35);
    assert.deepEqual((await row(crew.id)).juryRigComponentTypes, ['RADAR']);
    assert.equal((await loadout(pilot)).components.find((c) => c.type === 'RADAR').tier, 1);
    assert.equal(await credits(pilot), 1500);
  });
  test('standby disables and activation restores selected operation without rewriting stored components', async () => {
    const { pilot, crew } = await setup('ADEPT');
    await configure(pilot, crew, ['RADAR']);
    const before = await loadout(pilot);
    const off = await call(pilot, 'POST', '/game/crew/standby', { crewId: crew.id, dockedReceipt: dockedReceipt(pilot) });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal(json(off).ship_attributes.radar_range_m, 500);
    assert.deepEqual((await row(crew.id)).juryRigComponentTypes, ['RADAR']);
    const on = await call(pilot, 'POST', '/game/crew/activate', { crewId: crew.id, dockedReceipt: dockedReceipt(pilot) });
    assert.equal(on.statusCode, 200, on.body);
    assert.equal(json(on).ship_attributes.radar_range_m, 1000);
    assert.deepEqual((await loadout(pilot)).components, before.components);
    assert.equal(await credits(pilot), 950); // Only the existing standby fee, no overdrive refund/charge.
  });
  test('overdrive cannot buy physical upgrades outside the hull budget or alter normal upgrade prices', async () => {
    const { pilot, crew } = await setup('ADEPT');
    await setCredits(pilot, 10_000);
    await configure(pilot, crew, ['RADAR']);
    const upgrade = (componentType, targetTier) => call(pilot, 'POST', '/ship/upgrade', { componentType, targetTier, dockedReceipt: dockedReceipt(pilot) });
    assert.equal((await upgrade('RADAR', 2)).statusCode, 400); // Actual stored cost would be 7 > base budget 6.
    const hull = await upgrade('HULL', 2);
    assert.equal(hull.statusCode, 200, hull.body);
    assert.equal(json(hull).cost, 750);
    const radar = await upgrade('RADAR', 2);
    assert.equal(radar.statusCode, 200, radar.body);
    assert.equal(json(radar).cost, 750); // Stored 1 -> 2, never effective 2 -> 3 pricing.
    assert.equal(json(radar).components.find((c) => c.type === 'RADAR').tier, 2);
    assert.equal(json(radar).ship_attributes.radar_range_m, 1800);
    assert.equal(await credits(pilot), 8500);
  });
  test('a later paid T4 -> T5 upgrade never creates T6 or downgrades the stored selection', async () => {
    const { pilot, crew } = await setup('ADEPT');
    await setCredits(pilot, 20_000);
    await setTier(pilot, 'HULL', 5);
    await setTier(pilot, 'RADAR', 4);
    const selected = await configure(pilot, crew, ['RADAR']);
    assert.equal(selected.statusCode, 200, selected.body);
    assert.equal(json(selected).ship_attributes.radar_range_m, 4000);
    const upgraded = await call(pilot, 'POST', '/ship/upgrade', { componentType: 'RADAR', targetTier: 5, dockedReceipt: dockedReceipt(pilot) });
    assert.equal(upgraded.statusCode, 200, upgraded.body);
    assert.equal(json(upgraded).cost, 12_000);
    assert.equal(json(upgraded).components.find((c) => c.type === 'RADAR').tier, 5);
    assert.equal(json(upgraded).ship_attributes.radar_range_m, 4000);
    assert.deepEqual((await row(crew.id)).juryRigComponentTypes, ['RADAR']);
    assert.equal(json(await configure(pilot, crew, ['RADAR'])).error, 'jury_rig_already_max_tier');
    assert.equal(await credits(pilot), 8000);
  });
  test('concurrent selections remain atomic and never consume extra rank slots or charge credits', async () => {
    const { pilot, crew } = await setup('ADEPT');
    const results = await Promise.all([configure(pilot, crew, ['RADAR']), configure(pilot, crew, ['ENGINES'])]);
    for (const res of results) assert.equal(res.statusCode, 200, res.body);
    const stored = (await row(crew.id)).juryRigComponentTypes;
    assert.equal(stored.length, 1);
    const attrs = (await loadout(pilot)).ship_attributes;
    assert.equal(attrs.radar_range_m, stored[0] === 'RADAR' ? 1000 : 500);
    assert.equal(attrs.max_speed_mps, stored[0] === 'ENGINES' ? 40 : 20);
    assert.equal(await credits(pilot), 1000);
  });
});
