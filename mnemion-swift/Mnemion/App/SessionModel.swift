import AuthenticationServices
import MnemionKit
import SwiftUI

/// Who is signed in to which hive. Owns the OAuth flow and the keychain item;
/// hands a `PortfolioStore` to the signed-in UI.
@MainActor @Observable
final class SessionModel {
    enum Phase {
        case signedOut
        case signedIn(PortfolioStore)
    }

    private(set) var phase: Phase = .signedOut
    var hiveInput: String {
        didSet { UserDefaults.standard.set(hiveInput, forKey: Self.hiveKey) }
    }
    var signInError: String?
    private(set) var isSigningIn = false

    /// The bundle id doubles as the OAuth callback scheme, so a fork that changes
    /// the bundle id gets a matching redirect URI without touching code.
    private static let bundleID = Bundle.main.bundleIdentifier ?? "com.danilocampos.mnemion"
    private static let hiveKey = "hiveURL"
    private let oauth = OAuthClient(configuration: OAuthConfiguration(
        clientName: "Mnemion for Apple platforms",
        redirectURI: URL(string: "\(SessionModel.bundleID):/oauth/callback")!))
    private let keychain = KeychainStore(service: SessionModel.bundleID)

    init() {
        hiveInput = UserDefaults.standard.string(forKey: Self.hiveKey) ?? ""
        if let saved = keychain.load() { phase = .signedIn(makeStore(saved)) }
    }

    var credentials: Credentials? {
        if case .signedIn(let store) = phase { return store.credentials }
        return nil
    }

    func signIn(using web: WebAuthenticationSession) async {
        guard let hive = OAuthClient.hiveURL(from: hiveInput) else {
            signInError = AuthError.invalidHiveURL.localizedDescription
            return
        }
        isSigningIn = true
        signInError = nil
        defer { isSigningIn = false }
        do {
            let clientID = try await registeredClient(for: hive)
            let request = oauth.authorizationRequest(hive: hive, clientID: clientID)
            // Ephemeral: the hive keeps /authorize state server-side, so no cookie
            // needs to survive, and passkeys are system credentials either way.
            let callback = try await web.authenticate(
                using: request.url,
                callbackURLScheme: oauth.configuration.callbackScheme,
                preferredBrowserSession: .ephemeral)
            let credentials = try await oauth.exchange(callback: callback, for: request)
            try keychain.save(credentials)
            hiveInput = hive.absoluteString
            phase = .signedIn(makeStore(credentials))
        } catch let error as AuthError where error.isInvalidClient {
            forgetClient(for: hive)
            signInError = "The hive no longer recognizes this app's registration. Try again to re-register."
        } catch let error as ASWebAuthenticationSessionError where error.code == .canceledLogin {
            // user dismissed the sheet
        } catch {
            signInError = error.localizedDescription
        }
    }

    func signOut() {
        keychain.delete()
        phase = .signedOut
    }

    private func makeStore(_ credentials: Credentials) -> PortfolioStore {
        let tokens = TokenStore(credentials: credentials, oauth: oauth, keychain: keychain) { [weak self] in
            Task { @MainActor in self?.sessionEnded() }
        }
        return PortfolioStore(client: HiveClient(baseURL: credentials.hiveURL, tokens: tokens), credentials: credentials)
    }

    private func sessionEnded() {
        phase = .signedOut
        signInError = AuthError.signedOut.localizedDescription
    }

    // A public client's registration isn't secret; reuse it per hive so each
    // sign-in doesn't mint another client record.
    private func registeredClient(for hive: URL) async throws -> String {
        let key = "oauthClient:\(hive.absoluteString)"
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = try await oauth.register(hive: hive)
        UserDefaults.standard.set(id, forKey: key)
        return id
    }

    private func forgetClient(for hive: URL) {
        UserDefaults.standard.removeObject(forKey: "oauthClient:\(hive.absoluteString)")
    }
}
