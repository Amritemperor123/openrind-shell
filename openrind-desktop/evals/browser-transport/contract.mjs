import { z } from "zod";

// Deliberately a fixture tool, not a claimed browser implementation.
export const TOOL = "openrind_transport_probe";
export const inputSchema = z.object({
  nonce: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  delayMs: z.number().int().min(0).max(5000).optional(),
}).strict();
export const toolDefinition = {
  name: TOOL,
  description: "Transport experiment only: echo a bounded nonce. Does not operate a browser.",
  inputSchema: z.toJSONSchema(inputSchema),
};
export const MAX_BODY = 1024 * 1024;

export function descriptor(input) {
  const value = z.object({
    protocol: z.literal(1),
    endpoint: z.string().max(2048),
    requireProxy: z.boolean(),
  }).strict().parse(input);
  const url = new URL(value.endpoint);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/mcp") {
    throw new Error("Invalid fixed MCP endpoint");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" &&
      ["127.0.0.1", "host.openshell.internal"].includes(url.hostname))) {
    throw new Error("MCP endpoint requires HTTPS or the private experiment route");
  }
  return value;
}
