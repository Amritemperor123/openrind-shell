import { BridgePeer } from './bridge-peer.mjs';
import { forwardToService } from './bridge-http.mjs';

// Only the trusted worker supplies the endpoint and inherited binary pipes.
export function serviceBridge(input, output) {
  return ({ endpoint, onDisconnect }) => {
    const peer = new BridgePeer(input, output, {
      onRequest: forwardToService(endpoint), onDisconnect,
    });
    return { ready: peer.ready, close: () => peer.close() };
  };
}
