import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { addCrew, app, call, closeApp, json, newPilot } from './helpers.js';

before(async () => { await app.ready(); });
after(closeApp);

const MIN = 60_000;
const listed = async (pilot, crew) => json(await call(pilot, 'GET', '/game/crew')).active.find((m) => m.id === crew.id);

describe('crew view: expedition trauma', () => {
  test('a traumatized member lists traumaUntil and traumaType', async () => {
    const pilot = await newPilot('TraumaView');
    const until = new Date(Date.now() + 30 * MIN);
    const hurt = await addCrew(pilot, { crewClass: 'ENGINEER', traumaUntil: until, traumaType: 'CONCUSSION' });
    const view = await listed(pilot, hurt);
    assert.equal(view.traumaUntil, until.toISOString());
    assert.equal(view.traumaType, 'CONCUSSION');
  });

  test('an expired trauma reads as none', async () => {
    const pilot = await newPilot('TraumaExpired');
    const healed = await addCrew(pilot, { traumaUntil: new Date(Date.now() - MIN), traumaType: 'HYPOTHERMIA' });
    const view = await listed(pilot, healed);
    assert.equal(view.traumaUntil, null);
    assert.equal(view.traumaType, null);
  });

  test('a member never traumatized has both null', async () => {
    const pilot = await newPilot('TraumaNever');
    const fit = await addCrew(pilot, {});
    const view = await listed(pilot, fit);
    assert.equal(view.traumaUntil, null);
    assert.equal(view.traumaType, null);
  });
});
