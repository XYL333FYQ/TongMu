const assert = require('node:assert/strict');
const { test } = require('node:test');
const { SecretVault } = require('../dist/services/secret-vault');
const {
  durableMovieUrl,
  movieUrlTransformer,
  playbackHeadersTransformer,
  requiresProtectedMovieUrl,
} = require('../dist/services/media/movie-url-storage');

test('public direct movie URLs remain usable; signed and private URLs are encrypted at rest', () => {
  const vault = new SecretVault({ masterKey: Buffer.alloc(32, 4) });
  const transformer = movieUrlTransformer(vault);
  const publicUrl = 'https://cdn.example/movie.mp4';
  const signedUrl = 'https://cdn.example/movie.mp4?signature=short-lived&expires=9999999999';
  const privateUrl = 'https://cdn.example/movie.mp4?token=private';
  assert.equal(transformer.to(publicUrl), publicUrl);
  for (const url of [signedUrl, privateUrl]) {
    assert.equal(requiresProtectedMovieUrl(url), true);
    const stored = transformer.to(url);
    assert.match(stored, /^v1:/);
    assert.equal(stored.includes(url), false);
    assert.equal(transformer.from(stored), url);
    assert.throws(() => transformer.from(url), /尚未完成迁移/);
    assert.throws(() => transformer.from(`${stored}x`));
  }
});

test('playback headers are authenticated at rest and reject unmigrated plaintext', () => {
  const vault = new SecretVault({ masterKey: Buffer.alloc(32, 5) });
  const transformer = playbackHeadersTransformer(vault);
  const headers = '{"Authorization":"Bearer secret"}';
  const stored = transformer.to(headers);
  assert.match(stored, /^v1:/);
  assert.equal(transformer.from(stored), headers);
  assert.throws(() => transformer.from(headers), /尚未完成迁移/);
});

test('a temporary media handle is replaced only when a canonical resolver can refresh it', () => {
  const handle = '/api/stream/media/room-capability';
  assert.equal(durableMovieUrl(handle, 41, 'https://site.example/watch/1', '{"resolver":"browser"}'), 'media-movie:41');
  assert.equal(durableMovieUrl(handle, undefined, 'https://site.example/watch/1', '{"resolver":"browser"}'), 'media-movie:pending');
  assert.equal(durableMovieUrl(handle, 41, null, '{"resolver":"browser"}'), handle);
  assert.equal(durableMovieUrl(handle, 41, 'https://site.example/watch/1', '{}'), handle);
  assert.equal(durableMovieUrl('https://cdn.example/movie.mp4', 41, 'https://site.example/watch/1', '{"resolver":"browser"}'), 'https://cdn.example/movie.mp4');
});
