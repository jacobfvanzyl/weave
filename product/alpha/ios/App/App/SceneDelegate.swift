import UIKit
import Capacitor
import Security

@objc(PortalCredentialPlugin)
final class PortalCredentialPlugin: CAPPlugin, CAPBridgedPlugin {
    let identifier = "PortalCredentialPlugin"
    let jsName = "PortalCredential"
    let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "generate", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sign", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "delete", returnType: CAPPluginReturnPromise)
    ]

    private func tag(_ keyId: String) throws -> Data {
        guard keyId.range(of: #"^[A-Za-z0-9._-]{1,120}$"#, options: .regularExpression) != nil else {
            throw NSError(domain: "PortalCredential", code: 1, userInfo: [NSLocalizedDescriptionKey: "Credential key ID is invalid."])
        }
        return Data("dev.weave.portal.\(keyId)".utf8)
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
            throw error?.takeRetainedValue() ?? NSError(domain: "PortalCredential", code: 2)
        }
        return key
    }

    private func publicKey(_ privateKey: SecKey) throws -> String {
        guard let publicKey = SecKeyCopyPublicKey(privateKey) else {
            throw NSError(domain: "PortalCredential", code: 3, userInfo: [NSLocalizedDescriptionKey: "Could not derive the public key."])
        }
        var error: Unmanaged<CFError>?
        guard let data = SecKeyCopyExternalRepresentation(publicKey, &error) as Data? else {
            throw error?.takeRetainedValue() ?? NSError(domain: "PortalCredential", code: 4)
        }
        return data.base64URLEncodedString()
    }

    private func rawSignature(_ der: Data) throws -> Data {
        let bytes = [UInt8](der)
        var offset = 0
        func readByte() throws -> UInt8 {
            guard offset < bytes.count else { throw NSError(domain: "PortalCredential", code: 5) }
            defer { offset += 1 }
            return bytes[offset]
        }
        func readLength() throws -> Int {
            let first = try readByte()
            if first < 0x80 { return Int(first) }
            let count = Int(first & 0x7f)
            guard count > 0 && count <= 2 else { throw NSError(domain: "PortalCredential", code: 6) }
            var length = 0
            for _ in 0..<count { length = (length << 8) | Int(try readByte()) }
            return length
        }
        func readInteger() throws -> [UInt8] {
            guard try readByte() == 0x02 else { throw NSError(domain: "PortalCredential", code: 7) }
            let length = try readLength()
            guard offset + length <= bytes.count else { throw NSError(domain: "PortalCredential", code: 8) }
            var value = Array(bytes[offset..<(offset + length)])
            offset += length
            while value.count > 32 && value.first == 0 { value.removeFirst() }
            guard value.count <= 32 else { throw NSError(domain: "PortalCredential", code: 9) }
            return Array(repeating: 0, count: 32 - value.count) + value
        }
        guard try readByte() == 0x30 else { throw NSError(domain: "PortalCredential", code: 10) }
        _ = try readLength()
        return Data(try readInteger() + readInteger())
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
            call.reject("Could not create the Portal credential.", "KEY_GENERATION_FAILED", error)
        }
    }

    @objc func sign(_ call: CAPPluginCall) {
        guard let keyId = call.getString("keyId"), let payload = call.getString("payload") else {
            return call.reject("keyId and payload are required.")
        }
        do {
            guard let key = try privateKey(keyId) else { throw NSError(domain: "PortalCredential", code: 11) }
            var error: Unmanaged<CFError>?
            guard let signature = SecKeyCreateSignature(
                key,
                .ecdsaSignatureMessageX962SHA256,
                Data(payload.utf8) as CFData,
                &error
            ) as Data? else {
                throw error?.takeRetainedValue() ?? NSError(domain: "PortalCredential", code: 12)
            }
            call.resolve(["signature": try rawSignature(signature).base64URLEncodedString()])
        } catch {
            call.reject("Could not sign the Portal challenge.", "SIGNING_FAILED", error)
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
            call.reject("Could not delete the Portal credential.", "KEY_DELETION_FAILED", error)
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

final class WeaveBridgeViewController: CAPBridgeViewController {
    private var alphaBrowserHost: AlphaBrowserHost?
#if DEBUG
    private var browserAcceptanceStarted = false
#endif

    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PortalCredentialPlugin())
        if let webView {
            alphaBrowserHost = AlphaBrowserHost(shell: webView)
        }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
#if DEBUG
        loadBrowserAcceptanceShellIfRequested()
        DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
            self?.startBrowserAcceptanceIfRequested()
        }
#endif
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        alphaBrowserHost?.layoutBrowser()
    }

#if DEBUG
    private func loadBrowserAcceptanceShellIfRequested() {
        guard
            argument(after: "--browser-acceptance-run-id") != nil,
            let webView,
            var components = URLComponents(
                url: webView.url ?? URL(string: "capacitor://localhost/")!,
                resolvingAgainstBaseURL: false
            )
        else { return }
        var items = components.queryItems ?? []
        items.removeAll { $0.name == "mock" }
        items.append(URLQueryItem(name: "mock", value: "sidebar"))
        components.queryItems = items
        if let url = components.url {
            webView.load(URLRequest(url: url))
        }
    }

    private func startBrowserAcceptanceIfRequested() {
        guard
            !browserAcceptanceStarted,
            let host = alphaBrowserHost,
            let runId = argument(after: "--browser-acceptance-run-id"),
            runId.range(of: #"^[A-Za-z0-9-]{1,80}$"#, options: .regularExpression) != nil,
            let fixtureValue = argument(after: "--browser-acceptance-fixture-url"),
            let fixtureURL = URL(string: fixtureValue)
        else { return }
        browserAcceptanceStarted = true
        Task { @MainActor in
            let stage = argument(after: "--browser-acceptance-stage") ?? "full"
            var report = await host.runAcceptance(baseURL: fixtureURL, stage: stage)
            let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let screenshotURL = documents.appendingPathComponent(
                "alpha-browser-acceptance-\(runId).png"
            )
            let reportURL = documents.appendingPathComponent(
                "alpha-browser-acceptance-\(runId).json"
            )
            report["runId"] = runId
            report["screenshotWritten"] = writeAcceptanceScreenshot(to: screenshotURL)
            if JSONSerialization.isValidJSONObject(report),
               let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) {
                try? data.write(to: reportURL, options: .atomic)
            }
        }
    }

    private func argument(after flag: String) -> String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
            return nil
        }
        return arguments[index + 1]
    }

    @MainActor
    private func writeAcceptanceScreenshot(to url: URL) -> Bool {
        guard let view = viewIfLoaded, view.bounds.width > 0, view.bounds.height > 0 else {
            return false
        }
        let renderer = UIGraphicsImageRenderer(bounds: view.bounds)
        let image = renderer.image { _ in
            view.drawHierarchy(in: view.bounds, afterScreenUpdates: true)
        }
        guard let data = image.pngData() else { return false }
        do {
            try data.write(to: url, options: .atomic)
            return true
        } catch {
            return false
        }
    }
#endif
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = WeaveBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
