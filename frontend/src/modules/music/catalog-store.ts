import { create } from 'zustand'
import type {
  MusicCatalogAlbum,
  MusicCatalogArtistDetail,
  MusicCatalogCommentPage,
  MusicCatalogLyrics,
  MusicCatalogPage,
  MusicCatalogPlaylist,
  MusicCatalogPlaylistDetail,
  MusicCatalogSearchItem,
  MusicCatalogSearchType,
  MusicCatalogTrack,
} from './catalog-types'

export type NcmCatalogView =
  'search' | 'playlists' | 'albums' | 'artists' | 'liked' | 'fm' | 'cloud'

export interface NcmCatalogStoreState {
  accountId: string | null
  generation: number
  view: NcmCatalogView
  searchType: MusicCatalogSearchType
  searchQuery: string
  searchResults: MusicCatalogPage<MusicCatalogSearchItem> | null
  privateItems: Array<MusicCatalogTrack | MusicCatalogPlaylist>
  privatePage: MusicCatalogPage<MusicCatalogTrack | MusicCatalogPlaylist> | null
  playlistDetail: MusicCatalogPlaylistDetail | null
  albumDetail: MusicCatalogAlbum | null
  artistDetail: MusicCatalogArtistDetail | null
  lyrics: Record<string, MusicCatalogLyrics>
  comments: Record<string, MusicCatalogCommentPage>
  loading: boolean
  error: string | null
  setAccount: (accountId: string | null) => void
  resetForAccount: (accountId: string | null) => void
  clearPrivate: () => void
  setView: (view: NcmCatalogView) => void
  setSearchType: (searchType: MusicCatalogSearchType) => void
  setSearchQuery: (searchQuery: string) => void
  setSearchResults: (
    results: MusicCatalogPage<MusicCatalogSearchItem> | null
  ) => void
  setPrivatePage: (
    page: MusicCatalogPage<MusicCatalogTrack | MusicCatalogPlaylist> | null
  ) => void
  setPlaylistDetail: (detail: MusicCatalogPlaylistDetail | null) => void
  setAlbumDetail: (detail: MusicCatalogAlbum | null) => void
  setArtistDetail: (detail: MusicCatalogArtistDetail | null) => void
  setLyrics: (trackId: string, lyrics: MusicCatalogLyrics) => void
  setComments: (key: string, comments: MusicCatalogCommentPage) => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

function emptyPrivateState() {
  return {
    privateItems: [] as Array<MusicCatalogTrack | MusicCatalogPlaylist>,
    privatePage: null as MusicCatalogPage<
      MusicCatalogTrack | MusicCatalogPlaylist
    > | null,
  }
}

export const useNcmCatalogStore = create<NcmCatalogStoreState>()((set) => ({
  accountId: null,
  generation: 0,
  view: 'search',
  searchType: 'song',
  searchQuery: '',
  searchResults: null,
  ...emptyPrivateState(),
  playlistDetail: null,
  albumDetail: null,
  artistDetail: null,
  lyrics: {},
  comments: {},
  loading: false,
  error: null,
  setAccount: (accountId) => set({ accountId }),
  resetForAccount: (accountId) =>
    set((state) => ({
      accountId,
      generation: state.generation + 1,
      searchResults: null,
      ...emptyPrivateState(),
      playlistDetail: null,
      albumDetail: null,
      artistDetail: null,
      lyrics: {},
      comments: {},
      error: null,
    })),
  clearPrivate: () =>
    set((state) => ({
      generation: state.generation + 1,
      ...emptyPrivateState(),
      playlistDetail: null,
      albumDetail: null,
      artistDetail: null,
    })),
  setView: (view) => set({ view, error: null }),
  setSearchType: (searchType) =>
    set({ searchType, searchResults: null, error: null }),
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchResults: (searchResults) => set({ searchResults, error: null }),
  setPrivatePage: (privatePage) =>
    set({ privatePage, privateItems: privatePage?.items || [], error: null }),
  setPlaylistDetail: (playlistDetail) =>
    set({ playlistDetail, albumDetail: null, artistDetail: null, error: null }),
  setAlbumDetail: (albumDetail) =>
    set({ albumDetail, playlistDetail: null, artistDetail: null, error: null }),
  setArtistDetail: (artistDetail) =>
    set({ artistDetail, playlistDetail: null, albumDetail: null, error: null }),
  setLyrics: (trackId, lyrics) =>
    set((state) => ({ lyrics: { ...state.lyrics, [trackId]: lyrics } })),
  setComments: (key, comments) =>
    set((state) => ({ comments: { ...state.comments, [key]: comments } })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
}))
