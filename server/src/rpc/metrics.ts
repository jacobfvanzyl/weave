let activeSubscriptions = 0;
let replayRequests = 0;
let replayEvents = 0;

export const adjustRpcSubscriptions = (delta: number) => {
  activeSubscriptions = Math.max(0, activeSubscriptions + delta);
};

export const recordRpcReplayRequest = () => {
  replayRequests += 1;
};

export const recordRpcReplayEvent = () => {
  replayEvents += 1;
};

export const rpcRuntimeMetrics = () => ({ activeSubscriptions, replayRequests, replayEvents });
