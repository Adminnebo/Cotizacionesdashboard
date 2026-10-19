// Fechas sin hora = días completos en la hora de RD (TZ_DISPLAY), no en UTC.
const test = require('node:test');
const assert = require('node:assert');
const { rangeOf, inicioDelDia } = require('../range');

test('un día de RD empieza a las 04:00 UTC', () => {
  assert.strictEqual(inicioDelDia('2026-10-11', 'America/Santo_Domingo').toISOString(), '2026-10-11T04:00:00.000Z');
  assert.strictEqual(inicioDelDia('2026-10-11', 'UTC').toISOString(), '2026-10-11T00:00:00.000Z');
});

test('from/to de fecha: del inicio del primer día al fin del último, en hora de RD', () => {
  const r = rangeOf({ query: { from: '2026-10-11', to: '2026-10-17' } }, 'America/Santo_Domingo');
  assert.deepStrictEqual(r, { from: '2026-10-11T04:00:00.000Z', to: '2026-10-18T04:00:00.000Z' });
});

test('con hora explícita y zona se respeta tal cual; days sigue igual', () => {
  const r = rangeOf({ query: { from: '2026-10-11T10:00:00Z', to: '2026-10-11T12:00:00Z' } }, 'America/Santo_Domingo');
  assert.deepStrictEqual(r, { from: '2026-10-11T10:00:00.000Z', to: '2026-10-11T12:00:00.000Z' });
  const d = rangeOf({ query: { days: '7' } });
  assert.ok(Date.parse(d.to) - Date.parse(d.from) > 7 * 86400000 - 5000);
});
