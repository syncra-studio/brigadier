import CryptoKit
import Foundation
import Security

/// A notification from a Mac, sealed to this phone (relay-wire rev 4): HPKE base mode with CryptoKit's
/// Curve25519_SHA256_ChachaPoly to the key N, info "brigadier/push/v1" + the device id. Shared by the app, which makes
/// N, and the notification extension, which opens each push; only Apple's CryptoKit (D74).
struct Sealed {
    /// The session's title, its kind ("needs", "done" or "failed"), its id and the Mac's counter.
    struct Note: Decodable {
        let t: String
        let k: String
        let s: String
        let n: UInt64
    }

    let key: Curve25519.KeyAgreement.PrivateKey
    let device: String
    let words: [String: String]

    /// The app's own Keychain group, which the extension's entitlement names too.
    static let group = (Bundle.main.object(forInfoDictionaryKey: "BrigadierKeychainGroup") as? String) ?? ""
    private static let query: [CFString: Any] = [kSecClass: kSecClassGenericPassword, kSecAttrService: "sh.brigadier.mobile",
                                                 kSecAttrAccount: "push", kSecAttrAccessGroup: group]

    private struct Kept: Codable {
        let k: Data
        let d: String
        let w: [String: String]
    }

    /// What the app kept, or nil. Readable after the first unlock, so a push to a locked phone still opens.
    static func kept() -> Sealed? {
        var q = query
        q[kSecReturnData] = true
        var out: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data,
              let kept = try? JSONDecoder().decode(Kept.self, from: data),
              let key = try? Curve25519.KeyAgreement.PrivateKey(rawRepresentation: kept.k) else { return nil }
        return Sealed(key: key, device: kept.d, words: kept.w)
    }

    /// N as kept, made the first time; the device id and words are written anew each time.
    static func keep(device: String, words: [String: String]) throws -> Curve25519.KeyAgreement.PrivateKey {
        let key = kept()?.key ?? Curve25519.KeyAgreement.PrivateKey()
        let data = try JSONEncoder().encode(Kept(k: key.rawRepresentation, d: device, w: words))
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData] = data
        q[kSecAttrAccessible] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
        return key
    }

    /// `e`, the encapsulated key (32 bytes) then the ciphertext, opened to its note. CryptoKit's HPKE starts at iOS 17.
    @available(iOS 17, macOS 14, *)
    static func open(_ e: Data, key: Curve25519.KeyAgreement.PrivateKey, device: String) throws -> Note {
        guard e.count > 32 else { throw CryptoKitError.incorrectParameterSize }
        var recipient = try HPKE.Recipient(privateKey: key, ciphersuite: .Curve25519_SHA256_ChachaPoly,
                                           info: Data("brigadier/push/v1".utf8) + Data(device.utf8),
                                           encapsulatedKey: e.prefix(32))
        return try JSONDecoder().decode(Note.self, from: recipient.open(e.dropFirst(32)))
    }
}
