const test = require('node:test');
const assert = require('node:assert/strict');
const { ActivityPoll, selectDelegate } = require('../dist/modules/room/activity-poll');
const { validateRoomPolicy, parseRoomPolicy, shouldExpireRoom, EMPTY_ROOM_TTL_MS, DELEGATE_GRACE_MS } = require('../dist/modules/room/room-policy');
const { canPerformRoomAction } = require('../dist/modules/room/permission-core');
const facts = (actorRole, policy, extra = {}) => ({ actorRole, policy, isHost: actorRole === 'owner', isRoomMember: true, userId: actorRole === 'guest' ? null : 1, ...extra });

test('creation defaults and fine controls are validated without accepting unknown authority', () => {
  const defaults = validateRoomPolicy({});
  assert.deepEqual([defaults.visibility, defaults.lifetime, defaults.collaboration, defaults.allowGuests], ['public', 'temporary', 'host', true]);
  assert.equal(parseRoomPolicy('invalid').visibility, 'public');
  assert.throws(() => validateRoomPolicy({ permissions: { hostTransfer: true } }));
  assert.throws(() => validateRoomPolicy({ lifetime: 'forever' }));
  assert.throws(() => validateRoomPolicy({ allowGuests: 'false' }));
});
test('shared members control content and playback while guests require explicit collaboration', () => {
  const policy = validateRoomPolicy({ collaboration: 'shared' });
  assert.equal(canPerformRoomAction(facts('member', policy), 'movie.change').allowed, true);
  assert.equal(canPerformRoomAction(facts('member', policy), 'music.play').allowed, true);
  assert.equal(canPerformRoomAction(facts('member', policy), 'activity.switch').allowed, false);
  assert.equal(canPerformRoomAction(facts('guest', policy), 'movie.change').allowed, false);
  assert.equal(canPerformRoomAction(facts('guest', policy), 'activity.request').allowed, true);
  assert.equal(canPerformRoomAction(facts('guest', { ...policy, guestCollaboration: true }), 'playback.seek').allowed, true);
  assert.equal(canPerformRoomAction(facts('member', { ...policy, permissions: { playback: false } }), 'playback.seek').allowed, false);
});
test('temporary hosting grants activity authority without ownership or platform administration', () => {
  const delegate = facts('guest', validateRoomPolicy({}), { isDelegate: true, isHost: true });
  for (const action of ['movie.change', 'music.play', 'activity.switch']) assert.equal(canPerformRoomAction(delegate, action).allowed, true);
  for (const action of ['room.settings', 'host.transfer', 'moderator.manage', 'viewer.approve']) assert.equal(canPerformRoomAction(delegate, action).allowed, false);
  assert.equal(canPerformRoomAction({ ...delegate, actorRole: 'system' }, 'room.settings').allowed, false);
});
test('delegation uses room roles and random ties, never a platform role', () => {
  assert.equal(DELEGATE_GRACE_MS, 30000);
  const candidates = [
    { socketId: 'platform-root', permissionScore: 0 },
    { socketId: 'room-moderator', permissionScore: 3 },
    { socketId: 'guest', permissionScore: 0 },
  ];
  assert.equal(selectDelegate(candidates), 'room-moderator');
  assert.equal(selectDelegate([candidates[0], { socketId: 'ordinary-user', permissionScore: 0 }], () => .99), 'ordinary-user');
  assert.equal(selectDelegate([candidates[0], candidates[2]], () => .99), 'guest');
  assert.equal(selectDelegate([candidates[2]]), 'guest');
  assert.equal(selectDelegate([]), null);
});
test('one vote per identity is editable and expires after 60 seconds without choosing an activity', () => {
  const poll = new ActivityPoll('listen', 'socket', 'Sam', 1000);
  poll.vote('user:1', true, 2000);
  poll.vote('user:1', false, 3000);
  poll.vote('guest:stable-token', true, 4000);
  assert.deepEqual([poll.snapshot(5000).yes, poll.snapshot(5000).no], [1, 1]);
  assert.equal(poll.snapshot(61000).ended, true);
  assert.throws(() => poll.vote('user:2', true, 61000));
  assert.equal('automaticSwitch' in poll.snapshot(), false);
});
test('only empty temporary rooms expire after 24h; a return cancels that deadline', () => {
  const policy = validateRoomPolicy({});
  const start = new Date(1000);
  assert.equal(shouldExpireRoom(policy, start, 0, 1000 + EMPTY_ROOM_TTL_MS - 1), false);
  assert.equal(shouldExpireRoom(policy, start, 0, 1000 + EMPTY_ROOM_TTL_MS), true);
  assert.equal(shouldExpireRoom(policy, start, 1, 1000 + EMPTY_ROOM_TTL_MS), false);
  assert.equal(shouldExpireRoom(policy, null, 0, 1000 + EMPTY_ROOM_TTL_MS), false);
  assert.equal(shouldExpireRoom({ ...policy, lifetime: 'persistent' }, start, 0, 1000 + EMPTY_ROOM_TTL_MS), false);
});
