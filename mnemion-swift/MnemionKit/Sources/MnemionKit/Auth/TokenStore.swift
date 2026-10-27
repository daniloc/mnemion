import Foundation

/// Hands out a valid access token, refreshing it at most once at a time no
/// matter how many requests ask concurrently. Persists every rotation, and
/// reports sign-out (refresh refused) so the app can return to the sign-in screen.
public actor TokenStore {
    private var credentials: Credentials
    private var refreshing: Task<Credentials, Error>?
    private let oauth: OAuthClient
    private let keychain: KeychainStore
    private let onSignedOut: @Sendable () -> Void

    public init(credentials: Credentials, oauth: OAuthClient, keychain: KeychainStore, onSignedOut: @escaping @Sendable () -> Void) {
        self.credentials = credentials
        self.oauth = oauth
        self.keychain = keychain
        self.onSignedOut = onSignedOut
    }

    public var current: Credentials { credentials }

    /// A token good for at least the next minute.
    public func accessToken() async throws -> String {
        if credentials.expiresAt.timeIntervalSinceNow > 60 { return credentials.accessToken }
        return try await refresh().accessToken
    }

    /// Force a refresh (after a 401 on a token we believed valid).
    public func refreshAfterRejection(of token: String) async throws -> String {
        if token != credentials.accessToken { return credentials.accessToken } // someone already rotated it
        return try await refresh().accessToken
    }

    private func refresh() async throws -> Credentials {
        if let refreshing { return try await refreshing.value }
        // Another surface (the share extension, an App Intent, the app itself)
        // may have rotated the shared item since we loaded it; adopt its grant
        // rather than spend a refresh token the provider has already retired.
        if let saved = keychain.load(), saved.accessToken != credentials.accessToken, saved.hiveURL == credentials.hiveURL {
            credentials = saved
            if saved.expiresAt.timeIntervalSinceNow > 60 { return saved }
        }
        let task = Task { [oauth, credentials] in try await oauth.refresh(credentials) }
        refreshing = task
        defer { refreshing = nil }
        do {
            let fresh = try await task.value
            credentials = fresh
            try? keychain.save(fresh)
            return fresh
        } catch let error as AuthError where error.endsSession {
            // The grant is gone (revoked, expired, client registration dropped).
            // Transport failures and 5xx fall through untouched: offline ≠ signed out.
            // One exception: another surface (the share extension, an App Intent)
            // may have rotated the shared item while this refresh was in flight,
            // retiring the token we just presented. Adopt its grant and go on;
            // delete the item only when the keychain still holds the refused grant.
            if let rotated = rotatedElsewhere() { return rotated }
            // The other surface may be saving right now: look once more before deleting.
            try? await Task.sleep(for: .milliseconds(200))
            if let rotated = rotatedElsewhere() { return rotated }
            signOut()
            throw AuthError.signedOut
        }
    }

    /// The keychain's grant when another surface rotated it while this refresh was in flight.
    private func rotatedElsewhere() -> Credentials? {
        guard let saved = keychain.load(), saved.hiveURL == credentials.hiveURL,
              saved.refreshToken != credentials.refreshToken || saved.accessToken != credentials.accessToken else { return nil }
        credentials = saved
        return saved
    }

    private func signOut() {
        keychain.delete()
        onSignedOut()
    }
}
