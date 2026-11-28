import CryptoKit
import Foundation
import Network

/// One encrypted stream to a Mac: TCP, each Noise message behind a 2-byte big-endian length. Above the handshake it
/// carries plain bytes both ways; the frames inside them are the shared client's (app/shared/client.ts).
final class Channel {
    /// `refused`: a Mac was reached but no message 2 opened (no open offer, another psk, an unknown device).
    enum Failure: Error { case unreachable, refused, closed }
    static let service = "_brigadier._tcp"

    let noise: BrigadierNoise
    let mac: [UInt8]
    /// Where this stream reached the Mac, as "ip:port", for signing in again when Bonjour can't find it.
    let address: String?
    private let conn: NWConnection
    private let queue: DispatchQueue
    var onData: ((Data) -> Void)?
    var onClosed: (() -> Void)?

    private init(_ conn: NWConnection, _ queue: DispatchQueue, _ noise: BrigadierNoise, _ mac: [UInt8]) {
        (self.conn, self.queue, self.noise, self.mac) = (conn, queue, noise, mac)
        if case let .hostPort(host, port) = conn.currentPath?.remoteEndpoint {
            address = "\(host):\(port)"
        } else {
            address = nil
        }
    }

    /// Tries each target ("ip:port" or "bonjour:<service name>") in order, 3 s each, and returns the first whose
    /// message 2 opens. A Mac that closes the stream or answers with another psk is skipped.
    static func open(_ targets: [String], mac: [UInt8], psk: [UInt8], static key: Curve25519.KeyAgreement.PrivateKey,
                     payload: [UInt8]) async throws -> Channel {
        var reached = false
        for target in targets {
            guard let to = endpoint(target) else { continue }
            let queue = DispatchQueue(label: "sh.brigadier.link")
            let conn = NWConnection(to: to, using: .tcp)
            let deadline = DispatchWorkItem { conn.cancel() }
            queue.asyncAfter(deadline: .now() + 3, execute: deadline)
            do {
                try await ready(conn, queue)
                reached = true
                let noise = try BrigadierNoise(staticKey: key, macKey: mac, psk: psk)
                conn.send(content: framed(try noise.start(payload)), completion: .idempotent)
                _ = try noise.finish(try await message(conn))
                deadline.cancel()
                return Channel(conn, queue, noise, mac)
            } catch {
                deadline.cancel()
                conn.cancel()
            }
        }
        throw reached ? Failure.refused : Failure.unreachable
    }

    /// Seals `plain` into transport messages and sends them, in order.
    func write(_ plain: [UInt8]) throws {
        for at in stride(from: 0, to: plain.count, by: BrigadierNoise.maxPlain) {
            let sealed = try noise.seal(Array(plain[at..<min(at + BrigadierNoise.maxPlain, plain.count)]))
            conn.send(content: Self.framed(sealed), completion: .contentProcessed { [conn] error in
                if error != nil { conn.cancel() }
            })
        }
    }

    func close() { conn.cancel() }

    /// Reads until the stream ends, once `onData` and `onClosed` are set; a failed write or `close` ends it too.
    func run() {
        Task {
            while let m = try? await Self.message(conn) {
                // A message that doesn't open means the stream can't be trusted any more.
                guard let plain = try? noise.open(m) else { break }
                onData?(Data(plain))
            }
            close()
            onClosed?()
        }
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

    private static func message(_ conn: NWConnection) async throws -> [UInt8] {
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
