import CryptoKit
import Foundation

/// The keys and codes the phone derives exactly as the Mac does (msgs/remote-wire.md): HKDF-SHA256 with no salt.
enum Derive {
    static func hkdf(_ ikm: [UInt8], _ info: String) -> [UInt8] {
        HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: ikm), info: Array(info.utf8), outputByteCount: 32)
            .withUnsafeBytes { Array($0) }
    }

    /// The psk of a QR offer, from its secret `s`.
    static func qr(_ secret: [UInt8]) -> [UInt8] { hkdf(secret, "brigadier/pair/qr/v1") }

    /// The psk of a typed code, already uppercased with `-` and spaces dropped and I/L/O read as 1/1/0.
    static func code(_ code: String) -> [UInt8] { hkdf(Array(code.utf8), "brigadier/pair/code/v1") }

    /// The psk this phone signs in with from now on, from the pairing's handshake hash.
    static func device(_ h: [UInt8]) -> [UInt8] { hkdf(h, "brigadier/device/v1") }

    /// The 6 digits both sides show while pairing.
    static func check(_ h: [UInt8]) -> String {
        let d = Array(SHA256.hash(data: Array("brigadier/check/v1".utf8) + h))
        let n = (UInt32(d[0]) << 24 | UInt32(d[1]) << 16 | UInt32(d[2]) << 8 | UInt32(d[3])) % 1_000_000
        return String(format: "%06u", n)
    }

    /// What an action's signature covers after its label `brigadier/act/v1` (msgs/remote-wire.md, fresh signatures):
    /// this stream's `h`, the Mac's nonce, session, request and action each as a 4-byte big-endian length then UTF-8,
    /// then SHA-256 of the command's argv exactly as sent (compact JSON).
    static func act(h: [UInt8], nonce: [UInt8], names: [String], argv: String) -> [UInt8] {
        var out = h + nonce
        for name in names {
            let b = Array(name.utf8), n = UInt32(b.count)
            out += [UInt8(n >> 24), UInt8(n >> 16 & 0xff), UInt8(n >> 8 & 0xff), UInt8(n & 0xff)] + b
        }
        return out + Array(SHA256.hash(data: Array(argv.utf8)))
    }

    static func base64url(_ s: String) -> [UInt8]? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t).map(Array.init)
    }
}
