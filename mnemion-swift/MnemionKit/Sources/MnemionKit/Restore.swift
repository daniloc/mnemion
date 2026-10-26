import Foundation

/// The one keychain item every surface of the app shares: the main app signs
/// in and saves it; the share extension and App Intents restore a client from
/// it without a UI. On iOS the item lives in the first keychain access group
/// both targets declare, so the service name is the contract.
public enum SharedSession {
    /// Also the main app's bundle id, so existing installs keep their item.
    public static let keychainService = "com.danilocampos.mnemion"
    public static let clientName = "Mnemion for Apple platforms"

    public static func keychain() -> KeychainStore {
        KeychainStore(service: keychainService)
    }
}

extension HiveClient {
    /// A client for the signed-in hive, from the shared keychain item; nil when
    /// nobody is signed in. `callbackURI` is the OAuth redirect the main app
    /// registered (its bundle id as the scheme), needed only to refresh.
    public static func restored(callbackURI: URL) -> HiveClient? {
        let keychain = SharedSession.keychain()
        guard let credentials = keychain.load() else { return nil }
        let oauth = OAuthClient(configuration: OAuthConfiguration(clientName: SharedSession.clientName, redirectURI: callbackURI))
        let tokens = TokenStore(credentials: credentials, oauth: oauth, keychain: keychain, onSignedOut: {})
        return HiveClient(baseURL: credentials.hiveURL, tokens: tokens)
    }
}
