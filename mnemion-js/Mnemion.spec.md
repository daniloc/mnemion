# Mnemion

Cloudflare Worker entry: an OAuth-wrapped MCP server whose one declarative route table is the whole HTTP surface.

## trust levels
- owner-trusted: Owner kernel access — the ownerDataCtx capability (the only trusted:true reader/writer).
- storage: The SQLite / R2 substrate beneath every chart.
- served-untrusted: Public reads + ingress/upload writes — the servedDataCtx capability (trusted:false).
- public-egress: Served HTTP responses (/o /p /f) and the /ws broadcast — leaves the DO in the clear.
- agent-mcp: The MCP tool surface — agent input, consent-gated, never trusted with the kernel.
- federated: Cross-hive resolve over the network — a sovereign foreign hive.

## entrances
- patch coherence scope: A maintainer's package installation applies the Scope browser-bundle fix for Coherence 1.7.1.
  handler: scripts/patch-coherence-scope.mjs
  trust: owner-trusted
- coherence hooks: A maintainer installs or checks the Claude and Codex Coherence hooks.
  handler: scripts/coherence-hooks.mjs
  trust: owner-trusted
- invariant mutation probe: The maintainer runs the invariant mutation probe command.
  handler: scripts/invariant-mutation-probe.mjs
  trust: owner-trusted
- mcp smoke: The maintainer runs the mcp smoke command.
  handler: scripts/mcp-smoke.mjs
  trust: owner-trusted
- set format: The maintainer runs the set format command.
  handler: scripts/set-format.mjs
  trust: owner-trusted
- set view: The maintainer runs the set view command.
  handler: scripts/set-view.mjs
  trust: owner-trusted
- ui rework: The maintainer runs the ui rework command.
  handler: scripts/ui-rework.mjs
  trust: owner-trusted
- ws watch: The maintainer runs the ws watch command.
  handler: scripts/ws-watch.mjs
  trust: owner-trusted
- authorize: A client request enters the authorize route.
  handler: authorize
  trust: served-untrusted
- auth verify: A client request enters the auth verify route.
  handler: authVerify
  trust: served-untrusted
- setup page: A client request enters the setup page route.
  handler: setupPage
  trust: served-untrusted
- setup begin: A client request enters the setup begin route.
  handler: setupBegin
  trust: served-untrusted
- setup complete: A client request enters the setup complete route.
  handler: setupComplete
  trust: served-untrusted
- passkey begin: A client request enters the passkey begin route.
  handler: passkeyBegin
  trust: served-untrusted
- passkey complete: A client request enters the passkey complete route.
  handler: passkeyComplete
  trust: served-untrusted
- invite page: A client request enters the invite page route.
  handler: invitePage
  trust: served-untrusted
- invite begin: A client request enters the invite begin route.
  handler: inviteBegin
  trust: served-untrusted
- invite complete: A client request enters the invite complete route.
  handler: inviteComplete
  trust: served-untrusted
- login page: A client request enters the login page route.
  handler: loginPage
  trust: served-untrusted
- login begin: A client request enters the login begin route.
  handler: loginBegin
  trust: served-untrusted
- login complete: A client request enters the login complete route.
  handler: loginComplete
  trust: served-untrusted
- login verify: A client request enters the login verify route.
  handler: loginVerify
  trust: served-untrusted
- revoke sessions: A client request enters the revoke sessions route.
  handler: revokeSessions
  trust: served-untrusted
- serve shared entry: A client request enters the serve shared entry route.
  handler: serveSharedEntry
  trust: served-untrusted
- serve output: A client request enters the serve output route.
  handler: serveOutput
  trust: served-untrusted
- serve publication: A client request enters the serve publication route.
  handler: servePublication
  trust: served-untrusted
- receive input: A client request enters the receive input route.
  handler: receiveInput
  trust: served-untrusted
- upload: A client request enters the upload route.
  handler: upload
  trust: served-untrusted
- export pattern: A client request enters the export pattern route.
  handler: exportPattern
  trust: served-untrusted
- query index: A client request enters the query index route.
  handler: queryIndex
  trust: served-untrusted
- query tools: A client request enters the query tools route.
  handler: queryTools
  trust: served-untrusted
- query entries: A client request enters the query entries route.
  handler: queryEntries
  trust: served-untrusted
- query history: A client request enters the query history route.
  handler: queryHistory
  trust: served-untrusted
- query label: A client request enters the query label route.
  handler: queryLabel
  trust: served-untrusted
- mutate entry: A client request enters the mutate entry route.
  handler: mutateEntry
  trust: served-untrusted
- evolve schema: A client request enters the evolve schema route.
  handler: evolveSchema
  trust: served-untrusted
- live socket: A client request enters the live socket route.
  handler: liveSocket
  trust: served-untrusted
- resolve uri: A client request enters the resolve uri route.
  handler: resolveUri
  trust: served-untrusted
- seed test data: A client request enters the seed test data route.
  handler: seedTestData
  trust: served-untrusted
- seed vectors: A client request enters the seed vectors route.
  handler: seedVectors
  trust: served-untrusted
- seed marketplace: A client request enters the seed marketplace route.
  handler: seedMarketplace
  trust: served-untrusted
- marketplace token: A client request enters the marketplace token route.
  handler: marketplaceToken
  trust: served-untrusted
- marketplace git: A client request enters the marketplace git route.
  handler: marketplaceGit
  trust: served-untrusted
