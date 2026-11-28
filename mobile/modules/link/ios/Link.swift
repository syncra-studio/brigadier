import CryptoKit
import Foundation
import Network

/// One encrypted stream to a Mac: TCP, each Noise message behind a 2-byte big-endian length, or the relay's WebSocket,
/// one binary message per Noise message (relay-wire). Above the handshake it carries plain bytes both ways; the frames
/// inside them are the shared client's (app/shared/client.ts).
final class Channel {
    /// `refused`: a Mac was reached but no message 2 opened (no open offer, another psk, an unknown device), or the
    /// relay refused this phone's token or invite. `offline`: the relay has no computer; when it last had one (unix s).
    enum Failure: Error { case unreachable, refused, closed, offline(Int) }
    static let service = "_brigadier._tcp"

    let noise: BrigadierNoise
    let mac: [UInt8]
    let relayed: Bool
    /// Where this stream reached the Mac, as "ip:port", for signing in again when Bonjour can't find it.
    let address: String?
    private let conn: NWConnection
    private let queue: DispatchQueue
    var onData: ((Data) -> Void)?
    var onClosed: (() -> Void)?

    private init(_ conn: NWConnection, _ queue: DispatchQueue, _ noise: BrigadierNoise, _ mac: [UInt8], relayed: Bool) {
        (self.conn, self.queue, self.noise, self.mac, self.relayed) = (conn, queue, noise, mac, relayed)
        // The relay's own address is no way to the Mac.
        if !relayed, case let .hostPort(host, port) = conn.currentPath?.remoteEndpoint {
            address = "\(host):\(port)"
        } else {
            address = nil
        }
    }

    /// Tries each target in order and returns the first whose message 2 opens: "ip:port" or "bonjour:<service name>",
    /// 3 s each, or the relay's phone socket ("ws(s)://…/v1/phone?key=…&until=…&sig=…"), shown `ticket` (hex) first.
    /// With a relay in the list the direct ones share 1.5 s, so a Mac away from home is soon reached through it. A Mac
    /// that closes the stream or answers with another psk is skipped; one that never answers in time is only unreachable.
    static func open(_ targets: [String], mac: [UInt8], psk: [UInt8], static key: Curve25519.KeyAgreement.PrivateKey,
                     payload: [UInt8], ticket: String) async throws -> Channel {
        var reached = false
        var seen: Int?
        let started = Date(), viaRelay = targets.contains(where: isRelay)
        for target in targets {
            let relayed = isRelay(target)
            let wait = relayed ? 8 : viaRelay ? 1.5 + started.timeIntervalSinceNow : 3
            guard wait > 0, let conn = connection(target) else { continue }
            let queue = DispatchQueue(label: "sh.brigadier.link")
            // Set on `queue` before the cancel whose failure it explains: a stream nobody answered isn't a refusal.
            let late = Flag()
            let deadline = DispatchWorkItem { late.set = true; conn.cancel() }
            queue.asyncAfter(deadline: .now() + wait, execute: deadline)
            var open = false
            do {
                try await ready(conn, queue)
                if relayed { try await hello(conn, ticket) }
                open = true
                let noise = try BrigadierNoise(staticKey: key, macKey: mac, psk: psk)
                put(conn, relayed, try noise.start(payload))
                _ = try noise.finish(try await message(conn, relayed))
                deadline.cancel()
                return Channel(conn, queue, noise, mac, relayed: relayed)
            } catch {
                deadline.cancel()
                conn.cancel()
                switch error {
                case Failure.refused: reached = true
                case let Failure.offline(at): seen = at
                case Failure.unreachable: break
                // The Mac closed it or its message 2 didn't open: another psk, an unknown phone, no open offer.
                default: if open && !queue.sync(execute: { late.set }) { reached = true }
                }
            }
        }
        if reached { throw Failure.refused }
        throw seen.map(Failure.offline) ?? Failure.unreachable
    }

    /// The typed code's offer at the first of `relays` (their "ws(s)://host" addresses) that holds it: the computer's Noise
    /// key `m` and the pass to its room, with `url` added; nil when none does.
    static func find(_ relays: [String], code: String) async -> [String: Any]? {
        let id = Derive.hex(Derive.lookup(code))
        let session = URLSession(configuration: .ephemeral)
        defer { session.finishTasksAndInvalidate() }
        for relay in relays {
            // "ws://…" and "wss://…" become "http://…" and "https://…".
            guard let url = URL(string: "http" + relay.dropFirst(2) + "/v1/lookup/" + id) else { continue }
            guard let (data, response) = try? await session.data(for: URLRequest(url: url, timeoutInterval: 5)),
                  (response as? HTTPURLResponse)?.statusCode == 200,
                  var found = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
            found["url"] = relay
            return found
        }
        return nil
    }

    /// Seals `plain` into transport messages and sends them, in order.
    func write(_ plain: [UInt8]) throws {
        for at in stride(from: 0, to: plain.count, by: BrigadierNoise.maxPlain) {
            Self.put(conn, relayed, try noise.seal(Array(plain[at..<min(at + BrigadierNoise.maxPlain, plain.count)])))
        }
    }

    func close() { conn.cancel() }

    /// Reads until the stream ends, once `onData` and `onClosed` are set; a failed write or `close` ends it too.
    func run() {
        Task {
            while let m = try? await Self.message(conn, relayed) {
                // A message that doesn't open means the stream can't be trusted any more.
                guard let plain = try? noise.open(m) else { break }
                onData?(Data(plain))
            }
            close()
            onClosed?()
        }
    }

    private static func isRelay(_ target: String) -> Bool { target.hasPrefix("ws://") || target.hasPrefix("wss://") }

    private static func connection(_ target: String) -> NWConnection? {
        guard isRelay(target) else { return endpoint(target).map { NWConnection(to: $0, using: .tcp) } }
        guard let url = URL(string: target) else { return nil }
        // TLS is Apple's own here too (D74); plain ws:// is only the local relay's.
        let parameters = NWParameters(tls: target.hasPrefix("wss://") ? NWProtocolTLS.Options() : nil)
        let ws = NWProtocolWebSocket.Options()
        ws.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(ws, at: 0)
        return NWConnection(to: .url(url), using: parameters)
    }

    private static func endpoint(_ target: String) -> NWEndpoint? {
        if target.hasPrefix("bonjour:") {
            return .service(name: String(target.dropFirst(8)), type: service, domain: "local.", interface: nil)
        }
        guard let colon = target.lastIndex(of: ":"), let port = NWEndpoint.Port(String(target[target.index(after: colon)...]))
        else { return nil }
        return .hostPort(host: NWEndpoint.Host(String(target[..<colon])), port: port)
    }

    private static func framed(_ m: [UInt8]) -> Data { Data([UInt8(m.count >> 8), UInt8(m.count & 0xff)] + m) }

    private static func put(_ conn: NWConnection, _ relayed: Bool, _ m: [UInt8], text: Bool = false) {
        let context = relayed ? NWConnection.ContentContext(identifier: "m", metadata: [NWProtocolWebSocket.Metadata(opcode: text ? .text : .binary)])
            : .defaultMessage
        conn.send(content: relayed ? Data(m) : framed(m), contentContext: context, isComplete: true, completion: .contentProcessed { [conn] error in
            if error != nil { conn.cancel() }
        })
    }

    /// The relay's first exchange: this phone's token or invite, then `ok`, or `offline` with when the computer was
    /// last there; 4401 is a refusal, any other close a relay that can't carry the stream now.
    private static func hello(_ conn: NWConnection, _ ticket: String) async throws {
        put(conn, true, Array(#"{"t":"hello","v":"\#(ticket)"}"#.utf8), text: true)
        let (data, meta) = try await receive(conn)
        if meta?.opcode == .close { throw meta?.closeCode == .privateCode(4401) ? Failure.refused : Failure.unreachable }
        let said = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        if said?["t"] as? String == "ok" { return }
        if said?["t"] as? String == "offline" { throw Failure.offline(said?["seen"] as? Int ?? 0) }
        throw Failure.unreachable
    }

    private static func receive(_ conn: NWConnection) async throws -> (Data, NWProtocolWebSocket.Metadata?) {
        try await withCheckedThrowingContinuation { done in
            conn.receiveMessage { data, context, _, error in
                if let error { return done.resume(throwing: error) }
                done.resume(returning: (data ?? Data(), context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata))
            }
        }
    }

    private static func ready(_ conn: NWConnection, _ queue: DispatchQueue) async throws {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<Void, Error>) in
            let answered = Flag()  // only touched on `queue`
            conn.stateUpdateHandler = { state in
                guard !answered.set else { return }
                switch state {
                case .ready: answered.set = true; done.resume()
                case .failed, .cancelled: answered.set = true; done.resume(throwing: Failure.unreachable)
                default: break
                }
            }
            conn.start(queue: queue)
        }
    }

    final class Flag: @unchecked Sendable { var set = false }

    private static func read(_ conn: NWConnection, _ n: Int) async throws -> [UInt8] {
        try await withCheckedThrowingContinuation { done in
            conn.receive(minimumIncompleteLength: n, maximumLength: n) { data, _, _, error in
                if let data, data.count == n { done.resume(returning: Array(data)) } else { done.resume(throwing: error ?? Failure.closed) }
            }
        }
    }

    private static func message(_ conn: NWConnection, _ relayed: Bool) async throws -> [UInt8] {
        while relayed {
            // Only the Mac's own close (1000, its stream's end) is its answer; 4404 is the computer gone, anything else
            // the relay's trouble: neither is a refusal.
            guard let (data, meta) = try? await receive(conn) else { throw Failure.unreachable }
            switch meta?.opcode {
            case .binary?: if !data.isEmpty { return Array(data) } else { throw Failure.closed }
            case .text?, .ping?, .pong?, .cont?: continue  // a later relay may say more; only binary is the Mac's
            case .close?:
                if meta?.closeCode == .privateCode(4404) { throw Failure.offline(0) }
                throw meta?.closeCode == .protocolCode(.normalClosure) ? Failure.closed : Failure.unreachable
            default: throw Failure.unreachable
            }
        }
        let length = try await read(conn, 2)
        let n = Int(length[0]) << 8 | Int(length[1])
        guard n > 0 else { throw Failure.closed }
        return try await read(conn, n)
    }

    /// The Macs offering themselves on this network after `ms`: their service name, `pk` and whether an offer is open;
    /// `denied` when this phone may not use the local network.
    static func browse(_ ms: Int) async -> [String: Any] {
        let queue = DispatchQueue(label: "sh.brigadier.browse")
        let browser = NWBrowser(for: .bonjourWithTXTRecord(type: service, domain: nil), using: .tcp)
        let denied = Flag()  // only touched on `queue`
        browser.stateUpdateHandler = { state in
            switch state {
            case .waiting(.dns(let e)), .failed(.dns(let e)): denied.set = denied.set || e == DNSServiceErrorType(kDNSServiceErr_PolicyDenied)
            default: break
            }
        }
        browser.start(queue: queue)
        try? await Task.sleep(nanoseconds: UInt64(ms) * 1_000_000)
        let found = queue.sync { browser.browseResults }.compactMap { result -> [String: String]? in
            guard case let .service(name, _, _, _) = result.endpoint, case let .bonjour(txt) = result.metadata,
                  let pk = txt["pk"] else { return nil }
            return ["name": name, "pk": pk, "open": txt["o"] == "1" ? "1" : "0"]
        }
        browser.cancel()
        return ["found": found, "denied": queue.sync { denied.set }]
    }
}
