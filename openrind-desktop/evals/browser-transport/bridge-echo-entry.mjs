// Binary pipe test only: not a browser service and never packaged for customers.
import { BridgePeer } from "./bridge-peer.mjs";
import { createHash } from "node:crypto";
const peer = new BridgePeer(process.stdin, process.stdout, { onRequest: async (_request, stream) => {
  const hash = createHash("sha256");
  for await (const bytes of stream.body()) hash.update(bytes);
  await stream.respond(200, { "content-type": "text/plain" });
  await stream.send(Buffer.from(hash.digest("hex")));
  await stream.end();
} });
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => peer.close());
