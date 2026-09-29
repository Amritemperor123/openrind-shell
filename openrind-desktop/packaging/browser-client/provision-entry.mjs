import { constants } from 'node:fs';
import { open, link, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { DESCRIPTOR_PATH, readInstalledDescriptor, validateDescriptor } from '../../packages/browser-client/src/launch-config.mjs';

async function provision() {
  if (process.getuid?.() !== 0 || process.argv.length !== 2) throw new Error('Root provisioning required');
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 8192) throw new Error('Descriptor too large');
    chunks.push(chunk);
  }
  const descriptor = validateDescriptor(JSON.parse(Buffer.concat(chunks).toString('utf8')));
  // Check root-owned ancestors before creating anything under the fixed path.
  for (const path of ['/', '/etc', '/etc/openrind-browser']) {
    const directory = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const stat = await directory.stat();
      if (stat.uid !== 0 || (stat.mode & 0o022)) throw new Error('Unsafe provisioning directory');
    } finally { await directory.close(); }
  }
  try {
    const existing = await readInstalledDescriptor();
    if (JSON.stringify(existing) !== JSON.stringify(descriptor)) throw new Error('Endpoint replacement requires sandbox reprovisioning');
    return;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `/etc/openrind-browser/.descriptor-${randomUUID()}`;
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    await file.writeFile(JSON.stringify(descriptor) + '\n');
    await file.chmod(0o644);
    await file.sync();
    await file.close();
    // Atomic publication without replacing an existing descriptor or symlink.
    await link(temporary, DESCRIPTOR_PATH);
    const directory = await open('/etc/openrind-browser', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    await file.close().catch(() => {});
    await unlink(temporary);
  }
}
provision().catch(() => {
  process.stderr.write('openrind-browser: trusted endpoint provisioning failed\n');
  process.exitCode = 1;
});
