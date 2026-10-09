// In-process fake registry used only by the hermetic CLI preemption test.
//
// It implements the small Ghcr surface the engine and CLI touch
// (pushFile/pushDir/pull/pullRef/resolve/manifest/listTags/login) and stores
// artifacts under the task's ignored staging dir, so the test never contacts
// GHCR or downloads oras. Enabled with NAUKA_GHCR_FAKE=1.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PATHS } from '../config.mjs';
import { sha256Buf } from '../engine.mjs';

function copyTree(src, dst) {
  return fs.mkdir(dst, { recursive: true }).then(async () => {
    for (const name of await fs.readdir(src)) {
      if (name.endsWith('.tmp')) continue;
      await fs.copyFile(path.join(src, name), path.join(dst, name));
    }
  });
}

export class FakeGhcr {
  constructor({ log = () => {} } = {}) {
    this.log = log;
    this.root = path.join(PATHS.stagingDir, 'ghcr-fake');
    this.tags = new Map(); // tag -> { digest, dir, files }
    this.byDigest = new Map();
  }

  async login() {}

  async pushFile(tag, filePath) {
    const buf = await fs.readFile(filePath);
    const digest = 'sha256:' + sha256Buf(buf);
    const dir = path.join(this.root, encodeURIComponent(tag));
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, path.basename(filePath)), buf);
    const entry = { digest, dir, files: [path.basename(filePath)] };
    this.tags.set(tag, entry);
    this.byDigest.set(digest, entry);
    return { tag, digest };
  }

  async pushDir(tag, dir) {
    const dest = path.join(this.root, encodeURIComponent(tag));
    await fs.rm(dest, { recursive: true, force: true });
    await copyTree(dir, dest);
    const files = (await fs.readdir(dest)).filter((f) => !f.endsWith('.tmp')).sort();
    const h = sha256Buf(Buffer.from(files.join(',')));
    const digest = 'sha256:' + h;
    const entry = { digest, dir: dest, files };
    this.tags.set(tag, entry);
    this.byDigest.set(digest, entry);
    return { tag, digest };
  }

  async pull(tag, outDir) {
    return this.pullRef(`fake:${tag}`, outDir);
  }

  async pullRef(ref, outDir) {
    const digest = ref.includes('@') ? ref.slice(ref.indexOf('@') + 1) : null;
    const entry = digest
      ? this.byDigest.get(digest)
      : this.tags.get(ref.startsWith('fake:') ? ref.slice(5) : ref);
    if (!entry) throw new Error(`fake registry: not found ${ref}`);
    await copyTree(entry.dir, outDir);
    return outDir;
  }

  async resolve(tag) {
    const entry = this.tags.get(tag);
    if (!entry) throw new Error(`fake registry: not found ${tag}`);
    return entry.digest;
  }

  async manifest(tag) {
    const entry = this.tags.get(tag);
    return { annotations: {}, layers: entry ? entry.files.map((f) => ({ annotations: { 'org.opencontainers.image.title': f } })) : [] };
  }

  async listTags() {
    return [...this.tags.keys()];
  }
}
