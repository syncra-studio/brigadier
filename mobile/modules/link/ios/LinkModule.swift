import CryptoKit
import ExpoModulesCore
import LocalAuthentication
import UIKit

public class LinkModule: Module {
    /// The one stream to a Mac the app has open.
    private var channel: Channel?

    public func definition() -> ModuleDefinition {
        Name("Link")
        Events("data", "closed")

        Constant("screen") { UserDefaults.standard.string(forKey: "screen") }
        Constant("build") { Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "" }

        AsyncFunction("unlock") { (reason: String, promise: Promise) in
            LAContext().evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, _ in promise.resolve(ok) }
        }

        AsyncFunction("browse") { (ms: Int) in await Channel.browse(ms) }

        // mode "qr" (secret: the QR's `s`), "code" (secret: the normalised code) or "device" (the saved psk). Returns
        // `check`, the 6 digits, or `error`: "unreachable" or "refused" (a Mac answered, but not with this psk).
        AsyncFunction("connect") { (mode: String, mac: String, targets: [String], secret: String?) -> [String: String] in
            self.drop()
            guard let macKey = Derive.base64url(mac), macKey.count == 32 else { throw Exception(name: "Mac", description: "bad key") }
            let psk: [UInt8]
            var payload: [String: Any] = ["mode": mode]
            switch mode {
            case "qr":
                guard let s = secret.flatMap(Derive.base64url) else { throw Exception(name: "Mac", description: "bad secret") }
                psk = Derive.qr(s)
            case "code":
                psk = Derive.code(secret ?? "")
            default:
                guard let saved = try Keys.get("psk:" + mac) else { throw Exception(name: "Mac", description: "not paired") }
                psk = Array(saved)
            }
            if mode != "device" {
                // `name` is just "iPhone" since iOS 16; the Mac shows it in its Allow question.
                let (name, model, os) = await MainActor.run { () -> (String, String, String) in
                    let d = UIDevice.current
                    return (d.name, d.model, "iOS " + d.systemVersion)
                }
                (payload["name"], payload["model"], payload["os"]) = (name, model, os)
                payload["u"] = try Enclave.publicKey().base64EncodedString()
            }
            let channel: Channel
            do {
                channel = try await Channel.open(targets, mac: macKey, psk: psk, static: try Self.staticKey(),
                                                 payload: Array(try JSONSerialization.data(withJSONObject: payload)))
            } catch Channel.Failure.refused {
                return ["error": "refused"]
            } catch Channel.Failure.unreachable {
                return ["error": "unreachable"]
            }
            channel.onData = { data in self.sendEvent("data", ["b": data.base64EncodedString()]) }
            channel.onClosed = { [weak channel] in
                guard self.channel === channel else { return }
                self.channel = nil
                self.sendEvent("closed")
            }
            self.channel = channel
            channel.run()
            return ["check": Derive.check(channel.noise.h)]
        }

        // Synchronous, so writes keep the order JS made them in.
        Function("write") { (b64: String) in
            guard let channel = self.channel, let plain = Data(base64Encoded: b64) else { throw Exception(name: "Mac", description: "not connected") }
            try channel.write(Array(plain))
        }

        Function("close") { self.drop() }

        // U's signature over this stream's handshake hash, after Face ID: the `sig` of pairing and signing in.
        AsyncFunction("sign") { () -> String in
            guard let channel = self.channel else { throw Exception(name: "Mac", description: "not connected") }
            return try Enclave.sign("brigadier/hello/v1", Data(channel.noise.h)).base64EncodedString()
        }

        // Keeps the Mac this stream paired with: its psk from the handshake hash, and its record in the list.
        AsyncFunction("save") { (name: String, device: String, addresses: [String]) -> String in
            guard let channel = self.channel else { throw Exception(name: "Mac", description: "not connected") }
            let pk = Self.base64url(channel.mac)
            try Keys.put("psk:" + pk, Data(Derive.device(channel.noise.h)))
            let mac: [String: Any] = ["pk": pk, "name": name, "device": device,
                                      "addresses": ([channel.address].compactMap { $0 } + addresses).reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }]
            try Self.putMacs(try Self.macs().filter { $0["pk"] as? String != pk } + [mac])
            return pk
        }

        AsyncFunction("macs") { () -> [[String: Any]] in try Self.macs() }

        AsyncFunction("forget") { (pk: String) in
            try Self.putMacs(try Self.macs().filter { $0["pk"] as? String != pk })
            Keys.drop("psk:" + pk)
        }
    }

    private func drop() {
        channel?.onClosed = nil
        channel?.close()
        channel = nil
    }

    /// The phone's Noise static key, made once.
    private static func staticKey() throws -> Curve25519.KeyAgreement.PrivateKey {
        if let raw = try Keys.get("x") { return try .init(rawRepresentation: raw) }
        let key = Curve25519.KeyAgreement.PrivateKey()
        try Keys.put("x", key.rawRepresentation)
        return key
    }

    private static func macs() throws -> [[String: Any]] {
        guard let data = try Keys.get("macs") else { return [] }
        return try JSONSerialization.jsonObject(with: data) as? [[String: Any]] ?? []
    }

    private static func putMacs(_ macs: [[String: Any]]) throws {
        try Keys.put("macs", try JSONSerialization.data(withJSONObject: macs))
    }

    private static func base64url(_ b: [UInt8]) -> String {
        Data(b).base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
