import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserCore, Repository } from '../src/index.mjs';
import { parseTool, ToolSchemas, toolDefinitions, BrowserFault, LIMITS } from '@openrind/browser-contract';
import { fixtureProvider } from './fixture.mjs';

const scope = { tenantId: 'tenant_test', workspaceId: 'workspace_test', sandboxId: 'sandbox_test', conversationId: 'conversation_test' };
const policy = { revision: 1, providers: ['local-chromium'], origins: ['https://example.com'], approveMutations: false };
const resolver = async () => [{ address: '93.184.216.34' }];
async function setup(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'browser-core-'));
  const repo = new Repository(join(dir, 'registry.sqlite'), options);
  const provider = fixtureProvider(options);
  const core = new BrowserCore({ repository: repo, providers: [provider], resolver, ...options });
  t.after(async () => { await core.shutdown(); if (repo.db) repo.close(); await rm(dir, { recursive: true, force: true }); });
  const grant = core.grants.issue(scope, { ...policy, ...(options.policy || {}) });
  const start = await core.call(grant.token, 'browser_start', { provider: 'local-chromium', operationId: 'op_start', ...(options.profile === 'host-retained' ? { profileMode: 'host-retained', profileId: 'profile_test' } : {}) });
  assert.equal(start.ok, true, JSON.stringify(start));
  const session = { sessionId: start.sessionId, sessionEpoch: start.sessionEpoch };
  const page = { ...session, pageId: start.data.pages[0].pageId };
  return { core, repo, provider, grant, start, session, page, dir };
}
test('all 19 strict schemas; server discovery excludes the two client-local tools', () => {
  assert.equal(Object.keys(ToolSchemas).length, 19);
  assert.equal(toolDefinitions().length, 17); assert.equal(toolDefinitions({ local: true }).length, 19);
  for (const input of [{ sessionId: 'bs_test', sessionEpoch: 1, pageId: 'bp_test', selector: '#x' },
    { sessionId: 'bs_test', sessionEpoch: 1, pageId: 'bp_test', depth: 999 }]) assert.throws(() => parseTool('browser_snapshot', input));
  assert.throws(() => parseTool('browser_evaluate', { script: '1+1' }));
  assert.throws(() => parseTool('browser_tabs', { sessionId: 'bs_test', sessionEpoch: 1, action: 'open', url: 'https://example.com' }));
  assert.throws(() => parseTool('browser_save_artifact', { sessionId: 'bs_test', sessionEpoch: 1, artifactId: 'ba_test', operationId: 'op_test', destination: '../escape' }, { local: true }));
  assert.throws(() => parseTool('browser_import_file', {}));
});
test('ownership protects observation, mutation, cleanup and unknown fields', async t => {
  const { core, grant, page, session } = await setup(t);
  const other = core.grants.issue({ ...scope, conversationId: 'conversation_other' }, policy);
  for (const [tool, args] of [['browser_status', session], ['browser_snapshot', page], ['browser_close', { ...session, operationId: 'op_close' }]]) {
    assert.equal((await core.call(other.token, tool, args)).code, 'FORBIDDEN');
  }
  assert.equal((await core.call(grant.token, 'browser_status', { ...session, tenantId: scope.tenantId })).code, 'INVALID_ARGUMENT');
});
test('deduplication returns one recorded outcome; different inputs cannot reuse an ID', async t => {
  const { core, provider, grant, page } = await setup(t);
  const snapshot = await core.call(grant.token, 'browser_snapshot', page);
  assert.equal(snapshot.ok, true); assert.equal(snapshot.data.nodes[1].text, '[redacted]');
  const args = { ...page, ref: snapshot.data.nodes[0].ref, operationId: 'op_click' };
  assert.equal((await core.call(grant.token, 'browser_click', args)).ok, true);
  assert.equal((await core.call(grant.token, 'browser_click', args)).ok, true);
  assert.equal(provider.events.filter(e => e === 'click').length, 1);
  assert.equal((await core.call(grant.token, 'browser_click', { ...args, ref: 'br_other' })).code, 'OPERATION_CONFLICT');
  assert.equal((await core.call(grant.token, 'browser_click', { ...args, operationId: 'op_fresh' })).code, 'STALE_REF');
});
test('single-use trusted approvals bind canonical arguments, owner, epoch and policy', async t => {
  const { core, grant, page } = await setup(t, { policy: { approveMutations: true } });
  const snapshot = await core.call(grant.token, 'browser_snapshot', page);
  const args = { ...page, ref: snapshot.data.nodes[0].ref, operationId: 'op_fill', text: 'private fixture input' };
  assert.equal((await core.call(grant.token, 'browser_fill', args)).code, 'APPROVAL_REQUIRED');
  core.approve(grant.token, 'browser_fill', args, Date.now() + 10_000);
  assert.equal((await core.call(grant.token, 'browser_fill', { ...args, text: 'changed' })).code, 'APPROVAL_REQUIRED');
  assert.equal((await core.call(grant.token, 'browser_fill', args)).ok, true);
  const rows = core.repo.db.prepare('SELECT * FROM audit').all();
  assert(!JSON.stringify(rows).includes(args.text));
});
test('timeout fences the session until the old driver call settles; no action replay', async t => {
  let release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { core, grant, page, provider } = await setup(t, { actionMs: 30, act: async () => { entered(); await pending; } });
  const operation = core.call(grant.token, 'browser_press', { ...page, key: 'Enter', operationId: 'op_slow' });
  await began;
  const result = await operation; assert.equal(result.code, 'OUTCOME_UNKNOWN');
  const status = await core.call(grant.token, 'browser_status', { sessionId: page.sessionId });
  assert.equal(status.data.state, 'Uncertain'); assert.deepEqual(status.data.unknownOperationIds, ['op_slow']);
  await assert.rejects(core.reconcile(grant.token, page.sessionId), BrowserFault);
  const second = await core.call(grant.token, 'browser_press', { ...page, sessionEpoch: status.sessionEpoch, key: 'Enter', operationId: 'op_other' });
  assert.equal(second.code, 'OUTCOME_UNKNOWN'); assert.equal(provider.events.filter(e => e === 'press').length, 1);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await core.reconcile(grant.token, page.sessionId)).ok, true);
  assert.equal(core.repo.operation(core.grants.authenticate(grant.token).owner, 'op_slow').state, 'unknown');
});
test('queued work rechecks revoked grants at dispatch', async t => {
  let release, entered;
  const began = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { release = resolve; });
  const { core, grant, page, provider } = await setup(t, { act: async () => { entered(); await pending; } });
  const first = core.call(grant.token, 'browser_press', { ...page, key: 'Enter', operationId: 'op_first' }); await began;
  const queued = core.call(grant.token, 'browser_press', { ...page, key: 'Tab', operationId: 'op_queued' });
  core.disconnectOwner(core.grants.authenticate(grant.token).owner); release();
  assert.equal((await first).code, 'OUTCOME_UNKNOWN'); assert.equal((await queued).code, 'UNAUTHORIZED');
  assert.equal(provider.events.filter(e => e === 'press').length, 1);
});
test('human takeover invalidates refs and requires trusted release', async t => {
  const { core, grant, session, page } = await setup(t);
  const taken = await core.call(grant.token, 'browser_take_control', { ...session, operationId: 'op_take' });
  assert.equal(taken.ok, true); assert(taken.sessionEpoch > session.sessionEpoch);
  assert.equal((await core.call(grant.token, 'browser_snapshot', { ...page, sessionEpoch: taken.sessionEpoch })).code, 'ACTION_NOT_POSSIBLE');
  const resume = { sessionId: session.sessionId, sessionEpoch: taken.sessionEpoch, handoffId: taken.data.handoffId, operationId: 'op_resume' };
  assert.equal((await core.call(grant.token, 'browser_resume', resume)).code, 'FORBIDDEN');
  core.releaseHuman(grant.token, session.sessionId, resume.handoffId);
  assert.equal((await core.call(grant.token, 'browser_resume', resume)).ok, true);
});
test('profile leases prevent concurrent profile ownership', async t => {
  const { core, grant } = await setup(t, { profile: 'host-retained', policy: { profiles: ['profile_test'] } });
  assert.equal((await core.call(grant.token, 'browser_start', { provider: 'local-chromium', profileMode: 'host-retained', profileId: 'profile_test', operationId: 'op_duplicate_profile' })).code, 'POLICY_DENIED');
});
test('session quotas span grants and sandboxes within one conversation', async t => {
  const { core, grant } = await setup(t);
  assert.equal((await core.call(grant.token, 'browser_start', { provider: 'local-chromium', operationId: 'op_second' })).ok, true);
  const other = core.grants.issue({ ...scope, sandboxId: 'sandbox_second' }, policy);
  assert.equal((await core.call(other.token, 'browser_start', { provider: 'local-chromium', operationId: 'op_over_quota' })).code, 'RATE_LIMITED');
});
test('service bootstrap advertises no installed provider and never exposes local file tools', async t => {
  const { createBrowserService } = await import('../../browser-service/src/index.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'browser-service-'));
  const service = createBrowserService({ databasePath: join(dir, 'registry.sqlite') });
  t.after(async () => { await service.shutdown(); await rm(dir, { recursive: true, force: true }); });
  const { token } = service.core.grants.issue(scope, policy);
  assert.equal(service.tools.length, 17);
  assert.deepEqual((await service.invoke(token, 'browser_capabilities', {})).data.providers, []);
  assert.equal((await service.invoke(token, 'browser_start', { provider: 'local-chromium', operationId: 'op_unavailable' })).code, 'CAPABILITY_UNAVAILABLE');
});
test('artifact capabilities remain unavailable until the core byte routes exist', async t => {
  const { core, provider, grant } = await setup(t);
  provider.capabilities.screenshots = true; provider.capabilities.fileUpload = true; provider.capabilities.fileDownload = true;
  const result = await core.call(grant.token, 'browser_capabilities', {});
  assert.equal(result.data.providers[0].screenshots, false);
  assert.equal(result.data.providers[0].fileUpload, false);
  assert.equal(result.data.providers[0].fileDownload, false);
});
test('expired grants fail closed and expired sessions are reaped without deleting unknown outcomes', async t => {
  let now = 1_000_000;
  const { core, repo, grant, session } = await setup(t, { clock: () => now });
  const auth = core.grants.authenticate(grant.token);
  repo.saveOperation({ owner: auth.owner, id: 'op_unknown_expired', session: session.sessionId, hash: 'hash', state: 'unknown', expiresAt: now - 1 });
  now += LIMITS.grantMs + 1;
  assert.equal((await core.call(grant.token, 'browser_status', session)).code, 'UNAUTHORIZED');
  assert.equal((await core.sweep())[0].closed, true);
  assert.equal(repo.operation(auth.owner, 'op_unknown_expired').state, 'unknown');
});
test('conversation deletion revokes all sandbox grants while preserving other conversations', async t => {
  const { core, grant } = await setup(t);
  const second = core.grants.issue({ ...scope, sandboxId: 'sandbox_second' }, policy);
  const unrelated = core.grants.issue({ ...scope, conversationId: 'conversation_other' }, policy);
  const secondSession = await core.call(second.token, 'browser_start', { provider: 'local-chromium', operationId: 'op_second_sandbox' });
  assert.equal(secondSession.ok, true);
  const closed = await core.deleteConversation(scope);
  assert.equal(closed.length, 2); assert(closed.every(result => result.closed));
  for (const token of [grant.token, second.token]) assert.throws(() => core.grants.authenticate(token));
  assert.equal(core.grants.authenticate(unrelated.token).principal.conversationId, 'conversation_other');
});
test('restart marks dispatched operations unknown, deactivates grants, and fences sessions', async t => {
  const { core, repo, grant, session, dir } = await setup(t);
  const auth = core.grants.authenticate(grant.token);
  repo.saveOperation({ owner: auth.owner, id: 'op_crashed', session: session.sessionId, epoch: 1, hash: 'fixture-hash', state: 'dispatching', createdAt: Date.now(), expiresAt: Date.now() + 10000 });
  const record = repo.session(session.sessionId); record.state = 'Executing'; repo.saveSession(record); repo.close();
  const restarted = new Repository(join(dir, 'registry.sqlite')); t.after(() => restarted.close());
  const restored = restarted.operation(auth.owner, 'op_crashed'); assert.equal(restored.state, 'unknown'); assert.equal(restored.result.code, 'OUTCOME_UNKNOWN');
  assert.equal(restarted.session(session.sessionId).state, 'Uncertain');
  assert.equal(restarted.db.prepare('SELECT active FROM grants WHERE id=?').get(grant.principal.grantId).active, 0);
  restarted.close();
  // The original worker cannot operate after explicitly closing its repository.
  core.shutdown = async () => ({ closed: true });
});
test('single-worker registry ownership fails closed', async t => {
  const { dir } = await setup(t);
  assert.throws(() => new Repository(join(dir, 'registry.sqlite')), /EEXIST/);
});
test('failed start releases profile lease', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-core-lease-'));
  const repo = new Repository(join(dir, 'registry.sqlite'));
  let shouldFail = true;
  const provider = fixtureProvider({
    profile: 'host-retained',
    create: async () => {
      if (shouldFail) throw new Error('creation-failed');
    },
  });
  const core = new BrowserCore({ repository: repo, providers: [provider], resolver });
  t.after(async () => { await core.shutdown(); if (repo.db) repo.close(); await rm(dir, { recursive: true, force: true }); });
  const grant = core.grants.issue(scope, { ...policy, profiles: ['profile_fail_test'] });
  const failedStart = await core.call(grant.token, 'browser_start', {
    provider: 'local-chromium', profileMode: 'host-retained', profileId: 'profile_fail_test', operationId: 'op_start_fail',
  });
  assert.equal(failedStart.ok, false);
  shouldFail = false;
  const retryStart = await core.call(grant.token, 'browser_start', {
    provider: 'local-chromium', profileMode: 'host-retained', profileId: 'profile_fail_test', operationId: 'op_start_retry',
  });
  assert.equal(retryStart.ok, true);
});
test('stale lock file with dead PID is reclaimed', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'browser-core-lock-'));
  const lockPath = join(dir, 'registry.sqlite.lock');
  let unusedPid = 999999;
  for (let pid = 80000; pid < 100000; pid++) {
    try { process.kill(pid, 0); }
    catch (e) { if (e.code === 'ESRCH') { unusedPid = pid; break; } }
  }
  const { writeFileSync } = await import('node:fs');
  writeFileSync(lockPath, JSON.stringify({ pid: unusedPid, startedAt: Date.now() }));
  const repo = new Repository(join(dir, 'registry.sqlite'));
  t.after(async () => { repo.close(); await rm(dir, { recursive: true, force: true }); });
  assert.ok(repo.db);
});
test('unapproved or private destinations never reach a provider', async t => {
  const { core, grant, page, provider } = await setup(t);
  assert.equal((await core.call(grant.token, 'browser_navigate', { ...page, operationId: 'op_bad_url', url: 'https://127.0.0.1' })).code, 'POLICY_DENIED');
  core.resolver = async () => [{ address: '169.254.169.254' }];
  assert.equal((await core.call(grant.token, 'browser_navigate', { ...page, operationId: 'op_private', url: 'https://example.com' })).code, 'POLICY_DENIED');
  assert(!provider.events.includes('navigate'));
});
test('core contains no Electron/provider SDK imports or driver code execution escape hatch', async () => {
  for (const name of await readdir(new URL('../src/', import.meta.url))) {
    const text = await readFile(new URL(`../src/${name}`, import.meta.url), 'utf8');
    assert(!/from ['"](?:electron|playwright|@browserbasehq\/sdk)['"]/.test(text), name);
    assert(!/\.executeJavaScript\(|\.sendCommand\(|\.evaluate\(/.test(text), name);
  }
});
test('spatial awareness, coordinates, interactive control summaries, and ref stability across snapshots on the same generation', async t => {
  const { core, grant, page } = await setup(t, {
    snapshotNodes: [
      {
        kind: 'element',
        frameId: 'frame_fixture',
        role: 'textbox',
        name: 'Search Amazon',
        handle: 'h_search',
        bounds: { x: 240, y: 15, width: 800, height: 40 },
        center: [640, 35],
        inViewport: true,
        hitTestable: true,
        editable: true,
      },
      {
        kind: 'element',
        frameId: 'frame_fixture',
        role: 'button',
        name: 'Go',
        handle: 'h_go',
        bounds: { x: 1045, y: 15, width: 45, height: 40 },
        center: [1067, 35],
        inViewport: true,
        hitTestable: true,
      },
      {
        kind: 'element',
        frameId: 'frame_fixture',
        role: 'link',
        name: 'Search, alt, forward slash',
        handle: 'h_shortcut',
        bounds: { x: -1, y: -1, width: 1, height: 1 },
        center: [-1, -1],
        inViewport: false,
        hitTestable: false,
      },
    ]
  });

  // First snapshot
  const snap1 = await core.call(grant.token, 'browser_snapshot', page);
  assert.equal(snap1.ok, true);
  assert.ok(snap1.data.summary);
  assert.match(snap1.data.summary, /=== Interactive Controls \(in viewport\) ===/);
  assert.match(snap1.data.summary, /textbox "Search Amazon"/);
  assert.match(snap1.data.summary, /bounds: x=240, y=15, w=800, h=40/);
  assert.match(snap1.data.summary, /center: \(640, 35\)/);
  assert.match(snap1.data.summary, /\[hit-testable, editable\]/);
  assert.match(snap1.data.summary, /=== Off-screen \/ Scrolled Controls/);
  assert.match(snap1.data.summary, /link "Search, alt, forward slash"/);

  const searchNode1 = snap1.data.nodes.find(n => n.name === 'Search Amazon');
  assert.ok(searchNode1.ref);
  assert.deepEqual(searchNode1.bounds, { x: 240, y: 15, width: 800, height: 40 });
  assert.deepEqual(searchNode1.center, [640, 35]);
  assert.equal(searchNode1.inViewport, true);
  assert.equal(searchNode1.hitTestable, true);

  // Second snapshot on the SAME document generation:
  // Must reuse or keep existing ref valid!
  const snap2 = await core.call(grant.token, 'browser_snapshot', { ...page, depth: 4 });
  assert.equal(snap2.ok, true);
  const searchNode2 = snap2.data.nodes.find(n => n.name === 'Search Amazon');
  assert.equal(searchNode2.ref, searchNode1.ref);

  // The ref acquired in snapshot 1 MUST be fillable without throwing STALE_REF
  const fillRes = await core.call(grant.token, 'browser_fill', {
    ...page,
    ref: searchNode1.ref,
    operationId: 'op_fill_stable',
    text: 'iphone duo',
  });
  assert.equal(fillRes.ok, true, JSON.stringify(fillRes));
});
