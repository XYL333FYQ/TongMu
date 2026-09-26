# Frontend experience integration — 2026-09-22

## Implemented

- Home is a room hall backed by the existing `/api/rooms` endpoint. The standalone room list and embedded hall share the same implementation, search, mode filter, list/tile selection, error state and retry action.
- Room creation observes the current user, pending status and server creation policy. Room-ID entry preserves the existing room authorization flow. Returning to an active room uses the existing global return control; the duplicate home button was removed.
- Desktop navigation uses the existing room-exit guard. Compact headers avoid overlapping controls at narrow widths.
- Room controls use one mounted set of panels with accessible tabs. Hidden panels retain their local inputs and music audio element; keyboard arrows/Home/End select tools. Chat remains beside the player on desktop and uses the existing mobile drawer.
- Add-content source buttons reuse the existing resolver forms and source permission/mount filters. No additional provider, quality policy or media protocol was introduced.
- Content cards retain blur, theme colors and wallpaper, with an opacity floor: 82% plus 18% of the existing glass-strength setting (92.8% at the default setting). Fullscreen background overrides remain intact.

## Verification

- Frontend build and 30 frontend unit tests passed.
- The 32 existing Chromium cases were exercised across media, music/NCM, room permissions, release stability, observability and voice: 31 ultimately passed, 1 optional cache case skipped by existing configuration.
- First media run: 23 pass, 1 skip, 1 Jellyfin rate-limit failure. The Jellyfin case passed independently without changing rate limits.
- First remaining-room run: 6 pass, 1 test still expected the hidden movie list. Added explicit tab navigation; that case passed independently.
- Added an assertion to the existing music case that tab changes retain the same connected, loaded audio element; passed.
- Interactive browser checks passed for creation, search, mode filter, service-error/retry recovery, input retention, keyboard tab navigation, and hall widths 320/390/768/1280. Room width 320 had no document overflow. Light/dark screenshots were inspected.
- Changed Home, RoomsList, RoomLayout and Header lint passed. MoviePushPanel retains the same pre-existing effect-state error and hook-dependency warning as HEAD; unrelated formatting/logic was preserved. This is not a claim of clean repository-wide lint.
- Browser checks used the isolated `.e2e-runtime` database via `scripts/start-e2e.js`; production `config/` was not changed. No commit or push.

## Remaining product scope

Playback history, favorites, a standalone music destination, and notification/privacy preference controls were not included because the current client has no backing preferences for them. SyncTV client P2P and live publishing remain separate product decisions. Existing Docker release and real-account/device verification gates are unaffected by this frontend work.

## Layout refinement after in-app browser review

- Header uses equal left/right grid tracks so navigation is centered on the viewport regardless of account label width. Server connection, CLI download and project link live in the account menu. Desktop account/admin routes are not duplicated in that menu; mobile retains them.
- Removed the redundant Explore action, room-list navigation entry, duplicate admin button, home return button and feature-description card. Home intro and room-ID join share equal desktop columns and align with the room list.
- Room discovery adds host-online filtering and recent activity/newest/most viewers sorting. Room metadata uses aligned label/value columns and reports offline hosts explicitly.
- In-app browser measured header center offset 0 and document overflow 0 at widths 320, 390, 768, 1024 and 1440. Guest/admin layouts, account-menu tools, search, sorting control and online-filter empty state were inspected. Three desktop cards had identical widths/heights/top positions.
- Refined files pass ESLint; frontend production build passes. Media behavior was not changed or re-tested in this layout-only follow-up.
- Current isolated preview uses http://127.0.0.1:15173/ because port 5173 belongs to another project.

## In-app browser redesign and interaction pass — 2026-09-23

- Added a role-aware left workspace rail for Home, room discovery, Profile and Admin. Mobile uses the same routes in a drawer. The fixed header has equal side tracks and a viewport-centered room search; the user chip and theme control stay balanced on the right.
- Expanded the desktop home hero to 220px minimum and kept create-room and room-number join actions in matching columns. Discovery stays embedded below the hero, with shared URL search, type filters, online-host filter, sorting and list/tile views. Profile content uses a wider, aligned header.
- Kept glass cards readable over wallpaper at the configured default: about 92.8% surface opacity; the navigation rail uses a 93% surface mix. Room cards use real room metadata; the room API has no poster artwork field to display.
- Built-in browser checks covered 320, 390, 768, 1024, 1280 and 1440px widths. Header center offset and horizontal overflow were both zero at every width. Sidebar and search visibility matched their desktop/mobile breakpoints. The mobile drawer opened, navigated and closed correctly.
- Interacted with Home/create/join, discovery search/filter/sort/view/refresh, Profile edit and mount dialogs, Admin tabs/views/settings, room tabs/source choices, chat send mode, room chat, leave-room guard, theme/account menus, voice and traffic panels, and Together Listen search, queue add/remove, play/pause and play-mode controls. A local fixture was removed from the test queue after playback checks. The NCM public search returned results; lyrics/comments and both comment sort controls were opened.
- Browser QA found that NCM hot comments use `hotComments` while latest comments use `comments`. The catalog now maps the provider hot list into the shared page shape, and clears an old catalog error after a successful lyrics/comments retry. Browser verification returned 20 hot comments without the stale error. A backend regression test covers the hot-response shape.
- Frontend build and focused ESLint pass. Backend build and all 9 tests in `phase5b2b-ncm-catalog.test.js` pass. The production build still reports the existing Mediabunny dynamic-import and large-chunk warnings.
- UI checks ran against `.e2e-runtime/test.sqlite`; it contains the local room/chat interaction fixture. No media upload, credential submission, microphone permission or room access-policy change was performed. Real account playback and device permissions remain unverified.

## Settings and mobile layout continuation — 2026-09-23

- Added `/settings` with real, existing account, room-player and appearance preferences. Account editing stays in Profile; playback options stay in the room so they cannot override synchronized room state. Unimplemented notification, privacy and language controls are not presented as working switches.
- Moved theme controls from the one-off header popover into Appearance. Kept the centered desktop search grid; explicitly placed the account/return-room group in the right grid track on mobile. The active-room shortcut now lives in the header and no longer floats over page headings.
- Settings appearance controls reuse the persisted theme store, including dark mode, seed colors, radius, glass opacity/blur, motion options and the existing custom-background panel. Browser QA exercised each control type and restored the original values; the background source tabs opened without uploading a file or applying a background.
- Built-in browser verified Settings sections, Profile navigation, room return, mobile navigation to `/rooms` and back to Settings. Final viewport checks at 320, 390, 640, 768, 1024, 1280 and 1440px had zero document overflow; the centered search had zero offset when shown and did not overlap the account controls. The settings category strip scrolls internally without a visible scrollbar.
- Frontend production build and targeted ESLint for App, Header, navigation, room-return action and SettingsPage pass. Build retains the existing Mediabunny dynamic-import and large-chunk warnings.
