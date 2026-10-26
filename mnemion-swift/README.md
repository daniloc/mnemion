# Mnemion for Apple platforms

A native SwiftUI client for a Mnemion hive. iPhone and iPad first, with the
same sources building for Mac and Vision Pro. Shared logic lives in
`MnemionKit`, which also declares watchOS for the companion to come.

This app is a client. The Cloudflare Worker is the single source of truth.
There is no local replica and no sync engine: reads go to `/api/*`, writes go
to `/api/mutate`, and the `/ws` change stream keeps the screen current with
writes from anywhere (web UI, agents over MCP, other devices).

## Layout

```
project.yml            XcodeGen spec (Mnemion.xcodeproj is generated, gitignored)
Mnemion/               the app target: SwiftUI views + observable models
  App/SessionModel     sign-in state, OAuth flow, keychain
  App/PortfolioStore   projects + linked tasks, writes, live updates
  Views/               SignIn, Projects (split view), ProjectDetail, TaskEditor
MnemionKit/            platform-neutral Swift package (Foundation + Security only)
  Auth/                PKCE, OAuthClient (DCR, authorize, exchange, refresh),
                       TokenStore (single-flight refresh), KeychainStore
  HiveClient           /api/index, query, mutate, resolve, links
  LiveEvents           /ws change stream with reconnect
  Portfolio            projects ← belongs-to ← tasks, projects → serves → goals,
                       and the alignment read (projects serving no goal)
```

## Auth

The app is an OAuth 2.1 public client of the hive. It authenticates the same
way MCP clients do:

1. It registers itself with dynamic client registration (`POST /register`,
   `token_endpoint_auth_method: none`). The `client_id` is cached per hive.
   The registration expires server-side after 90 days, and the app
   re-registers when that happens.
2. `ASWebAuthenticationSession` opens the hive's own `/authorize` page in an
   ephemeral session. That page asks for a passkey first and accepts the
   master secret as a fallback. PKCE uses S256.
3. The hive redirects to `<bundle-id>:/oauth/callback`. The app exchanges the
   code at `/token` and stores the token pair in the data-protection keychain
   (this-device-only).
4. Every request to `/api/*` or `/ws` carries `Authorization: Bearer`. The
   worker validates it at the router's `Auth.SESSION` gate (see the
   `session bearer gate` invariant in `mnemion-js/shared/Routing/Routing.spec.md`).
   The gate also checks on every request that the member is still active, so
   suspending a member cuts off their phone immediately.

Writes are attributed to the member whose passkey approved the grant. That is
the same `created_by`/`updated_by` stamping the web app and MCP get.

## Build and run

```bash
cd mnemion-swift
xcodegen generate
open Mnemion.xcodeproj
```

To run on a device or a Mac, set your team in `project.yml` (`DEVELOPMENT_TEAM`)
or in Xcode's Signing pane. The bundle id is also the OAuth callback scheme, so
changing it needs no code changes.

### Against a local hive

```bash
cd mnemion-js && npm run dev:worker     # DEV=true: /authorize auto-approves as owner
```

In the simulator, sign in to `http://localhost:4281`. Plain HTTP is accepted
only for localhost.

### Tests

```bash
cd mnemion-swift/MnemionKit
swift test --scratch-path /tmp/mnemionkit-build
```

`--scratch-path` keeps build products outside `~/Documents`. Extended
attributes set there (iCloud file provider) make `codesign` reject the test
bundle.

## Next

The hive's open project tasks pick up from here:

- frictionless idea capture (`tasks/41`)
- daily cockpit (`tasks/42`)
- Watch companion (`tasks/43`)

The Watch app will need a keychain access group (`KeychainStore(accessGroup:)`)
or WatchConnectivity to share the session.
