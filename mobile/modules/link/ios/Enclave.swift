import CryptoKit
import Foundation
import LocalAuthentication

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

    static func forget() {
        Keys.drop(name)
        Keys.drop(name + ".enrolment")
    }

    /// Face ID's enrolment now. A change voids U (`biometryCurrentSet`); U is then made again, and each Mac, which
    /// still holds the old one, refuses this phone's signatures until it is paired again.
    private static func enrolment() -> Data? {
        let context = LAContext()
        _ = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        return context.evaluatedPolicyDomainState
    }

    private static func key() throws -> SecureEnclave.P256.Signing.PrivateKey {
        if let sealed = try Keys.get(name) {
            // Only a known enrolment that differs voids U: none read now (Face ID briefly unavailable) keeps it.
            let had = try Keys.get(name + ".enrolment"), now = enrolment()
            if let had, let now, had != now {
                forget()
            } else {
                if had == nil, let now { try Keys.put(name + ".enrolment", now) }
                return try .init(dataRepresentation: sealed)
            }
        }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error)
        else { throw error!.takeRetainedValue() as Error }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        try Keys.put(name, key.dataRepresentation)
        if let now = enrolment() { try Keys.put(name + ".enrolment", now) }
        return key
    }
}
