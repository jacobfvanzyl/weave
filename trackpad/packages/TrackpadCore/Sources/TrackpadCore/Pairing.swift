import Foundation
import CryptoKit

public struct PairedPeer: Codable, Sendable {
    public var id: UUID
    public var name: String
    public var secret: Data
    public var usbSerial: String?
    public init(id: UUID, name: String, secret: Data, usbSerial: String? = nil) {
        self.id = id; self.name = name; self.secret = secret; self.usbSerial = usbSerial
    }
}
public struct PairingChallenge: Codable, Sendable {
    public var peerID: UUID
    public var nonce: Data
    public var requiresApproval: Bool
    public init(peerID: UUID, nonce: Data, requiresApproval: Bool) {
        self.peerID = peerID; self.nonce = nonce; self.requiresApproval = requiresApproval
    }
}
public struct PairingAuthentication: Codable, Sendable {
    public var peerID: UUID
    public var nonce: Data
    public var proof: Data
    // Only initial, explicitly approved pairing over the trusted USB tunnel sends
    // a new secret. Reconnection exchanges challenge proofs, never the secret.
    public var newSecret: Data?
    public init(peerID: UUID, nonce: Data, proof: Data, newSecret: Data? = nil) {
        self.peerID = peerID; self.nonce = nonce; self.proof = proof; self.newSecret = newSecret
    }
}
public enum PairingError: Error { case invalidProof, unexpectedMessage, approvalRequired, unknownPeer }
private enum PairingCrypto {
    static func random() -> Data { SymmetricKey(size: .bits256).withUnsafeBytes { Data($0) } }
    static func transcript(role: String, session: UUID, host: UUID, mobile: UUID, hostNonce: Data, mobileNonce: Data) -> Data {
        Data("WeaveTrackpad/3/\(role)/\(session.uuidString)/\(host.uuidString)/\(mobile.uuidString)/".utf8) + hostNonce + mobileNonce
    }
    static func proof(_ secret: Data, _ data: Data) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: data, using: SymmetricKey(data: secret)))
    }
    static func valid(_ proof: Data, secret: Data, data: Data) -> Bool {
        secret.count == 32 && proof.count == 32 && HMAC<SHA256>.isValidAuthenticationCode(proof, authenticating: data, using: SymmetricKey(data: secret))
    }
}

/// Three-way mutual authentication. Control becomes eligible only after the
/// mobile confirms that it verified this host's proof with its fresh nonce.
public struct HostPairing: Sendable {
    public let challenge: PairingChallenge
    private let session: UUID
    private let known: PairedPeer?
    private var candidate: PairedPeer?
    private var mobileNonce: Data?
    private var confirmed = false
    public init(id: UUID, session: UUID, knownPeer: PairedPeer?) {
        self.session = session; known = knownPeer
        challenge = PairingChallenge(peerID: id, nonce: PairingCrypto.random(), requiresApproval: knownPeer == nil)
    }
    private func transcript(_ role: String, mobile: UUID, nonce: Data) -> Data {
        PairingCrypto.transcript(role: role, session: session, host: challenge.peerID, mobile: mobile, hostNonce: challenge.nonce, mobileNonce: nonce)
    }
    public mutating func accept(_ auth: PairingAuthentication, name: String) throws -> PairingAuthentication {
        guard candidate == nil, !confirmed else { throw PairingError.unexpectedMessage }
        guard auth.nonce.count == 32 else { throw PairingError.invalidProof }
        let peer: PairedPeer
        if let known {
            guard auth.peerID == known.id, auth.newSecret == nil else { throw PairingError.invalidProof }
            peer = known
        } else {
            guard let secret = auth.newSecret, secret.count == 32 else { throw PairingError.approvalRequired }
            peer = PairedPeer(id: auth.peerID, name: String(name.prefix(100)), secret: secret)
        }
        guard PairingCrypto.valid(auth.proof, secret: peer.secret, data: transcript("mobile", mobile: auth.peerID, nonce: auth.nonce)) else { throw PairingError.invalidProof }
        candidate = peer; mobileNonce = auth.nonce
        return PairingAuthentication(peerID: challenge.peerID, nonce: challenge.nonce,
            proof: PairingCrypto.proof(peer.secret, transcript("host", mobile: peer.id, nonce: auth.nonce)))
    }
    public mutating func confirm(_ auth: PairingAuthentication) throws -> PairedPeer {
        guard let candidate, let mobileNonce, !confirmed else { throw PairingError.unexpectedMessage }
        guard auth.peerID == candidate.id, auth.nonce == mobileNonce, auth.newSecret == nil,
              PairingCrypto.valid(auth.proof, secret: candidate.secret, data: transcript("confirm", mobile: candidate.id, nonce: mobileNonce)) else { throw PairingError.invalidProof }
        confirmed = true
        return candidate
    }
}

public struct MobilePairing: Sendable {
    public let needsApproval: Bool
    private let challenge: PairingChallenge
    private let session: UUID
    private let id: UUID
    private let name: String
    private let nonce = PairingCrypto.random()
    private let known: PairedPeer?
    private var candidate: PairedPeer?
    private var verified = false
    public init(id: UUID, session: UUID, challenge: PairingChallenge, hostName: String, knownPeer: PairedPeer?) throws {
        guard challenge.nonce.count == 32 else { throw PairingError.invalidProof }
        if !challenge.requiresApproval { guard knownPeer?.id == challenge.peerID else { throw PairingError.unknownPeer } }
        self.id = id; self.session = session; self.challenge = challenge; name = String(hostName.prefix(100))
        known = knownPeer; needsApproval = challenge.requiresApproval
    }
    private func transcript(_ role: String) -> Data {
        PairingCrypto.transcript(role: role, session: session, host: challenge.peerID, mobile: id, hostNonce: challenge.nonce, mobileNonce: nonce)
    }
    public mutating func approval(userApproved: Bool) throws -> PairingAuthentication {
        guard candidate == nil else { throw PairingError.unexpectedMessage }
        guard !needsApproval || userApproved else { throw PairingError.approvalRequired }
        let secret: Data
        if needsApproval { secret = PairingCrypto.random() }
        else { guard let known else { throw PairingError.unknownPeer }; secret = known.secret }
        candidate = PairedPeer(id: challenge.peerID, name: name, secret: secret)
        return PairingAuthentication(peerID: id, nonce: nonce, proof: PairingCrypto.proof(secret, transcript("mobile")), newSecret: needsApproval ? secret : nil)
    }
    public mutating func verify(_ auth: PairingAuthentication) throws -> (PairedPeer, PairingAuthentication) {
        guard let candidate, !verified else { throw PairingError.unexpectedMessage }
        guard auth.peerID == candidate.id, auth.nonce == challenge.nonce, auth.newSecret == nil,
              PairingCrypto.valid(auth.proof, secret: candidate.secret, data: transcript("host")) else { throw PairingError.invalidProof }
        verified = true
        return (candidate, PairingAuthentication(peerID: id, nonce: nonce, proof: PairingCrypto.proof(candidate.secret, transcript("confirm"))))
    }
}

/// Retry scheduling is independent of transport and never overrides an explicit
/// pause or an occupied session. Rotate candidates so one closed app cannot starve another.
public struct USBReconnectPolicy: Sendable {
    public var paused = false
    public var sessionAvailable = true
    private var nextAttempt = 0.0
    private var lastSerial: String?
    public init() {}
    public mutating func candidate(serials: [String], occupied: Bool, now: Double) -> String? {
        guard !paused, sessionAvailable, !occupied, now >= nextAttempt, !serials.isEmpty else { return nil }
        nextAttempt = now + 1
        let ordered = serials.sorted()
        let index = lastSerial.flatMap { ordered.firstIndex(of: $0) }.map { ($0 + 1) % ordered.count } ?? 0
        lastSerial = ordered[index]
        return ordered[index]
    }
}
