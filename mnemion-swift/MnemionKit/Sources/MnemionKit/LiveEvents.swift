import Foundation

/// A `/ws` broadcast. Every write anywhere in the hive — this app, the web UI,
/// any agent over MCP — announces which patterns changed; single-entry writes
/// carry a granular delta.
public struct HiveChange: Decodable, Sendable {
    public let patterns: [String]
    public let delta: Delta?

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
    /// token after drops (3 s back-off, like the web app); ends when the consumer
    /// cancels or the session is signed out.
    public func changes() -> AsyncStream<HiveChange> {
        AsyncStream { continuation in
            let task = Task {
                while !Task.isCancelled {
                    do {
                        try await self.pump(into: continuation)
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

    private func pump(into continuation: AsyncStream<HiveChange>.Continuation) async throws {
        var comps = URLComponents(url: baseURL.appending(path: "ws"), resolvingAgainstBaseURL: false)!
        comps.scheme = comps.scheme == "http" ? "ws" : "wss"
        var req = URLRequest(url: comps.url!)
        req.setValue("Bearer \(try await tokens.accessToken())", forHTTPHeaderField: "Authorization")
        let socket = session.webSocketTask(with: req)
        socket.resume()
        defer { socket.cancel(with: .goingAway, reason: nil) }
        try await withTaskCancellationHandler {
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
        } onCancel: {
            socket.cancel(with: .goingAway, reason: nil)
        }
    }
}
