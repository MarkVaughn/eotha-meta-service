import { after, before, describe, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { addCrew, app, call, closeApp, credits, dockedReceipt, json, newPilot, setCredits } from './helpers.js';
import { DockableKind } from '../src/lib/contracts/penalty/eotha/common/v1/sector.js';
import { DOCKED_RECEIPT_TTL_MS } from '../src/config/docking.js';
import { stationServices } from '../src/lib/outfitting-station.js';

before(async () => { await app.ready(); });
after(closeApp);

const MIN = 60_000;
const NEUTRAL = 'Q08';
const hurt = (extra = {}) => ({ quirkId: NEUTRAL, morale: 30, traumaUntil: new Date(Date.now() + 30 * MIN), traumaType: 'CONCUSSION', ...extra });
const row = (id) => app.prisma.crewMember.findUnique({ where: { id } });
const treat = (pilot, crew, extra = {}) => call(pilot, 'POST', '/game/crew/treat-trauma', { crewId: crew.id, dockedReceipt: dockedReceipt(pilot), ...extra });
const atKind = (kind) => mock.method(stationServices, 'dockableKind', () => kind);

async function setup(rank = 'NOVICE', balance = 5000, extra = {}) {
  const pilot = await newPilot('Infirmary');
  const patient = await addCrew(pilot, hurt({ crewClass: 'ENGINEER', rank, ...extra }));
  await setCredits(pilot, balance);
  return { pilot, patient };
}

describe('POST /game/crew/treat-trauma', () => {
  for (const kind of ['COLONY', 'RESEARCH', 'TRADING']) {
    test(`a ${kind} station treats: trauma cleared, morale to the floor, fee charged`, async () => {
      const dock = atKind(DockableKind[`DOCKABLE_KIND_${kind}`]);
      try {
        const { pilot, patient } = await setup('NOVICE', 1000);
        const res = await treat(pilot, patient);
        assert.equal(res.statusCode, 200, res.body);
        const body = json(res);
        assert.equal(body.feeCredits, 250);
        assert.equal(body.credits, 750);
        assert.equal(body.crew.id, patient.id);
        assert.equal(body.crew.traumaUntil, null);
        assert.equal(body.crew.traumaType, null);
        assert.equal(body.crew.morale, 50);
        assert.ok(body.token);
        const stored = await row(patient.id);
        assert.equal(stored.traumaUntil, null);
        assert.equal(stored.traumaType, null);
        assert.equal(stored.morale, 50);
        assert.equal(await credits(pilot), 750);
      } finally { dock.mock.restore(); }
    });
  }

  for (const [rank, fee] of [['NOVICE', 250], ['ADEPT', 500], ['MASTER', 1000]]) {
    test(`a ${rank} patient costs ${fee}`, async () => {
      const dock = atKind(DockableKind.DOCKABLE_KIND_COLONY);
      try {
        const { pilot, patient } = await setup(rank, 2000);
        const res = await treat(pilot, patient);
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(json(res).feeCredits, fee);
        assert.equal(await credits(pilot), 2000 - fee);
      } finally { dock.mock.restore(); }
    });
  }

  test('morale already above the floor is kept', async () => {
    const dock = atKind(DockableKind.DOCKABLE_KIND_COLONY);
    try {
      const { pilot, patient } = await setup('NOVICE', 1000, { morale: 80 });
      assert.equal((await treat(pilot, patient)).statusCode, 200);
      assert.equal((await row(patient.id)).morale, 80);
    } finally { dock.mock.restore(); }
  });

  test('a resigned member is treated but stays resigned', async () => {
    const dock = atKind(DockableKind.DOCKABLE_KIND_COLONY);
    try {
      const { pilot, patient } = await setup('NOVICE', 1000, { morale: 0 });
      assert.equal((await treat(pilot, patient)).statusCode, 200);
      const stored = await row(patient.id);
      assert.equal(stored.morale, 0);
      assert.equal(stored.traumaUntil, null);
    } finally { dock.mock.restore(); }
  });

  describe('with a Doctor aboard', () => {
    const doctor = (extra = {}) => ({ crewClass: 'DOCTOR', rank: 'ADEPT', morale: 75, quirkId: NEUTRAL, ...extra });
    for (const rank of ['ADEPT', 'MASTER']) {
      test(`an active ${rank} Doctor waives the fee`, async () => {
        const dock = atKind(DockableKind.DOCKABLE_KIND_RESEARCH);
        try {
          const { pilot, patient } = await setup('MASTER', 100);
          await addCrew(pilot, doctor({ rank }));
          const res = await treat(pilot, patient);
          assert.equal(res.statusCode, 200, res.body);
          assert.equal(json(res).feeCredits, 0);
          assert.equal(await credits(pilot), 100);
          assert.equal((await row(patient.id)).traumaUntil, null);
        } finally { dock.mock.restore(); }
      });
    }

    const noWaiver = {
      'a Novice Doctor': doctor({ rank: 'NOVICE' }),
      'a Doctor below Nominal morale': doctor({ morale: 40 }),
      'a Doctor held by customs': doctor({ detainedUntil: new Date(Date.now() + 10 * MIN) }),
      'a traumatized Doctor': doctor({ traumaUntil: new Date(Date.now() + 10 * MIN), traumaType: 'BURNS' }),
      'a Doctor on Harbor Standby': doctor({ status: 'STANDBY', spaceshipId: null })
    };
    for (const [name, extra] of Object.entries(noWaiver)) {
      test(`${name} does not waive the fee`, async () => {
        const dock = atKind(DockableKind.DOCKABLE_KIND_COLONY);
        try {
          const { pilot, patient } = await setup('ADEPT', 1000);
          await addCrew(pilot, extra);
          const res = await treat(pilot, patient);
          assert.equal(res.statusCode, 200, res.body);
          assert.equal(json(res).feeCredits, 500);
          assert.equal(await credits(pilot), 500);
        } finally { dock.mock.restore(); }
      });
    }
  });

  describe('refusals', () => {
    test('a station without an infirmary refuses and changes nothing', async () => {
      for (const kind of [DockableKind.DOCKABLE_KIND_MINING, DockableKind.DOCKABLE_KIND_UNSPECIFIED]) {
        const dock = atKind(kind);
        try {
          const { pilot, patient } = await setup('NOVICE', 1000);
          const res = await treat(pilot, patient);
          assert.equal(res.statusCode, 409);
          assert.equal(json(res).error, 'station_has_no_infirmary');
          assert.equal(await credits(pilot), 1000);
          assert.notEqual((await row(patient.id)).traumaUntil, null);
        } finally { dock.mock.restore(); }
      }
    });

    test('the default dock kind is unknown, so the route refuses', async () => {
      const { pilot, patient } = await setup();
      const res = await treat(pilot, patient);
      assert.equal(res.statusCode, 409);
      assert.equal(json(res).error, 'station_has_no_infirmary');
    });

    test('not docked: no receipt, an expired or foreign receipt, or the wrong station', async () => {
      const dock = atKind(DockableKind.DOCKABLE_KIND_COLONY);
      try {
        const { pilot, patient } = await setup();
        const proof = dockedReceipt(pilot);
        const missing = await call(pilot, 'POST', '/game/crew/treat-trauma', { crewId: patient.id });
        assert.equal(missing.statusCode, 403);
        assert.equal(json(missing).error, 'docked_receipt_required');
        const stale = await treat(pilot, patient, { dockedReceipt: dockedReceipt(pilot, { dockedAtMs: 0, issuedAtMs: Date.now() - DOCKED_RECEIPT_TTL_MS - 1_000 }) });
        assert.equal(stale.statusCode, 403);
        assert.equal(json(stale).error, 'docked_receipt_required');
        const foreign = await treat(pilot, patient, { dockedReceipt: dockedReceipt('other-pilot') });
        assert.equal(foreign.statusCode, 403);
        assert.equal(json(foreign).error, 'docked_receipt_invalid');
        const tampered = await treat(pilot, patient, { dockedReceipt: { ...proof, dockedAtMs: 0 } });
        assert.equal(tampered.statusCode, 403);
        const wrong = await treat(pilot, patient, { stationId: '00000000-0000-4000-8000-000000000000', dockedReceipt: proof });
        assert.equal(wrong.statusCode, 403);
        assert.equal(json(wrong).error, 'docked_receipt_wrong_station');
        assert.equal(await credits(pilot), 5000);
        assert.notEqual((await row(patient.id)).traumaUntil, null);
      } finally { dock.mock.restore(); }
    });

    test('a member who is not traumatized (never hurt, or already healed) is refused without a charge', async () => {
      const dock = atKind(DockableKind.DOCKABLE_KIND_COLONY);
      try {
        const pilot = await newPilot('Infirmary');
        await setCredits(pilot, 1000);
        const fit = await addCrew(pilot, { quirkId: NEUTRAL });
        const healed = await addCrew(pilot, { crewClass: 'ENGINEER', traumaUntil: new Date(Date.now() - MIN), traumaType: 'BURNS', quirkId: NEUTRAL });
        for (const member of [fit, healed]) {
          const res = await treat(pilot, member);
          assert.equal(res.statusCode, 409);
          assert.equal(json(res).error, 'crew_not_traumatized');
        }
        assert.equal(await credits(pilot), 1000);
      } finally { dock.mock.restore(); }
    });

    test('insufficient credits refuses, reports the fee and leaves the trauma', async () => {
      const dock = atKind(DockableKind.DOCKABLE_KIND_COLONY);
      try {
        const { pilot, patient } = await setup('MASTER', 999);
        const res = await treat(pilot, patient);
        assert.equal(res.statusCode, 402);
        assert.equal(json(res).error, 'insufficient_credits');
        assert.equal(json(res).requiredCredits, 1000);
        assert.equal(await credits(pilot), 999);
        const stored = await row(patient.id);
        assert.notEqual(stored.traumaUntil, null);
        assert.equal(stored.morale, 30);
      } finally { dock.mock.restore(); }
    });

    test('crew not on the pilot\'s ship: unknown, another pilot\'s, or on Harbor Standby', async () => {
      const dock = atKind(DockableKind.DOCKABLE_KIND_COLONY);
      try {
        const { pilot } = await setup();
        const other = await setup();
        const standby = await addCrew(pilot, hurt({ status: 'STANDBY', spaceshipId: null }));
        const unknown = await treat(pilot, { id: '00000000-0000-4000-8000-000000000000' });
        assert.equal(unknown.statusCode, 404);
        assert.equal(json(unknown).error, 'crew_not_found');
        const foreign = await treat(pilot, other.patient);
        assert.equal(foreign.statusCode, 404);
        assert.equal(json(foreign).error, 'crew_not_found');
        const parked = await treat(pilot, standby);
        assert.equal(parked.statusCode, 409);
        assert.equal(json(parked).error, 'crew_not_active');
        assert.notEqual((await row(other.patient.id)).traumaUntil, null);
        assert.notEqual((await row(standby.id)).traumaUntil, null);
        assert.equal(await credits(other.pilot), 5000);
      } finally { dock.mock.restore(); }
    });

    test('a malformed crewId is a schema error', async () => {
      const pilot = await newPilot('Infirmary');
      const res = await call(pilot, 'POST', '/game/crew/treat-trauma', { crewId: 'nope', dockedReceipt: dockedReceipt(pilot) });
      assert.equal(res.statusCode, 400);
    });
  });
});
