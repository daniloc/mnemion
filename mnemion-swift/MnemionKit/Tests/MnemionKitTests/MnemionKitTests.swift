import Foundation
import Testing
@testable import MnemionKit

@Suite struct PKCETests {
    @Test func rfc7636AppendixBVector() {
        // RFC 7636 Appendix B: the S256 challenge for this verifier.
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        #expect(pkce.challenge == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    }

    @Test func generatedVerifierIsURLSafeAndLongEnough() {
        let v = PKCE().verifier
        #expect(v.count >= 43)
        #expect(v.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" })
    }
}

@Suite struct OAuthTests {
    let oauth = OAuthClient(configuration: .init(clientName: "Test", redirectURI: URL(string: "com.example.app:/oauth/callback")!))

    @Test func normalizesHiveURLs() {
        #expect(OAuthClient.hiveURL(from: "hive.example.dev")?.absoluteString == "https://hive.example.dev")
        #expect(OAuthClient.hiveURL(from: " https://hive.example.dev/some/path?x=1 ")?.absoluteString == "https://hive.example.dev")
        #expect(OAuthClient.hiveURL(from: "http://localhost:8787")?.absoluteString == "http://localhost:8787")
        #expect(OAuthClient.hiveURL(from: "http://hive.example.dev") == nil) // plaintext only for local dev
        #expect(OAuthClient.hiveURL(from: "") == nil)
    }

    @Test func authorizeURLCarriesPKCEAndState() throws {
        let req = oauth.authorizationRequest(hive: URL(string: "https://hive.example.dev")!, clientID: "abc")
        let items = Dictionary(uniqueKeysWithValues: (URLComponents(url: req.url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        #expect(req.url.path == "/authorize")
        #expect(items["code_challenge_method"] == "S256")
        #expect(items["code_challenge"] == req.pkce.challenge)
        #expect(items["redirect_uri"] == "com.example.app:/oauth/callback")
        #expect(items["state"] == req.state)
        #expect(items["client_id"] == "abc")
    }

    @Test func callbackWithWrongStateIsRejected() async {
        let req = oauth.authorizationRequest(hive: URL(string: "https://hive.example.dev")!, clientID: "abc")
        await #expect(throws: AuthError.self) {
            try await oauth.exchange(callback: URL(string: "com.example.app:/oauth/callback?code=x&state=forged")!, for: req)
        }
    }

    @Test func memberComesFromTokenPrefix() {
        let c = Credentials(hiveURL: URL(string: "https://h")!, clientID: "c", accessToken: "sam:grant:secret", refreshToken: nil, expiresAt: .now)
        #expect(c.member == "sam")
    }

    @Test func formEncodingEscapesReservedCharacters() {
        #expect(OAuthClient.formEncode(["a": "x y&z=1", "b": "c:/d"]) == "a=x%20y%26z%3D1&b=c%3A%2Fd")
    }
}

@Suite struct ModelTests {
    @Test func decodesQueryRowsWithDynamicFacets() throws {
        let json = #"{"id":11,"title":"Build","status":"open","links":null,"version":2,"created_by":"owner","archived_at":null}"#
        let e = try JSONDecoder().decode(Entry.self, from: Data(json.utf8))
        #expect(e.id == 11)
        #expect(e.version == 2)
        #expect(e.string("title") == "Build")
        #expect(e.string("links") == nil)
        #expect(e.createdBy == "owner")
        #expect(!e.isArchived)
    }

    @Test func decodesIndexFacets() throws {
        let json = #"{"patterns":[{"name":"projects","description":"d","doctrine":null,"facets":[{"name":"status","type":"select","required":true,"default":"incubating","options":["active","incubating"]}],"entry_count":3,"latest_activity":null}]}"#
        let index = try JSONDecoder().decode(HiveIndex.self, from: Data(json.utf8))
        let status = try #require(index.pattern("projects")?.facet("status"))
        #expect(status.required)
        #expect(status.options == ["active", "incubating"])
        #expect(status.defaultValue == "incubating")
    }

    @Test func linkRowMapsBothEnds() throws {
        let json = #"{"id":4,"source_pattern":"project-tasks","source_id":11,"target_pattern":"projects","target_id":1,"label":"belongs-to"}"#
        let link = try #require(Link(try JSONDecoder().decode(Entry.self, from: Data(json.utf8))))
        #expect(link.source == EntryRef(pattern: "project-tasks", id: 11))
        #expect(link.target.description == "projects/1")
    }

    @Test func decodesLiveDelta() throws {
        let json = #"{"type":"changed","patterns":["project-tasks"],"delta":{"pattern":"project-tasks","op":"update","id":11,"entry":{"id":11,"status":"done"}}}"#
        let change = try JSONDecoder().decode(HiveChange.self, from: Data(json.utf8))
        #expect(change.touches("project-tasks"))
        #expect(change.delta?.entry?.string("status") == "done")
    }

    @Test func integralNumbersEncodeAsIntegers() throws {
        let data = try JSONEncoder().encode(["id": JSONValue(integerLiteral: 7)])
        #expect(String(decoding: data, as: UTF8.self) == #"{"id":7}"#)
    }
}
