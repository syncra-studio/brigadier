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

    /// Signs `label ‖ data` (ECDSA P-256, SHA-256) as raw r‖s, after Face ID: the system's own, or `context`'s
    /// when the caller has just asked it (once: a context is never kept).
    static func sign(_ label: String, _ data: Data, context: LAContext? = nil) throws -> Data {
        try key(context).signature(for: Data(label.utf8) + data).rawRepresentation
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

    private static func key(_ context: LAContext? = nil) throws -> SecureEnclave.P256.Signing.PrivateKey {
        if let sealed = try Keys.get(name) {
            // U made with no record beside it is from before the record and may be void: made again. An empty record
            // (Face ID unreadable when U was made) takes today's; none read now (briefly unavailable) keeps U.
            let had = try Keys.get(name + ".enrolment"), now = enrolment()
            if let had, now == nil || had == now || had.isEmpty {
                if had.isEmpty, let now { try Keys.put(name + ".enrolment", now) }
                return try .init(dataRepresentation: sealed, authenticationContext: context)
            }
            forget()
        }
        var error: Unmanaged<CFError>?
        guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, [.privateKeyUsage, .biometryCurrentSet], &error)
        else { throw error!.takeRetainedValue() as Error }
        let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
        try Keys.put(name, key.dataRepresentation)
        try Keys.put(name + ".enrolment", enrolment() ?? Data())
        return key
    }
}
