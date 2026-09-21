const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = (relative) =>
  fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8');

test('auth route guard waits for the non-persisted page-lifecycle resolution flag', () => {
  const store = source('store/authStore.ts');
  const guard = source('components/RequireAuth.tsx');
  const app = source('App.tsx');
  const partialize = store.slice(store.indexOf('partialize:'));
  assert.match(store, /authResolved: false/);
  assert.doesNotMatch(partialize, /authResolved:\s*state\.authResolved/);
  assert.match(guard, /!isAuthenticated && !authResolved/);
  assert.match(app, /markAuthResolved\(\)/);
});

test('room retries are bounded, scoped to ALREADY_IN_ROOM, and clear timers', () => {
  for (const relative of [
    'modules/room/RoomPage.tsx',
    'modules/screen-sharing/hooks/useJoinRoom.ts',
  ]) {
    const code = source(relative);
    assert.match(code, /ALREADY_IN_ROOM/);
    assert.match(code, /<= 3/);
    assert.match(code, /1500/);
    assert.match(code, /clearTimeout/);
  }
});

test('failed movie auto-loads are fenced until an explicit retry or lifecycle reset', () => {
  const code = source('modules/room/watch-together/useWatchTogether.ts');
  assert.match(code, /failedLoadMovieIdsRef\.current\.has\(movie\.id\)/);
  assert.match(code, /failedLoadMovieIdsRef\.current\.add\(movie\.id\)/);
  assert.match(code, /failedLoadMovieIdsRef\.current\.clear\(\)/);
});

test('room media teardown reaches video, music, and FLV consumers', () => {
  const targets = [
    'modules/room/watch-together/useWatchTogether.ts',
    'modules/music/useMusicSync.ts',
    'modules/screen-sharing/components/FlvPlayer.tsx',
  ];
  for (const relative of targets) {
    assert.match(source(relative), /ROOM_MEDIA_TEARDOWN_EVENT/);
  }
});
