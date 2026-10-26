import Foundation

/// How this app identifies itself to a hive's OAuth 2.1 provider.
public struct OAuthConfiguration: Sendable {
    public var clientName: String
    /// The custom-scheme callback the hive redirects to after the passkey ceremony.
    public var redirectURI: URL
    public var scope: String

    public init(clientName: String, redirectURI: URL, scope: String = "read write") {
        self.clientName = clientName
        self.redirectURI = redirectURI
        self.scope = scope
    }

    /// The scheme `ASWebAuthenticationSession` intercepts.
    public var callbackScheme: String { redirectURI.scheme ?? "" }
}

/// What persists between launches: which hive, which registered client, and the
/// current token pair. Lives in the Keychain, never in defaults.
public struct Credentials: Codable, Sendable, Equatable {
    public var hiveURL: URL
    public var clientID: String
    public var accessToken: String
    public var refreshToken: String?
    public var expiresAt: Date

    /// The member the grant authenticates as. The provider's access-token format
    /// is `userId:grantId:secret`, and `userId` is the member label.
    public var member: String? {
        let first = accessToken.split(separator: ":", maxSplits: 1).first.map(String.init)
        return first?.isEmpty == false ? first : nil
    }
}

/// One in-flight authorization: the URL to open, and what the callback must match.
public struct AuthorizationRequest: Sendable {
    public let url: URL
    public let hiveURL: URL
    public let clientID: String
    let state: String
    let pkce: PKCE
}

public enum AuthError: LocalizedError, Sendable {
    case invalidHiveURL
    case registrationFailed(String)
    case callbackMismatch
    case authorizationDenied(String)
    case tokenRequestFailed(code: String, description: String?)
    case signedOut

    public var errorDescription: String? {
        switch self {
        case .invalidHiveURL: return "That doesn't look like a hive URL (expected https://…)."
        case .registrationFailed(let m): return "The hive refused client registration: \(m)"
        case .callbackMismatch: return "The sign-in response didn't match the request. Try again."
        case .authorizationDenied(let m): return "Sign-in was refused: \(m)"
        case .tokenRequestFailed(let code, let d): return "Token request failed (\(code))\(d.map { ": \($0)" } ?? "")"
        case .signedOut: return "Your session has ended. Sign in again."
        }
    }

    /// The registration expired or was dropped server-side (the provider's DCR
    /// records carry a TTL); the fix is to register again, not to retry.
    public var isInvalidClient: Bool {
        if case .tokenRequestFailed(let code, _) = self { return code == "invalid_client" }
        return false
    }

    /// The grant can't be recovered by retrying; only a fresh sign-in will do.
    public var endsSession: Bool {
        switch self {
        case .signedOut: return true
        case .tokenRequestFailed(let code, _): return code == "invalid_grant" || code == "invalid_client"
        default: return false
        }
    }
}

/// The OAuth 2.1 + PKCE public-client flow against a hive: dynamic client
/// registration, the authorize URL (passkey-first page, rendered by the hive), the
/// code exchange, and refresh. Stateless; callers own persistence.
public struct OAuthClient: Sendable {
    public let configuration: OAuthConfiguration
    let session: URLSession

    public init(configuration: OAuthConfiguration, session: URLSession = .shared) {
        self.configuration = configuration
        self.session = session
    }

    /// Normalizes user input ("my.hive.dev", "https://my.hive.dev/") to an origin.
    public static func hiveURL(from input: String) -> URL? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return nil }
        if !s.contains("://") { s = "https://" + s }
        guard var comps = URLComponents(string: s), let host = comps.host, !host.isEmpty,
              comps.scheme == "https" || (comps.scheme == "http" && Self.isLocal(host)) else { return nil }
        comps.path = ""
        comps.query = nil
        comps.fragment = nil
        return comps.url
    }

    static func isLocal(_ host: String) -> Bool {
        host == "localhost" || host == "127.0.0.1" || host.hasSuffix(".localhost")
    }

    /// RFC 7591 dynamic registration as a public client.
    public func register(hive: URL) async throws -> String {
        var req = URLRequest(url: hive.appending(path: "register"))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: [
            "client_name": configuration.clientName,
            "redirect_uris": [configuration.redirectURI.absoluteString],
            "token_endpoint_auth_method": "none",
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        ])
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status),
              let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let clientID = obj["client_id"] as? String else {
            throw AuthError.registrationFailed(String(decoding: data, as: UTF8.self))
        }
        return clientID
    }

    public func authorizationRequest(hive: URL, clientID: String) -> AuthorizationRequest {
        let pkce = PKCE()
        let state = PKCE.randomURLSafe(bytes: 16)
        var comps = URLComponents(url: hive.appending(path: "authorize"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [
            .init(name: "response_type", value: "code"),
            .init(name: "client_id", value: clientID),
            .init(name: "redirect_uri", value: configuration.redirectURI.absoluteString),
            .init(name: "scope", value: configuration.scope),
            .init(name: "state", value: state),
            .init(name: "code_challenge", value: pkce.challenge),
            .init(name: "code_challenge_method", value: "S256"),
        ]
        return AuthorizationRequest(url: comps.url!, hiveURL: hive, clientID: clientID, state: state, pkce: pkce)
    }

    /// Exchange the callback's authorization code for tokens.
    public func exchange(callback: URL, for request: AuthorizationRequest) async throws -> Credentials {
        let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func item(_ name: String) -> String? { items.first { $0.name == name }?.value }
        if let error = item("error") {
            throw AuthError.authorizationDenied(item("error_description") ?? error)
        }
        guard item("state") == request.state, let code = item("code") else { throw AuthError.callbackMismatch }
        return try await tokenRequest(hive: request.hiveURL, clientID: request.clientID, form: [
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": configuration.redirectURI.absoluteString,
            "client_id": request.clientID,
            "code_verifier": request.pkce.verifier,
        ], previousRefreshToken: nil)
    }

    /// Refresh rotates the refresh token; the provider still honors the previous
    /// one once, so a crash between response and persist doesn't sign us out.
    public func refresh(_ credentials: Credentials) async throws -> Credentials {
        guard let refreshToken = credentials.refreshToken else { throw AuthError.signedOut }
        return try await tokenRequest(hive: credentials.hiveURL, clientID: credentials.clientID, form: [
            "grant_type": "refresh_token",
            "refresh_token": refreshToken,
            "client_id": credentials.clientID,
        ], previousRefreshToken: refreshToken)
    }

    private func tokenRequest(hive: URL, clientID: String, form: [String: String], previousRefreshToken: String?) async throws -> Credentials {
        var req = URLRequest(url: hive.appending(path: "token"))
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data(Self.formEncode(form).utf8)
        let (data, response) = try await session.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard (200..<300).contains(status), let access = obj["access_token"] as? String else {
            throw AuthError.tokenRequestFailed(
                code: obj["error"] as? String ?? "http_\(status)",
                description: obj["error_description"] as? String)
        }
        let expiresIn = (obj["expires_in"] as? NSNumber)?.doubleValue ?? 3600
        return Credentials(
            hiveURL: hive,
            clientID: clientID,
            accessToken: access,
            refreshToken: obj["refresh_token"] as? String ?? previousRefreshToken,
            expiresAt: Date().addingTimeInterval(expiresIn))
    }

    static func formEncode(_ form: [String: String]) -> String {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        return form.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }
            .joined(separator: "&")
    }
}
