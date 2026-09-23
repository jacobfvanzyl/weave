import XCTest
@testable import TrackpadCore
#if os(macOS)
import CoreGraphics
#endif

final class PairingTests: XCTestCase {
    private let hostID = UUID(), mobileID = UUID()
    private let secret = Data(repeating: 42, count: 32)
    private func known(session: UUID = UUID()) throws -> (HostPairing, MobilePairing) {
        let host = HostPairing(id: hostID, session: session, knownPeer: PairedPeer(id: mobileID, name: "iPad", secret: secret))
        let mobile = try MobilePairing(id: mobileID, session: session, challenge: host.challenge, hostName: "Mac",
                                      knownPeer: PairedPeer(id: hostID, name: "Mac", secret: secret))
        return (host, mobile)
    }
    func testFirstPairRequiresApprovalAndBothSidesSaveSameSecret() throws {
        let session = UUID()
        var host = HostPairing(id: hostID, session: session, knownPeer: nil)
        var mobile = try MobilePairing(id: mobileID, session: session, challenge: host.challenge, hostName: "Mac", knownPeer: nil)
        XCTAssertTrue(mobile.needsApproval)
        XCTAssertThrowsError(try mobile.approval(userApproved: false))
        let approval = try mobile.approval(userApproved: true)
        XCTAssertEqual(approval.newSecret?.count, 32)
        XCTAssertThrowsError(try host.confirm(approval))
        let reply = try host.accept(approval, name: "iPad")
        XCTAssertNil(reply.newSecret)
        let (macPeer, confirm) = try mobile.verify(reply)
        let mobilePeer = try host.confirm(confirm)
        XCTAssertEqual(macPeer.id, hostID); XCTAssertEqual(mobilePeer.id, mobileID)
        XCTAssertEqual(macPeer.secret, mobilePeer.secret)
        XCTAssertEqual(macPeer.secret, approval.newSecret)
        XCTAssertThrowsError(try host.confirm(confirm))
        XCTAssertThrowsError(try mobile.verify(reply))
        XCTAssertThrowsError(try host.accept(approval, name: "iPad"))
    }
    func testKnownPeersReconnectWithoutApprovalOrTransmittingSecret() throws {
        var (host, mobile) = try known()
        XCTAssertFalse(host.challenge.requiresApproval); XCTAssertFalse(mobile.needsApproval)
        let approval = try mobile.approval(userApproved: false)
        XCTAssertNil(approval.newSecret)
        let reply = try host.accept(approval, name: "iPad")
        let (peer, confirm) = try mobile.verify(reply)
        XCTAssertNil(reply.newSecret); XCTAssertNil(confirm.newSecret)
        XCTAssertEqual(try host.confirm(confirm).secret, peer.secret)
    }
    func testReplayFromAnotherSessionOrChallengeFails() throws {
        let session = UUID()
        var (host, mobile) = try known(session: session)
        let approval = try mobile.approval(userApproved: false)
        var (freshHost, _) = try known(session: session)
        XCTAssertNotEqual(host.challenge.nonce, freshHost.challenge.nonce)
        XCTAssertThrowsError(try freshHost.accept(approval, name: "iPad"))
        var wrongSessionMobile = try MobilePairing(id: mobileID, session: UUID(), challenge: host.challenge, hostName: "Mac",
                                                 knownPeer: PairedPeer(id: hostID, name: "Mac", secret: secret))
        let wrongSessionApproval = try wrongSessionMobile.approval(userApproved: false)
        XCTAssertThrowsError(try host.accept(wrongSessionApproval, name: "iPad"))
    }
    func testReplayedHostProofFailsWithFreshMobileNonce() throws {
        let session = UUID()
        var (host, mobile) = try known(session: session)
        let reply = try host.accept(mobile.approval(userApproved: false), name: "iPad")
        var freshMobile = try MobilePairing(id: mobileID, session: session, challenge: host.challenge, hostName: "Mac",
                                          knownPeer: PairedPeer(id: hostID, name: "Mac", secret: secret))
        _ = try freshMobile.approval(userApproved: false)
        XCTAssertThrowsError(try freshMobile.verify(reply))
    }
    func testProofRolesCannotBeReflectedOrUsedAsConfirmation() throws {
        var (host, mobile) = try known()
        let approval = try mobile.approval(userApproved: false)
        let reply = try host.accept(approval, name: "iPad")
        var reflected = reply; reflected.proof = approval.proof
        XCTAssertThrowsError(try mobile.verify(reflected))
        XCTAssertThrowsError(try host.confirm(approval))
        let (_, confirm) = try mobile.verify(reply)
        XCTAssertNoThrow(try host.confirm(confirm))
    }
    func testUnknownHostCannotRequestAutomaticAuthentication() throws {
        let host = HostPairing(id: hostID, session: UUID(), knownPeer: PairedPeer(id: mobileID, name: "iPad", secret: secret))
        XCTAssertThrowsError(try MobilePairing(id: mobileID, session: UUID(), challenge: host.challenge, hostName: "Mac", knownPeer: nil))
    }
    func testWrongKeyIdentityAndSecretReplacementRejected() throws {
        let session = UUID()
        var (host, mobile) = try known(session: session)
        var wrongKeyMobile = try MobilePairing(id: mobileID, session: session, challenge: host.challenge, hostName: "Mac",
                                             knownPeer: PairedPeer(id: hostID, name: "Mac", secret: Data(repeating: 1, count: 32)))
        XCTAssertThrowsError(try host.accept(wrongKeyMobile.approval(userApproved: false), name: "iPad"))
        let good = try mobile.approval(userApproved: false)
        var changed = good; changed.peerID = UUID()
        XCTAssertThrowsError(try host.accept(changed, name: "iPad"))
        changed = good; changed.newSecret = secret
        XCTAssertThrowsError(try host.accept(changed, name: "iPad"))
        changed = good; changed.nonce = Data()
        XCTAssertThrowsError(try host.accept(changed, name: "iPad"))
        XCTAssertNoThrow(try host.accept(good, name: "iPad"))
    }
    func testPairingSurvivesPersistenceAndWireRoundTrips() throws {
        let peer = PairedPeer(id: mobileID, name: "iPad", secret: secret, usbSerial: "paired-usb-device")
        let restored = try JSONDecoder().decode(PairedPeer.self, from: JSONEncoder().encode(peer))
        XCTAssertEqual(restored.secret, peer.secret); XCTAssertEqual(restored.usbSerial, peer.usbSerial)
        var (host, mobile) = try known()
        let auth = try mobile.approval(userApproved: false)
        let bytes = try Frames.encode(WireMessage(.approve, session: UUID(), authentication: auth))
        var decoder = FrameDecoder()
        XCTAssertTrue(try decoder.append(bytes.prefix(7)).isEmpty)
        let decoded = try XCTUnwrap(decoder.append(bytes.dropFirst(7)).first?.authentication)
        XCTAssertNoThrow(try host.accept(decoded, name: "iPad"))
        var old = WireMessage(.hello, session: UUID()); old.version = 2
        XCTAssertThrowsError(try decoder.append(Frames.encode(old)))
    }
    func testRetryRotatesDevicesAndNeverOverridesPauseBusyOrInactiveSession() {
        var policy = USBReconnectPolicy()
        XCTAssertNil(policy.candidate(serials: [], occupied: false, now: 0))
        XCTAssertEqual(policy.candidate(serials: ["b", "a"], occupied: false, now: 0), "a")
        XCTAssertNil(policy.candidate(serials: ["a", "b"], occupied: false, now: 0.5))
        XCTAssertEqual(policy.candidate(serials: ["a", "b"], occupied: false, now: 1), "b")
        policy.paused = true
        XCTAssertNil(policy.candidate(serials: ["a", "b"], occupied: false, now: 2))
        policy.paused = false; policy.sessionAvailable = false
        XCTAssertNil(policy.candidate(serials: ["a", "b"], occupied: false, now: 3))
        policy.sessionAvailable = true
        XCTAssertNil(policy.candidate(serials: ["a", "b"], occupied: true, now: 4))
        XCTAssertEqual(policy.candidate(serials: ["a", "b"], occupied: false, now: 4), "a")
        XCTAssertEqual(policy.candidate(serials: ["b"], occupied: false, now: 5), "b")
    }
    #if os(macOS)
    func testPostedEventsPermitPhysicalMouseKeyboardAndSystemEvents() throws {
        let source = try XCTUnwrap(QuartzInputSource.make())
        XCTAssertEqual(source.localEventsSuppressionInterval, 0)
        for state: CGEventSuppressionState in [.eventSuppressionStateSuppressionInterval, .eventSuppressionStateRemoteMouseDrag] {
            let mask = source.getLocalEventsFilterDuringSuppressionState(state)
            XCTAssertTrue(mask.contains(.permitLocalMouseEvents))
            XCTAssertTrue(mask.contains(.permitLocalKeyboardEvents))
            XCTAssertTrue(mask.contains(.permitSystemDefinedEvents))
        }
    }
    #endif
}
