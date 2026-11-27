import Foundation
import Security

/// The phone's own secrets (its Noise key, each Mac's psk, U's sealed handle), in this phone's Keychain only:
/// never synced, never in a backup, readable only while the phone is unlocked.
enum Keys {
    private static let service = "sh.brigadier.mobile"

    private static func query(_ name: String) -> [CFString: Any] {
        [kSecClass: kSecClassGenericPassword, kSecAttrService: service, kSecAttrAccount: name]
    }

    private static func check(_ status: OSStatus) throws {
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    /// nil only when there is no such item; any other failure throws, so a locked or busy Keychain is never
    /// taken for a missing key (which would make a new one over the old).
    static func get(_ name: String) throws -> Data? {
        var out: CFTypeRef?
        var q = query(name)
        q[kSecReturnData] = true
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        try check(status)
        return out as? Data
    }

    /// Writes in place, so a failed write never loses the value already there.
    static func put(_ name: String, _ data: Data) throws {
        let status = SecItemUpdate(query(name) as CFDictionary, [kSecValueData: data] as CFDictionary)
        if status != errSecItemNotFound { return try check(status) }
        var q = query(name)
        q[kSecValueData] = data
        q[kSecAttrAccessible] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
        try check(SecItemAdd(q as CFDictionary, nil))
    }

    static func drop(_ name: String) {
        SecItemDelete(query(name) as CFDictionary)
    }
}
