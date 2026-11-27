import CryptoKit
import Foundation

/// U, the phone's Secure Enclave P-256 key. Every signature asks for Face ID: `biometryCurrentSet` (a new face or
/// finger enrolled voids it) and no reuse window, so a live session alone never signs anything.
enum Enclave {
    private static let name = "u"

    /// U's public key (SEC1, uncompressed), made on first use.
    static func publicKey() throws -> Data {
        try key().publicKey.x963Representation
    }

    /// Signs `label ‖ data` (ECDSA P-256, SHA-256) as raw r‖s, after Face ID.
    static func sign(_ label: String, _ data: Data) throws -> Data {
        try key().signature(for: Data(label.utf8) + data).rawRepresentation
    }

    static func forget() { Keys.drop(name) }

    private static func key() throws -> SecureEnclave.P256.Signing.PrivateKey {
        if let sealed = try Keys.get(name) { return try .init(dataRepresentation: sealed) }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error)
        else { throw error!.takeRetainedValue() as Error }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        try Keys.put(name, key.dataRepresentation)
        return key
    }
}
