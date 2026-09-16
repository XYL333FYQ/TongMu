const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const http = require("node:http");

const {
  NcmCatalogService,
  parseNcmLyricText,
} = require("../dist/modules/music/ncm/ncm-catalog.service");
const { NcmProviderError } = require("../dist/modules/music/ncm/types");
const {
  createNcmCatalogRouter,
} = require("../dist/modules/music/ncm/ncm-catalog.routes");
const { safePublicHttpUrl } = require("../dist/modules/music/safe-url");

function track(id, name = `Track ${id}`) {
  return {
    id: String(id),
    name,
    ar: [{ name: "Fixture Artist" }],
    al: { name: "Fixture Album", picUrl: "https://music.126.net/cover.jpg" },
    dt: 1_000,
    fee: 0,
    availableQualities: ["standard", "exhigh"],
  };
}

class FakeCatalogClient {
  constructor() {
    this.songDetailCalls = [];
    this.lastRequest = null;
  }

  async search(params) {
    this.lastRequest = params;
    if (params.type === "song")
      return { code: 200, result: { songs: [track("101")], songCount: 1 } };
    if (params.type === "playlist")
      return {
        code: 200,
        result: {
          playlists: [{ id: "501", name: "Fixture Playlist", trackCount: 2 }],
          playlistCount: 1,
        },
      };
    if (params.type === "album")
      return {
        code: 200,
        result: {
          albums: [
            {
              id: "601",
              name: "Fixture Album",
              artist: { name: "Fixture Artist" },
            },
          ],
          albumCount: 1,
        },
      };
    return {
      code: 200,
      result: {
        artists: [{ id: "701", name: "Fixture Artist" }],
        artistCount: 1,
      },
    };
  }

  async getPlaylistDetail() {
    return {
      code: 200,
      playlist: {
        id: "501",
        name: "Large Playlist",
        trackCount: 1_000,
        trackIds: Array.from({ length: 1_000 }, (_, index) => ({
          id: String(index % 3 === 0 ? 801 : index % 3 === 1 ? 801 : 802),
        })),
      },
    };
  }

  async getSongDetails(ids) {
    this.songDetailCalls.push([...ids]);
    return { code: 200, songs: [...new Set(ids)].map((id) => track(id)) };
  }

  async getPlaylistTracks() {
    return { code: 200, songs: [] };
  }
  async getAlbumDetail() {
    return {
      code: 200,
      album: {
        id: "601",
        name: "Fixture Album",
        artist: { name: "Fixture Artist" },
        size: 2,
      },
      songs: [track("801"), track("802")],
    };
  }
  async getArtistDetail() {
    return {
      code: 200,
      data: {
        artist: {
          id: "701",
          name: "Fixture Artist",
          albumSize: 1,
          musicSize: 2,
        },
      },
    };
  }
  async getArtistTopSongs() {
    return { code: 200, songs: [track("801"), track("802")] };
  }
  async getArtistAlbums() {
    return {
      code: 200,
      hotAlbums: [
        {
          id: "601",
          name: "Fixture Album",
          artist: { name: "Fixture Artist" },
        },
      ],
      albumCount: 1,
    };
  }
  async getUserPlaylists() {
    return { code: 200, playlist: [] };
  }
  async getLikedSongs() {
    return { code: 200, ids: ["801"] };
  }
  async getPersonalFm() {
    return { code: 200, data: [track("801")] };
  }
  async trashFm() {
    return { code: 200 };
  }
  async getCloudSongs() {
    return { code: 200, data: [{ simpleSong: track("801") }], count: 1 };
  }
  async getLyrics() {
    return {
      code: 200,
      lrc: {
        lyric: "[00:01.00]one\n[00:01.00]duplicate\nuntimed\n[bad] malformed",
      },
      tlyric: { lyric: "[00:01.00]translation" },
      romalrc: {},
    };
  }
  async getComments() {
    return {
      code: 200,
      comments: [
        {
          commentId: "901",
          content: "<b>kept as text</b>",
          user: { nickname: "Commenter" },
          likedCount: 3,
        },
      ],
      total: 1,
    };
  }
  async likeSong() {
    return { code: 200 };
  }
  async likeComment() {
    return { code: 200 };
  }
}

function credentialsForOwnerOne() {
  return {
    async getPrivateCredential(userId) {
      return userId === 1 ? { cookieHeader: "MUSIC_U=server-only" } : null;
    },
    async getStatus(userId) {
      return { accountId: userId === 1 ? "ncm-account-1" : null };
    },
  };
}

test("NCM catalog search validates bounds, keeps provider-neutral stable refs, and rejects malformed lists", async () => {
  const client = new FakeCatalogClient();
  const catalog = new NcmCatalogService(client, credentialsForOwnerOne());
  const result = await catalog.search({
    query: " fixture ",
    type: "song",
    offset: 0,
    limit: 10,
  });
  assert.equal(client.lastRequest.keywords, "fixture");
  assert.equal(result.items[0].sourceRef, "music://ncm/track/101");
  assert.equal(JSON.stringify(result).includes("url"), false);
  await assert.rejects(
    () => catalog.search({ query: " ", type: "song", offset: 0, limit: 10 }),
    (error) =>
      error instanceof NcmProviderError &&
      error.code === "MUSIC_INVALID_REQUEST",
  );
  client.search = async () => ({
    code: 200,
    result: { songs: "not-an-array" },
  });
  await assert.rejects(
    () =>
      catalog.search({ query: "fixture", type: "song", offset: 0, limit: 10 }),
    (error) =>
      error instanceof NcmProviderError &&
      error.code === "NCM_INVALID_RESPONSE",
  );
});

test("large playlist hydration is bounded and preserves duplicate track IDs", async () => {
  const client = new FakeCatalogClient();
  const catalog = new NcmCatalogService(client, credentialsForOwnerOne());
  const result = await catalog.getPlaylist("501", { offset: 0, limit: 5 });
  assert.equal(client.songDetailCalls.length, 1);
  assert.deepEqual(client.songDetailCalls[0], [
    "801",
    "801",
    "802",
    "801",
    "801",
  ]);
  assert.equal(result.tracks.length, 5);
  assert.equal(result.tracks[0].sourceRef, result.tracks[1].sourceRef);
  assert.equal(result.tracks[0].sourceRef, "music://ncm/track/801");
  assert.equal(result.total, 1_000);
});

test("album and artist details remain normalized and use stable refs", async () => {
  const catalog = new NcmCatalogService(
    new FakeCatalogClient(),
    credentialsForOwnerOne(),
  );
  const album = await catalog.getAlbum("601");
  const artist = await catalog.getArtist("701", { limit: 10 });
  assert.equal(album.albumId, "601");
  assert.equal(album.tracks[0].sourceRef, "music://ncm/track/801");
  assert.equal(artist.artist.artistId, "701");
  assert.equal(artist.artist.topTracks[0].sourceRef, "music://ncm/track/801");
  assert.equal(artist.artist.albums[0].albumId, "601");
});

test("private catalog is current-owner only and does not accept an alternate owner argument", async () => {
  const catalog = new NcmCatalogService(
    new FakeCatalogClient(),
    credentialsForOwnerOne(),
  );
  const liked = await catalog.getLiked(1, { limit: 10 });
  assert.equal(liked.items[0].liked, true);
  await assert.rejects(
    () => catalog.getLiked(2, { limit: 10 }),
    (error) =>
      error instanceof NcmProviderError && error.code === "NCM_NOT_LOGGED_IN",
  );

  const app = express();
  app.use(createNcmCatalogRouter(catalog));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/ncm/liked?ownerId=1`,
  );
  assert.equal(response.status, 401);
  await server.close();
});

test("lyrics retain timed, untimed, malformed, and duplicate lines as plain text", async () => {
  const lines = parseNcmLyricText(
    "[00:01.00]one\n[00:01.00]duplicate\nuntimed\n[00:99] malformed",
  );
  assert.deepEqual(
    lines.map((line) => line.timestampMs),
    [1_000, 1_000, null, null],
  );
  assert.equal(lines[3].text, "[00:99] malformed");
  const catalog = new NcmCatalogService(
    new FakeCatalogClient(),
    credentialsForOwnerOne(),
  );
  const lyrics = await catalog.getLyrics("801");
  assert.equal(lyrics.translated[0].text, "translation");
  assert.equal(
    JSON.stringify(lyrics).includes("dangerouslySetInnerHTML"),
    false,
  );
});

test("comments normalize author/time/count and preserve unsafe-looking content as text data", async () => {
  const catalog = new NcmCatalogService(
    new FakeCatalogClient(),
    credentialsForOwnerOne(),
  );
  const result = await catalog.getComments({
    resourceType: "song",
    resourceId: "801",
    mode: "latest",
    limit: 10,
  });
  assert.equal(result.items[0].text, "<b>kept as text</b>");
  assert.equal(result.items[0].likedCount, 3);
  assert.equal(result.items[0].authorName, "Commenter");
});

test("artwork metadata accepts public HTTP(S) only and rejects local or credential-bearing URLs", () => {
  assert.equal(
    safePublicHttpUrl("https://music.126.net/cover.jpg"),
    "https://music.126.net/cover.jpg",
  );
  assert.equal(safePublicHttpUrl("data:image/png;base64,AAAA"), null);
  assert.equal(safePublicHttpUrl("javascript:alert(1)"), null);
  assert.equal(safePublicHttpUrl("http://127.0.0.1:3456/cover.jpg"), null);
  assert.equal(
    safePublicHttpUrl("https://example.com/cover.jpg?token=secret"),
    null,
  );
});

test("private FM, cloud, and mutation operations stay bound to the authenticated owner", async () => {
  const client = new FakeCatalogClient();
  const catalog = new NcmCatalogService(client, credentialsForOwnerOne());
  assert.equal(
    (await catalog.getFm(1)).items[0].sourceRef,
    "music://ncm/track/801",
  );
  assert.equal(
    (await catalog.getCloud(1, { limit: 10 })).items[0].sourceRef,
    "music://ncm/track/801",
  );
  assert.deepEqual(await catalog.dislikeFm(1, "801"), { accepted: true });
  assert.deepEqual(await catalog.likeTrack(1, "801", true), { liked: true });
  assert.deepEqual(
    await catalog.likeComment(1, {
      resourceType: "song",
      resourceId: "801",
      commentId: "901",
      liked: true,
    }),
    { liked: true },
  );
  await assert.rejects(
    () => catalog.getFm(2),
    (error) =>
      error instanceof NcmProviderError && error.code === "NCM_NOT_LOGGED_IN",
  );
  await assert.rejects(
    () => catalog.getCloud(2, { limit: 10 }),
    (error) =>
      error instanceof NcmProviderError && error.code === "NCM_NOT_LOGGED_IN",
  );
  await assert.rejects(
    () => catalog.likeTrack(2, "801", true),
    (error) =>
      error instanceof NcmProviderError && error.code === "NCM_NOT_LOGGED_IN",
  );
  await assert.rejects(
    () =>
      catalog.likeComment(2, {
        resourceType: "song",
        resourceId: "801",
        commentId: "901",
        liked: true,
      }),
    (error) =>
      error instanceof NcmProviderError && error.code === "NCM_NOT_LOGGED_IN",
  );
});
