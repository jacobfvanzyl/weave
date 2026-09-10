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
    private let nativeTerminal = NativeTerminalPlugin()
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(PortalCredentialPlugin())
        bridge?.registerPluginInstance(nativeTerminal)
        guard let webView else { return }
        let container = UIView(frame: webView.frame)
        container.backgroundColor = UIColor(red: 30 / 255, green: 30 / 255, blue: 46 / 255, alpha: 1)
        view = container
        container.addSubview(webView)
        // One native owner for keyboard and rotation geometry. Alpha follows
        // the resulting viewport; Capacitor's notification resize is disabled.
        webView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor)
        ])
    }
#if DEBUG
    private var acceptanceStarted = false
    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        let live = ProcessInfo.processInfo.arguments.contains("--host-acceptance")
        guard !acceptanceStarted, live || ProcessInfo.processInfo.arguments.contains("--shell-acceptance") else { return }
        acceptanceStarted = true
        Task { @MainActor in
            guard let webView else { return }
            let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            try? FileManager.default.removeItem(at: documents.appendingPathComponent("shell-acceptance.json"))
            try? FileManager.default.removeItem(at: documents.appendingPathComponent("native-smoke-cleanup.json"))
            let status = UILabel(frame: CGRect(x: 16, y: 28, width: 280, height: 20))
            status.accessibilityIdentifier = "AcceptanceStage"
            status.font = .systemFont(ofSize: 10)
            status.textColor = .white
            if live { view.addSubview(status) }
            let url = live ? "capacitor://localhost/?acceptance=live" : "capacitor://localhost/?mock=chat&acceptance=1"
            webView.load(URLRequest(url: URL(string: url)!))
            let nativeSmoke = ProcessInfo.processInfo.arguments.contains("--native-terminal-smoke")
            var drivenStages = Set<String>()
            var configured = false
            for _ in 0..<900 {
                try? await Task.sleep(nanoseconds: 200_000_000)
                if live {
                    if !configured, let data = try? Data(contentsOf: documents.appendingPathComponent("host-acceptance-input.json")),
                       let input = String(data: data, encoding: .utf8), !webView.isLoading {
                        do {
                            _ = try await webView.evaluateJavaScript("window.alphaAcceptanceInput = " + input)
                            configured = true
                            try? FileManager.default.removeItem(at: documents.appendingPathComponent("host-acceptance-input.json"))
                        } catch {}
                    }
                    if let stage = try? await webView.evaluateJavaScript("window.alphaAcceptanceStage || window.alphaAcceptanceDetail || 'starting'"), let stage = stage as? String {
                        status.text = stage
                        try? Data(stage.utf8).write(to: documents.appendingPathComponent("native-smoke-stage.txt"), options: .atomic)
                        if nativeSmoke, !drivenStages.contains(stage), nativeTerminal.driveAcceptanceStage(stage) {
                            drivenStages.insert(stage)
                        }
                        if stage == "native-finish" {
                            _ = try? await webView.evaluateJavaScript("window.alphaAcceptanceStage = 'native-finished'")
                        }
                    }
                }
                if let result = try? await webView.evaluateJavaScript("JSON.stringify(window.alphaAcceptance || null)"),
                   let json = result as? String, json != "null" {
                    let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                    if nativeSmoke { try? Data("in-process UIKit smoke; not XCTest keyboard acceptance".utf8).write(to: documents.appendingPathComponent("native-smoke-driver.txt")) }
                    try? Data(json.utf8).write(to: documents.appendingPathComponent("shell-acceptance.json"), options: .atomic)
                    let renderer = UIGraphicsImageRenderer(bounds: view.bounds)
                    let image = renderer.image { _ in view.drawHierarchy(in: view.bounds, afterScreenUpdates: true) }
                    try? image.pngData()?.write(to: documents.appendingPathComponent("shell-acceptance.png"), options: .atomic)
                    if nativeSmoke {
                        do {
                            let cleanup = try await webView.callAsyncJavaScript("""
                              const url = window.alphaAcceptanceInput?.hostUrl;
                              if (!url) throw new Error('Fixture URL missing');
                              const wait = async (get) => { for (let n = 0; n < 50; n++) { const value = get(); if (value) return value; await new Promise(r => setTimeout(r, 100)); } throw new Error('Fixture cleanup timed out'); };
                              const button = (name) => [...document.querySelectorAll('button')].find(el => el.getAttribute('aria-label') === name || el.textContent.trim() === name);
                              const card = () => [...document.querySelectorAll('[data-slot="card"]')].find(el => [...el.querySelectorAll('span')].some(span => span.textContent === url));
                              if (!document.querySelector('[aria-label="Configured Hosts"]')) (await wait(() => button('Settings'))).click();
                              await wait(() => document.querySelector('[role="dialog"]'));
                              const fixture = card();
                              if (!fixture) return JSON.stringify({ removed: true, alreadyAbsent: true });
                              fixture.querySelector('button[aria-label^="Forget "]').click();
                              (await wait(() => button('Forget Host'))).click();
                              await wait(() => !card());
                              return JSON.stringify({ removed: true });
                            """, arguments: [:], in: nil, contentWorld: .page)
                            if let cleanup = cleanup as? String { try? Data(cleanup.utf8).write(to: documents.appendingPathComponent("native-smoke-cleanup.json")) }
                        } catch { try? Data("{\"removed\":false}".utf8).write(to: documents.appendingPathComponent("native-smoke-cleanup.json")) }
                    }
                    status.text = json.contains("\"passed\":true") ? "passed" : "failed"
                    print("ALPHA_ACCEPTANCE " + json)
                    return
                }
            }
            print("ALPHA_ACCEPTANCE timed out")
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
