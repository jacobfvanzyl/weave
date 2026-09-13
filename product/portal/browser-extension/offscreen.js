const captures = new Map();
const peers = new Map();
let socket;
let opening;
let sequence = Promise.resolve();
function emit(message) {
  if (socket?.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > 256 * 1024) { socket.close(); return; }
  socket.send(JSON.stringify(message));
}
function removePeer(id) {
  const peer = peers.get(id);
  if (!peer) return;
  clearTimeout(peer.expiry); peer.pc.close(); peers.delete(id);
}
function renewPeer(id, expiresAt) {
  const peer = peers.get(id);
  if (!peer) return;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 31000) { removePeer(id); return; }
  clearTimeout(peer.expiry);
  peer.expiry = setTimeout(() => removePeer(id), expiresAt - Date.now());
}
async function connect(endpoint, token) {
  if (socket?.readyState === WebSocket.OPEN) return;
  if (!opening) opening = new Promise((resolve, reject) => {
    socket = new WebSocket(endpoint);
    socket.onopen = () => { emit({type: 'hello', role: 'extension', token}); resolve(); };
    socket.onerror = () => reject(new Error('Extension signaling connection failed'));
    socket.onclose = () => {
      for (const id of peers.keys()) removePeer(id);
      peers.clear();
      for (const stream of captures.values()) stream.getTracks().forEach(track => track.stop());
      captures.clear();
      opening = undefined;
    };
    socket.onmessage = event => {
      sequence = sequence.then(() => command(JSON.parse(event.data))).catch(error => emit({type: 'error', error: String(error)}));
    };
  });
  await opening;
}
chrome.runtime.onMessage.addListener(message => {
  if (message.type !== 'capture') return;
  sequence = sequence.then(async () => {
    await connect(message.endpoint, message.token);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId}},
      video: {mandatory: {chromeMediaSource: 'tab', chromeMediaSourceId: message.streamId, maxFrameRate: 30, minWidth: message.width, maxWidth: message.width, minHeight: message.height, maxHeight: message.height}},
    });
    captures.get(message.tab)?.getTracks().forEach(track => track.stop());
    captures.set(message.tab, stream);
    stream.getVideoTracks()[0].contentHint = 'detail';
    emit({type: 'captured', tab: message.tab, generation: message.generation, requestId: message.requestId,
      tracks: stream.getTracks().map(track => ({kind: track.kind, settings: track.getSettings()}))});
  }).catch(error => { if (socket?.readyState === WebSocket.OPEN) emit({type: 'error', error: String(error)}); });
});
async function command(message) {
  if (message.type === 'stop') {
    for (const [id, peer] of peers) if (peer.tab === message.tab) removePeer(id);
    captures.get(message.tab)?.getTracks().forEach(track => track.stop());
    captures.delete(message.tab);
    emit({type: 'stopped', tab: message.tab, requestId: message.requestId});
  } else if (message.type === 'leave') {
    removePeer(message.peer);
  } else if (message.type === 'renew') {
    renewPeer(message.peer, message.expiresAt);
  } else if (message.type === 'peer') {
    const stream = captures.get(message.tab);
    if (!stream) throw new Error('No captured tab ' + message.tab);
    removePeer(message.peer);
    const pc = new RTCPeerConnection({iceServers: []});
    const peer = {pc, tab: message.tab, generation: message.generation, candidates: []};
    peers.set(message.peer, peer);
    // Service grants expire locally even when Portal or service renewal stops.
    renewPeer(message.peer, message.expiresAt);
    if (!peers.has(message.peer)) throw new Error('Expired media grant');
    pc.onicecandidate = event => { if (event.candidate) emit({type: 'ice', peer: message.peer, candidate: event.candidate.toJSON()}); };
    pc.onconnectionstatechange = () => emit({type: 'peerState', peer: message.peer, state: pc.connectionState});
    for (const track of stream.getTracks()) {
      pc.addTrack(track, stream);
      const transceiver = pc.getTransceivers().find(item => item.sender.track === track);
      const mime = track.kind === 'video' ? 'video/h264' : 'audio/opus';
      const codecs = RTCRtpSender.getCapabilities(track.kind).codecs.filter(codec => codec.mimeType.toLowerCase() === mime);
      if (codecs.length) transceiver.setCodecPreferences(codecs);
    }
    await pc.setLocalDescription(await pc.createOffer());
    emit({type: 'offer', peer: message.peer, tab: message.tab, generation: message.generation, sdp: pc.localDescription.sdp});
  } else if (message.type === 'answer') {
    const peer = peers.get(message.peer);
    if (!peer) return;
    await peer.pc.setRemoteDescription({type: 'answer', sdp: message.sdp});
    for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
  } else if (message.type === 'ice') {
    const peer = peers.get(message.peer);
    if (!peer) return;
    if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(message.candidate);
    else {
      if (peer.candidates.length >= 256) { removePeer(message.peer); throw new Error('ICE candidate capacity exceeded'); }
      peer.candidates.push(message.candidate);
    }
  }
}
