// Developer fixture entry only. The packaged native launcher never invokes this.
import { readFile } from "node:fs/promises";
import { startAdapter } from "../client.mjs";
const settings = JSON.parse(await readFile(process.argv[2], "utf8"));
const adapter = await startAdapter(settings.descriptor, settings.token);
process.stdin.once("end", () => { void adapter.close(); });
process.once("SIGTERM", () => { void adapter.close(); });
