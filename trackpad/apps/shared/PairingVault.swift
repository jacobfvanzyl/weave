import Foundation
import Security
import TrackpadCore

/// One non-synchronizing Keychain item. macOS uses the login Keychain's signing-
/// identity access control; iOS uses its app-private data-protection Keychain.
/// Read failures never create a new identity or fall back to another store.
@MainActor
final class PairingVault {
    private struct Contents: Codable {
        var id = UUID()
        var peers: [PairedPeer] = []
    }
    private var contents: Contents
    var id: UUID { contents.id }
    var peers: [PairedPeer] { contents.peers }
    private static var query: [String: Any] {
        var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "com.veezee.trackpad.pairing.v1", kSecAttrAccount as String: "installation"]
        #if os(macOS)
        // The local companion is not profile-provisioned. The login Keychain
        // supports signed Mac apps without adding a restricted access-group
        // entitlement and an expiring Mac development provisioning profile.
        query[kSecUseDataProtectionKeychain as String] = false
        #endif
        return query
    }
    init() throws {
        var query = Self.query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound {
            contents = Contents()
            try save(contents, adding: true)
        } else {
            guard status == errSecSuccess, let data = item as? Data else { throw VaultError(status: status) }
            contents = try JSONDecoder().decode(Contents.self, from: data)
            guard contents.peers.allSatisfy({ $0.secret.count == 32 }) else { throw VaultError(status: errSecDecode) }
        }
    }
    func peer(id: UUID) -> PairedPeer? { contents.peers.first { $0.id == id } }
    func peer(serial: String) -> PairedPeer? { contents.peers.first { $0.usbSerial == serial } }
    func remember(_ peer: PairedPeer) throws {
        guard peer.secret.count == 32 else { throw VaultError(status: errSecParam) }
        var next = contents
        next.peers.removeAll { $0.id == peer.id || (peer.usbSerial != nil && $0.usbSerial == peer.usbSerial) }
        next.peers.append(peer)
        try save(next); contents = next
    }
    func forget(id: UUID) throws {
        var next = contents; next.peers.removeAll { $0.id == id }
        try save(next); contents = next
    }
    private func save(_ contents: Contents, adding: Bool = false) throws {
        let data = try JSONEncoder().encode(contents)
        let status: OSStatus
        if adding {
            var query = Self.query
            query[kSecValueData as String] = data
            #if !os(macOS)
            query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            #endif
            status = SecItemAdd(query as CFDictionary, nil)
        } else {
            status = SecItemUpdate(Self.query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        }
        guard status == errSecSuccess else { throw VaultError(status: status) }
    }
    private struct VaultError: LocalizedError {
        let status: OSStatus
        var errorDescription: String? { "Pairing storage is unavailable (Keychain \(status)). Unlock this device and try again." }
    }
}
