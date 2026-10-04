#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { URL } from 'node:url';
import { randomBytes } from 'node:crypto';

let targetBase = process.env.HALOOP_GATEWAY_URL || 'http://136.112.93.84:8787';
if (targetBase.includes(':8785') || targetBase.includes('127.0.0.1:8785')) {
  targetBase = 'http://136.112.93.84:8787';
}
const targetUrl = new URL(targetBase);
const isHttps = targetUrl.protocol === 'https:';
const client = isHttps ? https : http;

const proxyEnv = process.env.HTTP_PROXY || process.env.http_proxy || process.env.ALL_PROXY || process.env.all_proxy;
const proxyUrl = proxyEnv ? new URL(proxyEnv) : null;

const openRouterKey = (process.env.OPENROUTER_API_KEY || '').trim();
const anthropicKey = (process.env.ANTHROPIC_API_KEY || '').trim();
const isOpenRouterKey = Boolean(openRouterKey) || anthropicKey.startsWith('sk-or-') || (process.env.W8_HALOOP_PROVIDER === 'openrouter');
const defaultKey = isOpenRouterKey ? (openRouterKey || anthropicKey) : (anthropicKey || openRouterKey);
const provider = isOpenRouterKey ? 'openrouter' : (process.env.W8_HALOOP_PROVIDER || 'anthropic');
const adminToken = process.env.ADMIN_TOKEN || process.env.W8_BYOH_ADMIN_TOKEN || '';
const defaultModel = process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || process.env.OPENRIND_SHELL_OPENHANDS_MODEL || 'openrouter/free';

function resolveProjectName() {
  let raw = (
    process.env.OPENRIND_SANDBOX_NAME ||
    process.env.OPENRIND_SHELL_SANDBOX_NAME ||
    process.env.OPENRIND_SHELL_WORKSPACE_ID ||
    process.env.WORKSPACE_ID ||
    ''
  ).trim();
  if (!raw && fs.existsSync('/var/lib/openrind-shell/runtime/sandbox-name')) {
    try { raw = fs.readFileSync('/var/lib/openrind-shell/runtime/sandbox-name', 'utf8').trim(); } catch {}
  }
  if (!raw && fs.existsSync('/var/lib/openrind-shell/runtime/workspace-id')) {
    try { raw = fs.readFileSync('/var/lib/openrind-shell/runtime/workspace-id', 'utf8').trim(); } catch {}
  }
  return raw.replace(/^or-/, '') || 'default';
}

function sendUpstream(reqPath, reqMethod, reqHeaders, callback) {
  const headers = { ...reqHeaders, host: targetUrl.host };

  // When NODE_USE_ENV_PROXY=1 is active (Node 22 built-in proxy agent),
  // client.request automatically tunnels through HTTP_PROXY to targetUrl.hostname:targetUrl.port.
  // Passing targetUrl directly ensures port 8787 is preserved and not overwritten with proxy port 3128.
  if (process.env.NODE_USE_ENV_PROXY === '1') {
    return client.request({
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (isHttps ? 443 : 80),
      path: reqPath,
      method: reqMethod,
      headers,
    }, callback);
  }

  // Fallback if NODE_USE_ENV_PROXY is not active and proxyUrl is defined
  if (proxyUrl && targetUrl.protocol === 'http:') {
    const fullUrl = `${targetUrl.protocol}//${targetUrl.host}${reqPath}`;
    return http.request({
      protocol: proxyUrl.protocol,
      hostname: proxyUrl.hostname,
      port: proxyUrl.port,
      path: fullUrl,
      method: reqMethod,
      headers,
    }, callback);
  }

  return client.request({
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (isHttps ? 443 : 80),
    path: reqPath,
    method: reqMethod,
    headers,
  }, callback);
}

function anthropicToOpenAiMessages(body) {
  const messages = [];
  if (body.system) {
    const systemText = typeof body.system === 'string'
      ? body.system
      : Array.isArray(body.system)
        ? body.system.map(s => s.text || '').join('\n')
        : '';
    if (systemText) {
      messages.push({ role: 'system', content: systemText });
    }
  }

  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (typeof m.content === 'string') {
        messages.push({ role: m.role || 'user', content: m.content });
        continue;
      }

      if (Array.isArray(m.content)) {
        if (m.role === 'assistant') {
          let text = '';
          const toolCalls = [];
          for (const c of m.content) {
            if (c.type === 'text') {
              text += (c.text || '');
            } else if (c.type === 'tool_use') {
              toolCalls.push({
                id: c.id,
                type: 'function',
                function: {
                  name: c.name,
                  arguments: typeof c.input === 'string' ? c.input : JSON.stringify(c.input || {}),
                },
              });
            }
          }
          const msgObj = { role: 'assistant', content: text || null };
          if (toolCalls.length > 0) {
            msgObj.tool_calls = toolCalls;
          }
          messages.push(msgObj);
        } else {
          const textPieces = [];
          const toolResults = [];
          for (const c of m.content) {
            if (c.type === 'text') {
              textPieces.push(c.text || '');
            } else if (c.type === 'tool_result') {
              toolResults.push({
                role: 'tool',
                tool_call_id: c.tool_use_id,
                content: typeof c.content === 'string' ? c.content : JSON.stringify(c.content ?? ''),
              });
            }
          }

          for (const tr of toolResults) {
            messages.push(tr);
          }
          if (textPieces.length > 0) {
            messages.push({ role: 'user', content: textPieces.join('\n') });
          } else if (toolResults.length === 0) {
            messages.push({ role: m.role || 'user', content: ' ' });
          }
        }
      }
    }
  }

  return messages;
}

function anthropicToOpenAiTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined;
  return tools.map(t => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));
}

function mapToolNameToClient(name, clientToolNames = []) {
  if (!name) return name;
  if (clientToolNames.includes(name)) return name;

  // 1. Try prefixing with mcp__openrind_browser__
  const mcpPrefixed = `mcp__openrind_browser__${name}`;
  if (clientToolNames.includes(mcpPrefixed)) return mcpPrefixed;

  // 2. Convert PascalCase / camelCase to snake_case and check with prefix
  const snake = name.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
  const mcpSnake = `mcp__openrind_browser__${snake}`;
  if (clientToolNames.includes(mcpSnake)) return mcpSnake;
  if (clientToolNames.includes(snake)) return snake;

  // 3. Extract core action (e.g. "start" from "browser_start" or "BrowserStart")
  const core = snake.replace(/^(?:mcp__)?(?:openrind_)?(?:browser_)?/, '');
  const corePrefixed = `mcp__openrind_browser__browser_${core}`;
  if (clientToolNames.includes(corePrefixed)) return corePrefixed;
  const coreBrowser = `browser_${core}`;
  if (clientToolNames.includes(coreBrowser)) return coreBrowser;

  // 4. Try matching case-insensitively
  const match = clientToolNames.find(t =>
    t.toLowerCase() === name.toLowerCase() ||
    t.toLowerCase() === mcpPrefixed.toLowerCase() ||
    t.toLowerCase() === mcpSnake.toLowerCase() ||
    t.toLowerCase() === corePrefixed.toLowerCase() ||
    t.toLowerCase() === coreBrowser.toLowerCase()
  );
  if (match) return match;

  return name;
}

const server = http.createServer((req, res) => {
  console.error('PROXY REQ:', req.method, req.url);
  if (req.url === '/healthz' || req.url === '/health' || req.url === '/api/hello' || req.url?.startsWith('/api/hello')) {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 0 });
    res.end();
    return;
  }
  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch {}

    const isMessages = req.url === '/v1/messages' || req.url?.startsWith('/v1/messages');
    const isStream = Boolean(body?.stream);

    // If using OpenRouter, adapt /v1/messages to OpenRouter /v1/chat/completions
    if (isMessages && body && isOpenRouterKey) {
      const clientToolNames = Array.isArray(body?.tools) ? body.tools.map(t => t.name) : [];
      const chosenModel = process.env.OPENROUTER_MODEL || process.env.LLM_MODEL || defaultModel;
      const candidates = [
        chosenModel,
        'nvidia/nemotron-3-super-120b-a12b:free',
        'qwen/qwen3.8-27b:free'
      ];
      const fallbackModels = [...new Set(candidates)].slice(0, 3);
      const openAiMessages = anthropicToOpenAiMessages(body);
      const openAiTools = anthropicToOpenAiTools(body.tools);
      const payloadObj = {
        model: chosenModel,
        models: fallbackModels,
        messages: openAiMessages,
        max_tokens: Math.max(Number(body.max_tokens) || 4096, 4096),
        stream: isStream,
      };
      if (openAiTools) {
        payloadObj.tools = openAiTools;
      }
      const openAiPayload = JSON.stringify(payloadObj);

      const projectName = resolveProjectName();
      const collectorUrl = process.env.HALOOP_COLLECTOR_URL || 'http://136.112.93.84:8788';
      const sessionContext = process.env.OPENRIND_HALOOP_SESSION_CONTEXT || req.headers['x-openrind-haloop-session'] || '';
      const forwardHeaders = {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(openAiPayload),
        'x-w8-haloop-provider': 'openrouter',
        ...(adminToken ? { 'x-w8-haloop-admin-token': adminToken } : {}),
        'x-w8-haloop-metadata': JSON.stringify({ project: projectName }),
        'x-w8-haloop-config': JSON.stringify({
          input_guardrails: [{ 'halo.mark': { collectorURL: collectorUrl }, async: false, deny: false }],
          output_guardrails: [{ 'halo.export': { collectorURL: collectorUrl, defaultProject: projectName }, async: false, deny: false }],
        }),
      };

      if (sessionContext) {
        forwardHeaders['x-openrind-haloop-session'] = sessionContext;
      }

      const authKey = openRouterKey || defaultKey;
      if (authKey) {
        forwardHeaders['authorization'] = authKey.startsWith('Bearer ')
          ? authKey
          : `Bearer ${authKey}`;
        forwardHeaders['x-api-key'] = authKey;
        forwardHeaders['x-w8-haloop-api-key'] = authKey;
      }

      const upstream = sendUpstream('/v1/chat/completions', 'POST', forwardHeaders, upstreamRes => {
        if (upstreamRes.statusCode < 200 || upstreamRes.statusCode >= 300) {
          let errChunks = [];
          upstreamRes.on('data', c => errChunks.push(c));
          upstreamRes.on('end', () => {
            const errBody = Buffer.concat(errChunks).toString('utf8');
            let parsedErr;
            try { parsedErr = JSON.parse(errBody); } catch {}
            const errMsg = parsedErr?.error?.message || errBody || 'Upstream provider error';
            res.writeHead(upstreamRes.statusCode || 500, { 'content-type': 'application/json' });
            res.end(JSON.stringify({
              error: {
                type: 'api_error',
                message: errMsg,
              },
            }));
          });
          return;
        }

        if (!isStream) {
          let resChunks = [];
          upstreamRes.on('data', c => resChunks.push(c));
          upstreamRes.on('end', () => {
            try {
              const resData = JSON.parse(Buffer.concat(resChunks).toString('utf8'));
              if (resData.error) {
                res.writeHead(upstreamRes.statusCode || 400, { 'content-type': 'application/json' });
                res.end(JSON.stringify(resData));
                return;
              }

              const msg = resData.choices?.[0]?.message;
              const content = [];
              if (msg?.content) {
                content.push({ type: 'text', text: msg.content });
              }
              if (Array.isArray(msg?.tool_calls)) {
                for (const tc of msg.tool_calls) {
                  let input = {};
                  try { input = JSON.parse(tc.function?.arguments || '{}'); } catch {}
                  const mappedName = mapToolNameToClient(tc.function?.name, clientToolNames);
                  content.push({
                    type: 'tool_use',
                    id: tc.id || `call_${randomBytes(8).toString('hex')}`,
                    name: mappedName,
                    input,
                  });
                }
              }
              if (content.length === 0) {
                const replyText = msg?.reasoning || (msg?.reasoning_details?.[0]?.text) || 'Hello! How can I help you?';
                content.push({ type: 'text', text: replyText });
              }

              const anthropicResponse = {
                id: `msg_${randomBytes(12).toString('hex')}`,
                type: 'message',
                role: 'assistant',
                content,
                model: body.model || defaultModel,
                stop_reason: (msg?.tool_calls && msg.tool_calls.length > 0) ? 'tool_use' : 'end_turn',
                usage: {
                  input_tokens: resData.usage?.prompt_tokens || 10,
                  output_tokens: resData.usage?.completion_tokens || 10,
                },
              };

              const outBytes = Buffer.from(JSON.stringify(anthropicResponse));
              res.writeHead(200, {
                'content-type': 'application/json',
                'content-length': outBytes.byteLength,
              });
              res.end(outBytes);
            } catch (err) {
              res.writeHead(502, { 'content-type': 'application/json' });
              res.end(JSON.stringify({ error: { message: err.message } }));
            }
          });
        } else {
          // SSE streaming transform from OpenAI chunk to Anthropic event stream
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            'connection': 'keep-alive',
          });

          const msgId = `msg_${randomBytes(12).toString('hex')}`;
          res.write(`event: message_start\ndata: ${JSON.stringify({
            type: 'message_start',
            message: {
              id: msgId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: defaultModel,
              usage: { input_tokens: 10, output_tokens: 0 }
            }
          })}\n\n`);

          let blockIndex = 0;
          let inThinking = false;
          let inText = false;
          let activeToolCalls = new Map(); // tool_call_index -> anthropic blockIndex
          let hasToolCalls = false;
          let totalOutputTokens = 0;
          let accumulatedReasoning = '';
          let sseBuffer = '';

          const wantsThinking = Boolean(body?.thinking && body.thinking.type === 'enabled');

          upstreamRes.on('data', chunk => {
            sseBuffer += chunk.toString('utf8');
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed.startsWith('data:')) continue;
              const payload = trimmed.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const parsed = JSON.parse(payload);
                const delta = parsed.choices?.[0]?.delta;
                if (!delta) continue;

                const reasoningPiece = delta.reasoning || (delta.reasoning_details?.[0]?.text) || '';
                const contentPiece = delta.content || '';
                const toolCallsPiece = delta.tool_calls;

                if (reasoningPiece) {
                  accumulatedReasoning += reasoningPiece;
                  if (wantsThinking) {
                    totalOutputTokens++;
                    if (!inThinking && !inText && activeToolCalls.size === 0) {
                      inThinking = true;
                      res.write(`event: content_block_start\ndata: ${JSON.stringify({
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: { type: 'thinking', thinking: '' }
                      })}\n\n`);
                    }
                    if (inThinking) {
                      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: { type: 'thinking_delta', thinking: reasoningPiece }
                      })}\n\n`);
                    }
                  }
                }

                if (contentPiece) {
                  totalOutputTokens++;
                  if (inThinking) {
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: blockIndex
                    })}\n\n`);
                    inThinking = false;
                    blockIndex++;
                  }
                  if (!inText) {
                    inText = true;
                    res.write(`event: content_block_start\ndata: ${JSON.stringify({
                      type: 'content_block_start',
                      index: blockIndex,
                      content_block: { type: 'text', text: '' }
                    })}\n\n`);
                  }
                  res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: contentPiece }
                  })}\n\n`);
                }

                if (Array.isArray(toolCallsPiece)) {
                  totalOutputTokens++;
                  hasToolCalls = true;
                  if (inThinking) {
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: blockIndex
                    })}\n\n`);
                    inThinking = false;
                    blockIndex++;
                  }
                  if (inText) {
                    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                      type: 'content_block_stop',
                      index: blockIndex
                    })}\n\n`);
                    inText = false;
                    blockIndex++;
                  }

                  for (const tc of toolCallsPiece) {
                    const idx = tc.index ?? 0;
                    if (!activeToolCalls.has(idx)) {
                      const curBlock = blockIndex++;
                      activeToolCalls.set(idx, curBlock);
                      const mappedName = mapToolNameToClient(tc.function?.name || 'tool', clientToolNames);
                      res.write(`event: content_block_start\ndata: ${JSON.stringify({
                        type: 'content_block_start',
                        index: curBlock,
                        content_block: {
                          type: 'tool_use',
                          id: tc.id || `call_${randomBytes(8).toString('hex')}`,
                          name: mappedName,
                          input: {}
                        }
                      })}\n\n`);
                    }

                    const targetBlock = activeToolCalls.get(idx);
                    if (tc.function?.arguments) {
                      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                        type: 'content_block_delta',
                        index: targetBlock,
                        delta: {
                          type: 'input_json_delta',
                          partial_json: tc.function.arguments
                        }
                      })}\n\n`);
                    }
                  }
                }
              } catch {}
            }
          });

          upstreamRes.on('end', () => {
            if (inThinking) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: blockIndex
              })}\n\n`);
              inThinking = false;
              blockIndex++;
            }
            if (inText) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: blockIndex
              })}\n\n`);
              inText = false;
              blockIndex++;
            }
            for (const [idx, curBlock] of activeToolCalls.entries()) {
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: curBlock
              })}\n\n`);
            }
            activeToolCalls.clear();

            if (blockIndex === 0 && !hasToolCalls) {
              const fallbackText = accumulatedReasoning.trim() || 'Hello! How can I help you?';
              res.write(`event: content_block_start\ndata: ${JSON.stringify({
                type: 'content_block_start',
                index: 0,
                content_block: { type: 'text', text: '' }
              })}\n\n`);
              res.write(`event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                index: 0,
                delta: { type: 'text_delta', text: fallbackText }
              })}\n\n`);
              res.write(`event: content_block_stop\ndata: ${JSON.stringify({
                type: 'content_block_stop',
                index: 0
              })}\n\n`);
            }

            res.write(`event: message_delta\ndata: ${JSON.stringify({
              type: 'message_delta',
              delta: { stop_reason: hasToolCalls ? 'tool_use' : 'end_turn' },
              usage: { output_tokens: Math.max(totalOutputTokens, 1) }
            })}\n\n`);
            res.write(`event: message_stop\ndata: ${JSON.stringify({
              type: 'message_stop'
            })}\n\n`);
            res.end();
          });
        }
      });

      upstream.on('error', err => {
        if (!res.headersSent) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: err.message, type: 'haloop_proxy_error' } }));
        } else {
          res.end();
        }
      });

      upstream.end(openAiPayload);
      return;
    }

    // Default passthrough for other routes or if using native anthropic key
    const projectName = resolveProjectName();
    const collectorUrl = process.env.HALOOP_COLLECTOR_URL || 'http://136.112.93.84:8788';
    const sessionContext = process.env.OPENRIND_HALOOP_SESSION_CONTEXT || req.headers['x-openrind-haloop-session'] || '';
    const headers = { ...req.headers };
    headers['x-w8-haloop-provider'] = provider;
    headers['x-w8-haloop-admin-token'] = adminToken;
    headers['x-w8-haloop-metadata'] = JSON.stringify({ project: projectName });
    headers['x-w8-haloop-config'] = JSON.stringify({
      input_guardrails: [{ 'halo.mark': { collectorURL: collectorUrl }, async: false, deny: false }],
      output_guardrails: [{ 'halo.export': { collectorURL: collectorUrl, defaultProject: projectName }, async: false, deny: false }],
    });

    if (sessionContext) {
      headers['x-openrind-haloop-session'] = sessionContext;
    }

    if (defaultKey) {
      headers['authorization'] = defaultKey.startsWith('Bearer ')
        ? defaultKey
        : `Bearer ${defaultKey}`;
      headers['x-api-key'] = defaultKey;
      headers['x-w8-haloop-api-key'] = defaultKey;
    }

    const clientReq = sendUpstream(req.url, req.method, headers, clientRes => {
      res.writeHead(clientRes.statusCode || 500, clientRes.headers);
      clientRes.pipe(res);
    });

    clientReq.on('error', err => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message, type: 'haloop_proxy_error' } }));
      } else {
        res.end();
      }
    });

    if (rawBody.length > 0) {
      clientReq.write(rawBody);
    }
    clientReq.end();
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    process.exit(0);
  }
});

server.listen(8785, '127.0.0.1', () => {});
