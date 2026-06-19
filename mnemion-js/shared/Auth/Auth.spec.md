# Auth

Credential primitives — multi-member passkeys and scoped access/register tokens — isolated as pure db-accessor functions.

## works when
- credentials.ts exists at this node
- passkey.ts exists at this node
- passkey.ts imports @simplewebauthn/server

## why

Auth primitives (passkeys + access/register/auth tokens) are isolated as pure db-accessor functions so credential concerns stay separate from the cognitive substrate; the multi-row passkey model (one credential per member, NULL = bootstrap owner) exists because one shared hive is authenticated into by several people each acting as themselves. `resolveRegisterToken` deliberately re-validates scope/owner/roster at setup/consume time — independent of how the token's fields were set — because an adversarial review showed mint-time checks alone could be bypassed by a post-create constraints update to mount an owner-takeover, and a malformed member-less token must be unusable rather than defaulting to the owner sentinel.

Access tokens are stored HASHED at rest (`hashToken`, SHA-256): `findAccessToken` hashes the presented value and compares digests, mint stores only the digest (the raw token is shown once), and a boot migration hashes any legacy plaintext token in place. So a read of an `_access_tokens` row — a `query`, a `search` hit, a leaked DO snapshot — discloses only a digest, never a usable bearer. This is a deliberate exception to "store truth once": the secret's preimage is never persisted, which neuters the entire "a token reached a read sink" class independent of which sink leaks. Because the column holds a digest, every lookup that needs the token is async (`crypto.subtle.digest`), which is why these accessors return Promises.
