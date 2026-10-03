# TongMu final integration review

Reviewed 2026-10-02 against the local read-only `references/ZViewer-main` and
`references/synctv-main` trees and TongMu `fd3dff9`. The reference archives do
not carry Git metadata; their exact upstream commit cannot be certified.

| Area | Adopted or retained behavior | Current evidence / remaining work |
| --- | --- | --- |
| Media providers | SyncTV-style provider registry, bounded client capabilities, private credential ownership | Native storage/media-server/anime/live providers and legacy resolver adapters are in the common registry. Preserve browsing adapters; do not add a second planner. |
| Original quality | TongMu client planner, exact representation candidates, Direct first and Gateway fallback | Media Protocol and frontend media tests cover Direct failures, position and quality preservation, HLS and DASH. No default server video transcoding. |
| Browser resolution | ZViewer browser discovery with safe network boundaries | The latest branch repairs asynchronous fallback, explicit sniff parameters, cancellation and Chromium slot release. Keep BrowserResolver as a supported capability. |
| Realtime | Shared descriptor/generation, serialized mutations and stale-event rejection | `room-experience.service.ts`, REST movie writes and compatibility socket handlers share room serialization. Room tests cover permission revocation while queued, formal transfer and conflicting REST/socket updates. |
| Video and subtitles | ZViewer player adapters plus bounded resource ownership | Player engine, subtitle parsing and generation tests remain. `RoomRuntime.tsx` keeps the room tree mounted across ordinary navigation; explicit leave owns cleanup. Content selection waits for authorized server acknowledgement. |
| Voice | Existing 48kHz/960-sample protocol, server moderation, reconnect cleanup | Existing voice tests remain. Persistent room runtime and local mute cover ordinary page navigation; browser regression covers voice ownership and explicit exit separately from microphone hardware certification. |
| Music | Separate authoritative music domain and NCM catalog/credentials | Activity switching pauses inactive video/music without erasing progress or queues. Queue/timing/generation and NCM catalog/credential tests remain; production does not show test fixture inputs. |
| Room product rules | Existing approvals, password hashing, protected roles and transactional transfer | Public/private discovery, 24-hour empty retention, persistent rooms, collaboration, restricted temporary delegation, content proposals and advisory polls are implemented in the server room policy/experience domain and incremental migration. |
| Shipping | Incremental migrations, protected URLs, signed release inventory and Docker browser gate | Preserve config/volume and update compatibility. This delivery changes deployment to manual-only; pushing main may run tests but must not deploy. |

Deferred: extra upstream providers, distributed PostgreSQL/Redis/gRPC/cluster
deployment, and unreviewed upstream client P2P. These are deliberate scope
boundaries, not features claimed as completed. Existing TongMu screen-sharing
P2P/relay remains supported.

Reference implementations are used for semantics and comparisons only; none
are copied into the product or published. The prior branch delivery's 25
commits are preserved by a fast-forward of main, not repeated cherry-picks.

Verification and new product behavior are reported in the final delivery
record. Simulated viewports do not certify iOS/Android/macOS hardware support,
and passing a build does not certify every network-dependent media source.

Confirmed gaps repaired during this delivery include unlocked legacy/REST
movie mutations, guest grant identity checks, authority checks after queued
updates, player overlays intercepting the empty-stage action, dropdown portals
behind modal overlays, missing form-label associations and narrow activity
toolbar overflow. Each behavior is covered by relevant room or browser
regression rather than inferred from compilation.

Further room regression repairs include a complete member snapshot for every
admitted viewer, including the requesting viewer, without leaking IP addresses,
private guest identity or credentials. The host remains the separate host row;
pending admission requests are not admitted members.

Persistent-room restoration rebuilds cached movies through public DTO mapping
before any admitted socket can read the list. Server-side provider credentials
remain available for authorized playback resolution but cannot appear in that
restored room-visible cache. Owner restoration retains the existing media
selection, activity and saved progress. A late old-socket disconnect rechecks
current host authority under the room lock and cannot clear a returned owner or
restart temporary delegation. The room integration suite covers these paths.

See [the final delivery record](final-delivery.md) for verified counts and open
acceptance evidence. Multiplayer media resolution now uses the same select-content
policy as the room UI, binding JWT identity, active membership and guest identity
to the room grant. New private sources belong to the selecting user; refreshes of
already shared content use only the stored item. Three HTTP integration tests
cover these rules, revocation during upstream work and deleted-item protection.
Complete E2E, screenshots and post-push CI are recorded separately.

The final lifecycle review also repaired a legacy `close-room` race: an old
sharer snapshot taken before formal transfer could previously authorize a
close after the new owner had taken over. Closing now rechecks the live sharer,
membership and durable ownership inside the existing room lock, before any
timer cancellation, playback suspension or session cleanup. Platform
`admin-close-room` uses an explicit force-close path and rechecks the live
administrator role in that same lock; the currently selected host remains the
legacy exempt socket. No nested room lock, new event name or database change is
introduced. The real database/handler regression first failed on the old
implementation and now covers transfer-before-close, role revocation while
queued, ordinary-owner close and administrator compatibility.

Periodic cache cleanup now checks actual connected room membership in addition
to playback-memory state. A room with a freshly created queue and no first
`PlaybackState` must retain that queue; a disconnected database session alone
does not retain runtime caches. The POST-to-cleanup-to-play regression covers
this distinction, including the guest permission rejection.

The most recent targeted backend run after the lifecycle repair was
`backend/test/room-experience.suite.js`: 30 PASS / 0 FAIL. It uses isolated
SQL.js databases, actual room/socket handlers and temporary loopback HTTP
servers; the three resolution tests use real JWT/room grants with a controlled
upstream resolver. It verifies authorization and private-source ownership, not
live provider availability or real Redis deployment. Migration and receipt
counts, the full backend regression, browser-engine results and hardware limits
belong to the final delivery record; earlier totals must not be presented as
results of this new targeted run.
