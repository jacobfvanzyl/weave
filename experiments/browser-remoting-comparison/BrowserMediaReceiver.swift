import Foundation
import LiveKitWebRTC
import AVFoundation

/// Native media adapter. Signaling is supplied by its caller; no browser engine is embedded.
final class BrowserMediaReceiver: NSObject, LKRTCPeerConnectionDelegate {
    let bench = Bench()
    let videoView = LKRTCMTLVideoView(frame: .zero)
    var onSignal: (([String: Any]) -> Void)?
    var onFrame: ((String, Int, Int, Int) -> Void)?
    var onStatus: ((String) -> Void)?
    private let factory = LKRTCPeerConnectionFactory(audioDeviceModuleType: .audioEngine, bypassVoiceProcessing: true, encoderFactory: LKRTCDefaultVideoEncoderFactory(), decoderFactory: LKRTCDefaultVideoDecoderFactory(), audioProcessingModule: nil)
    private var connection: LKRTCPeerConnection?
    private var candidates: [LKRTCIceCandidate] = []
    private var peerID = ""
    private var generation = 0
    private var frameObserver: FirstFrameObserver?
    private var videoTrack: LKRTCVideoTrack?
    private var timer: Timer?

    override init() {
        super.init()
        _ = factory.audioDeviceModule.setEngineAvailability(LKRTCAudioEngineAvailability(isInputAvailable: false, isOutputAvailable: false))
        #if os(iOS)
        videoView.videoContentMode = .scaleAspectFit
        // This client receives browser output only; it never creates a microphone track.

        #endif
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.statistics() }
    }
    func reset() {
        if let track = videoTrack { track.remove(videoView); track.remove(bench); if let observer = frameObserver { track.remove(observer) } }
        videoTrack = nil; frameObserver = nil
        connection?.close(); connection = nil; candidates.removeAll()
        videoView.renderFrame(nil)
    }
    func offer(peer: String, generation: Int, sdp: String) {
        reset(); peerID = peer; self.generation = generation
        let config = LKRTCConfiguration(); config.sdpSemantics = .unifiedPlan; config.iceServers = []
        let constraints = LKRTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let pc = factory.peerConnection(with: config, constraints: constraints, delegate: self) else { onStatus?("Peer creation failed"); return }
        connection = pc
        pc.setRemoteDescription(LKRTCSessionDescription(type: .offer, sdp: sdp)) { [weak self, weak pc] error in
            DispatchQueue.main.async {
                guard let self, let pc, self.connection === pc else { return }
                if let error { self.onStatus?("Remote SDP: \(error)"); return }
                for candidate in self.candidates { pc.add(candidate) { _ in } }; self.candidates.removeAll()
                pc.answer(for: constraints) { [weak self, weak pc] answer, error in
                    guard let answer, let pc else { return }
                    pc.setLocalDescription(answer) { error in
                        DispatchQueue.main.async {
                            guard let self, self.connection === pc else { return }
                            if let error { self.onStatus?("Local SDP: \(error)"); return }
                            self.onSignal?(["type": "answer", "peer": peer, "sdp": answer.sdp])
                        }
                    }
                }
            }
        }
    }
    func ice(peer: String, value: [String: Any]) {
        guard peer == peerID, let pc = connection, let sdp = value["candidate"] as? String else { return }
        let candidate = LKRTCIceCandidate(sdp: sdp, sdpMLineIndex: (value["sdpMLineIndex"] as? NSNumber)?.int32Value ?? 0, sdpMid: value["sdpMid"] as? String)
        if pc.remoteDescription == nil { candidates.append(candidate) } else { pc.add(candidate) { _ in } }
    }
    private func statistics() {
        guard let pc = connection else { return }
        pc.statistics { [weak self, weak pc] report in
            DispatchQueue.main.async {
                guard let self, let pc, self.connection === pc else { return }
                let rows: [[String: Any]] = report.statistics.values.filter { ["inbound-rtp", "candidate-pair", "local-candidate", "remote-candidate", "codec", "transport"].contains($0.type) }.map { stat in
                    var row: [String: Any] = ["id": stat.id, "type": stat.type]
                    for key in ["kind", "mimeType", "codecId", "bytesReceived", "packetsReceived", "framesDecoded", "framesPerSecond", "frameWidth", "frameHeight", "totalDecodeTime", "framesDropped", "jitterBufferDelay", "jitterBufferEmittedCount", "totalAudioEnergy", "totalSamplesReceived", "jitter", "currentRoundTripTime", "state", "nominated", "selectedCandidatePairId", "decoderImplementation", "localCandidateId", "remoteCandidateId", "address", "ip", "protocol", "candidateType"] {
                        if let value = stat.values[key] { row[key] = value }
                    }
                    return row
                }
                record(["event":"rtcStats","t":now(),"rows":rows,"audioPlaying":self.factory.audioDeviceModule.isPlaying]);
                self.onSignal?(["type": "stats", "peer": self.peerID, "generation": self.generation, "audioPlaying": self.factory.audioDeviceModule.isPlaying, "audioRecording": self.factory.audioDeviceModule.isRecording, "rows": rows])
            }
        }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd rtpReceiver: LKRTCRtpReceiver, streams: [LKRTCMediaStream]) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.connection === peerConnection, let track = rtpReceiver.track as? LKRTCVideoTrack else { return }
            let peer = self.peerID, generation = self.generation
            let observer = FirstFrameObserver { [weak self] width, height in
                DispatchQueue.main.async {
                    guard let self, self.connection === peerConnection else { return }
                    self.onFrame?(peer, generation, width, height)
                }
            }
            self.videoTrack = track; self.frameObserver = observer
            track.add(self.videoView); track.add(observer); track.add(self.bench)
        }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didGenerate candidate: LKRTCIceCandidate) {
        let fields=candidate.sdp.split(separator: " "); guard fields.count>4,fields[4].hasPrefix("100.") else{return}
        DispatchQueue.main.async { [weak self] in
            guard let self, self.connection === peerConnection else { return }
            self.onSignal?(["type": "ice", "peer": self.peerID, "candidate": ["candidate": candidate.sdp, "sdpMid": candidate.sdpMid ?? "", "sdpMLineIndex": candidate.sdpMLineIndex]])
        }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCPeerConnectionState) {
        DispatchQueue.main.async { [weak self] in if self?.connection === peerConnection { self?.onStatus?("WebRTC \(newState.rawValue)") } }
    }
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange stateChanged: LKRTCSignalingState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didAdd stream: LKRTCMediaStream) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove stream: LKRTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: LKRTCPeerConnection) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceConnectionState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didChange newState: LKRTCIceGatheringState) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didRemove candidates: [LKRTCIceCandidate]) {}
    func peerConnection(_ peerConnection: LKRTCPeerConnection, didOpen dataChannel: LKRTCDataChannel) {}
}

private final class FirstFrameObserver: NSObject, LKRTCVideoRenderer {
    private var received = false
    private let callback: (Int, Int) -> Void
    init(callback: @escaping (Int, Int) -> Void) { self.callback = callback }
    func setSize(_ size: CGSize) {}
    func renderFrame(_ frame: LKRTCVideoFrame?) {
        guard !received, let frame else { return }
        received = true; callback(Int(frame.width), Int(frame.height))
    }
}
