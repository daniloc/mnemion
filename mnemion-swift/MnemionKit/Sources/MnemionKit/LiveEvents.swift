import Foundation

/// A `/ws` broadcast. Every write anywhere in the hive — this app, the web UI,
/// any agent over MCP — announces which patterns changed; single-entry writes
/// carry a granular delta.
public struct HiveChange: Decodable, Sendable {
    public let patterns: [String]
    public let delta: Delta?
    /// Not from the hive: the stream came back after a gap. Whatever was written
    /// during the gap was never announced, so the reader must refetch everything.
    public private(set) var reconnected = false

    enum CodingKeys: String, CodingKey { case patterns, delta }

    static var afterGap: HiveChange {
        var change = HiveChange(patterns: [], delta: nil)
        change.reconnected = true
        return change
    }

    private init(patterns: [String], delta: Delta?) {
        self.patterns = patterns
        self.delta = delta
    }

    public struct Delta: Decodable, Sendable {
        public let pattern: String
        public let op: String
        public let id: Int?
        public let entry: Entry?
    }

    public func touches(_ pattern: String) -> Bool { patterns.contains(pattern) }
}

extension HiveClient {
    /// Live changes for as long as the stream is consumed. Reconnects with a fresh
    /// token after drops (3 s back-off, like the web app), announcing each return
    /// with `reconnected`; ends when the consumer cancels or the session is signed out.
    public func changes() -> AsyncStream<HiveChange> {
        AsyncStream { continuation in
            let task = Task {
                var hadSocket = false
                while !Task.isCancelled {
                    do {
                        try await self.pump(into: continuation, hadSocket: &hadSocket)
                    } catch let error as AuthError where error.endsSession {
                        break
                    } catch {
                        // dropped / offline: back off and reconnect
                    }
                    try? await Task.sleep(for: .seconds(3))
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// How often an idle socket is checked. A sleeping Mac or a changed network can
    /// leave a socket dead with no error, and `receive` would wait on it for ever.
    private static let heartbeat: Duration = .seconds(25)

    private func pump(into continuation: AsyncStream<HiveChange>.Continuation, hadSocket: inout Bool) async throws {
        var comps = URLComponents(url: baseURL.appending(path: "ws"), resolvingAgainstBaseURL: false)!
        comps.scheme = comps.scheme == "http" ? "ws" : "wss"
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(try await tokens.accessToken())", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: req)
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }
        // The first pong proves the socket is open: only then is a refetch safe,
        // since anything written after it will be announced here.
        try await Self.ping(socket)
        if hadSocket { continuation.yield(.afterGap) }
        hadSocket = true
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                while true {
                    let message = try await socket.receive()
                    let data: Data
                    switch message {
                    case .string(let s): data = Data(s.utf8)
                    case .data(let d): data = d
                    @unknown default: continue
                    }
                    if let change = try? JSONDecoder().decode(HiveChange.self, from: data) {
                        continuation.yield(change)
                    }
                }
            }
            group.addTask {
                while true {
                    try await Task.sleep(for: Self.heartbeat)
                    try await Self.ping(socket)
                }
            }
            // Either one failing ends the socket; the caller reconnects.
            defer { group.cancelAll() }
            try await group.next()
        }
    }

    /// A round trip, or an error: no pong within the timeout counts as dead.
    private static func ping(_ socket: URLSessionWebSocketTask) async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            group.addTask {
                try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
                    socket.sendPing { error in
                        if let error { done.resume(throwing: error) } else { done.resume() }
                    }
                }
            }
            group.addTask {
                try await Task.sleep(for: .seconds(10))
                socket.cancel(with: .goingAway, reason: nil) // fails the ping above too
                throw URLError(.timedOut)
            }
            defer { group.cancelAll() }
            try await group.next()
        }
    }
}
