import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTE_BUCKETS, normalizeRoutes, routeMembers, pinId, parsePinId, configuredPinId, autoPinId,
} from '../src/routes.js';

// The routing table's one normaliser. It is total: every rejection is a warning
// and a dropped field, never a throw, because the table it reads is a file an
// operator wrote by hand and a bad line must not stop the proxy from starting.

const accounts = [{ name: 'a', index: 0 }, { name: 'b', index: 1 }, { name: 'c', index: 2 }];

test('normalizeRoutes coerces match and drops a route with no usable glob', () => {
  const { routes, warnings } = normalizeRoutes([
    { name: 'one', match: '*opus*' },
    { name: 'two', match: ['*fable*', '', 7, null] },
    { name: 'three', match: [] },
    { name: 'four' },
    'nonsense',
  ], accounts);

  assert.deepEqual(routes.map(r => r.name), ['one', 'two']);
  assert.deepEqual(routes[0].match, ['*opus*']);
  assert.deepEqual(routes[1].match, ['*fable*']);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.every(w => /no model glob/.test(w)));
});

test('normalizeRoutes names an unnamed route by its position and keeps the first duplicate', () => {
  const { routes, warnings } = normalizeRoutes([
    { match: ['*opus*'] },
    { name: 'dup', match: ['*fable*'], accounts: ['a'] },
    { name: 'dup', match: ['*sonnet*'], accounts: ['b'] },
  ], accounts);

  assert.deepEqual(routes.map(r => r.name), ['route-1', 'dup']);
  assert.deepEqual(routes[1].match, ['*fable*'], 'the first definition is the one kept');
  assert.match(warnings[0], /duplicate route name "dup"/);
});

test('normalizeRoutes warns about an unfamiliar bucket but keeps it', () => {
  const { routes, warnings } = normalizeRoutes([
    // A third-party backend can meter against a window upstream names itself,
    // and the router reads whatever key the route gives it — so the odd name is
    // reported, not overruled.
    { name: 'custom', match: ['*opus*'], bucket: 'unified7dCustom' },
    { name: 'broken', match: ['*opus*'], bucket: { nope: true } },
    ...ROUTE_BUCKETS.map(bucket => ({ name: bucket, match: ['*opus*'], bucket })),
  ], accounts);

  assert.equal(routes[0].bucket, 'unified7dCustom');
  assert.equal(warnings[0], 'route "custom": bucket "unified7dCustom" is not one of unified7d, unified7dFable, unified7dSonnet');
  assert.equal(routes[1].bucket, null, 'a bucket that is not a string names no window');
  assert.match(warnings[1], /bucket is not a string/);
  assert.deepEqual(routes.slice(2).map(r => r.bucket), ROUTE_BUCKETS);
  assert.equal(warnings.length, 2, 'the three known buckets pass in silence');
});

test('normalizeRoutes keeps unknown fields and index-string account lists untouched', () => {
  const { routes, warnings } = normalizeRoutes(
    [{ name: 'r', match: ['*opus*'], accounts: ['a', 1], color: 'red', mystery: { deep: true } }], accounts);
  assert.deepEqual(routes[0].accounts, ['a', '1']);
  assert.deepEqual(routes[0].mystery, { deep: true });
  assert.equal(routes[0].color, 'red');
  assert.deepEqual(warnings, []);
});

test('normalizeRoutes keeps a valid override and its since stamp', () => {
  const { routes, warnings } = normalizeRoutes(
    [{ name: 'r', match: ['*opus*'], accounts: ['a', 'b'], override: { account: 'b', whenSpent: 'hold', since: 17 } }],
    accounts);
  assert.deepEqual(routes[0].override, { account: 'b', whenSpent: 'hold', since: 17 });
  assert.deepEqual(warnings, []);
});

test('normalizeRoutes drops an override it cannot honour and keeps the route', () => {
  const cases = [
    [{ account: 'nobody', whenSpent: 'hold' }, /no account named "nobody"/],
    [{ account: 'c', whenSpent: 'hold' }, /not a member of this route/],
    [{ account: 'b', whenSpent: 'later' }, /whenSpent must be fallback or hold/],
    [{ account: 'b' }, /whenSpent must be/],
    [{ whenSpent: 'hold' }, /names no account/],
    [{ account: 'b', whenSpent: 'hold', since: 'yesterday' }, /since is not a number/],
    ['forced', /not an object/],
  ];
  for (const [override, expected] of cases) {
    const { routes, warnings } = normalizeRoutes(
      [{ name: 'r', match: ['*opus*'], accounts: ['a', 'b'], override }], accounts);
    assert.equal(routes.length, 1, `${JSON.stringify(override)}: route kept`);
    assert.equal(routes[0].override, undefined, `${JSON.stringify(override)}: override dropped`);
    assert.match(warnings[0], expected);
  }
});

test('an override on a route that lists no accounts may name any account', () => {
  const { routes, warnings } = normalizeRoutes(
    [{ name: 'r', match: ['*opus*'], override: { account: 'c', whenSpent: 'fallback' } }], accounts);
  assert.deepEqual(routes[0].override, { account: 'c', whenSpent: 'fallback' });
  assert.deepEqual(warnings, []);
});

test('routeMembers reads the list by name or index string, and all accounts without one', () => {
  assert.deepEqual(routeMembers({ accounts: ['b', '2'] }, accounts).map(a => a.name), ['b', 'c']);
  assert.deepEqual(routeMembers({ accounts: [] }, accounts).map(a => a.name), ['a', 'b', 'c']);
  assert.deepEqual(routeMembers({}, accounts).map(a => a.name), ['a', 'b', 'c']);
  assert.deepEqual(routeMembers({ accounts: ['gone'] }, accounts), []);
});

test('pin ids keep configured routes and auto rows apart', () => {
  assert.equal(configuredPinId('fable'), 'configured:fable');
  assert.equal(autoPinId('fable'), 'auto:fable');
  assert.equal(pinId({ name: 'fable', autocreated: true }), 'auto:fable');
  assert.equal(pinId({ name: 'fable' }), 'configured:fable');
  assert.notEqual(pinId({ name: 'fable' }), pinId({ name: 'fable', autocreated: true }));

  assert.deepEqual(parsePinId('configured:my:route'), { kind: 'configured', name: 'my:route' });
  for (const bad of ['fable', 'other:fable', 'configured:', ':x', '', null, 7]) {
    assert.equal(parsePinId(bad), null, `${bad} is not a pin id`);
  }
});
