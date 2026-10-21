import Foundation
import Capacitor
import Security

// This device's P-256 keys, one per paired Host, in the Secure Enclave where there is one and
// otherwise a ThisDeviceOnly Keychain key. Keys never leave the device.
//
// It answers as the weave Host expects (docs/specs/wve-90-remote-clients.md): the public key
// as a JWK, and signatures of a message's UTF-8 bytes as DER ECDSA P-256 SHA-256, in unpadded
// base64url.
@objc(DeviceKeyPlugin)
final class DeviceKeyPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "DeviceKeyPlugin"
    let jsName = "DeviceKey"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sign", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise)
    ]

    private func tag(_ keyId: String) throws -> Data {
        guard keyId.range(of: #"^[A-Za-z0-9._-]{1,120}$"#, options: .regularExpression) != nil else {
            throw NSError(domain: "DeviceKey", code: 1, userInfo: [NSLocalizedDescriptionKey: "The key id is invalid."])
        }
        return Data("dev.weave.device.\(keyId)".utf8)
    }

    private func privateKey(_ keyId: String) throws -> SecKey? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassKey,
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrApplicationTag as String: try tag(keyId),
            kSecReturnRef as String: true
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let key = item else {
            throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
        }
        return (key as! SecKey)
    }

    private func createKey(_ keyId: String, secureEnclave: Bool) throws -> SecKey {
        let access = SecAccessControlCreateWithFlags(
            nil,
            kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            .privateKeyUsage,
            nil
        )!
        var privateAttributes: [String: Any] = [
            kSecAttrIsPermanent as String: true,
            kSecAttrApplicationTag as String: try tag(keyId)
        ]
        if secureEnclave {
            privateAttributes[kSecAttrAccessControl as String] = access
        } else {
            privateAttributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        }
        var attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: privateAttributes
        ]
        if secureEnclave { attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }
        var error: Unmanaged<CFError>?
        guard let key = SecKeyCreateRandomKey(attributes as CFDictionary, &error) else {
            throw error?.takeRetainedValue() ?? NSError(domain: "DeviceKey", code: 2)
        }
        return key
    }

    /// The public key as a JWK. Security gives it as an uncompressed X9.63 point: 04 || x || y.
    private func publicKey(_ privateKey: SecKey) throws -> [String: String] {
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw NSError(domain: "DeviceKey", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not derive the public key."])
        }
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw error?.takeRetainedValue() ?? NSError(domain: "DeviceKey", code: 4)
        }
        let point = [UInt8](data)
        guard point.count == 65, point[0] == 0x04 else {
            throw NSError(domain: "DeviceKey", code: 5, userInfo: [NSLocalizedDescriptionKey: "The public key isn't an uncompressed P-256 point."])
        }
        return [
            "kty": "EC",
            "crv": "P-256",
            "x": Data(point[1..<33]).base64URLEncodedString(),
            "y": Data(point[33..<65]).base64URLEncodedString()
        ]
    }

    @objc func generate(_ call: CAPPluginCall) {
        guard let keyId = call.getString("keyId") else { return call.reject("keyId is required.") }
        do {
            let key: SecKey
            if let existing = try privateKey(keyId) {
                key = existing
            } else {
                do { key = try createKey(keyId, secureEnclave: true) }
                catch { key = try createKey(keyId, secureEnclave: false) }
            }
            call.resolve(["publicKey": try publicKey(key)])
        } catch {
            call.reject("Could not create the device key.", "KEY_GENERATION_FAILED", error)
        }
    }

    @objc func sign(_ call: CAPPluginCall) {
        guard let keyId = call.getString("keyId"), let payload = call.getString("payload") else {
            return call.reject("keyId and payload are required.")
        }
        do {
            guard let key = try privateKey(keyId) else { throw NSError(domain: "DeviceKey", code: 11) }
            var error: Unmanaged<CFError>?
            guard let signature = SecKeyCreateSignature(
                key,
                .ecdsaSignatureMessageX962SHA256,
                Data(payload.utf8) as CFData,
                &error
            ) as Data? else {
                throw error?.takeRetainedValue() ?? NSError(domain: "DeviceKey", code: 12)
            }
            call.resolve(["signature": signature.base64URLEncodedString()])
        } catch {
            call.reject("Could not sign the Host challenge.", "SIGNING_FAILED", error)
        }
    }

    @objc func delete(_ call: CAPPluginCall) {
        guard let keyId = call.getString("keyId") else { return call.reject("keyId is required.") }
        do {
            let query: [String: Any] = [
                kSecClass as String: kSecClassKey,
                kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
                kSecAttrApplicationTag as String: try tag(keyId)
            ]
            let status = SecItemDelete(query as CFDictionary)
            guard status == errSecSuccess || status == errSecItemNotFound else {
                throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
            }
            call.resolve()
        } catch {
            call.reject("Could not delete the device key.", "KEY_DELETION_FAILED", error)
        }
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
