// GHCR publication via ORAS. ORAS is fetched into git-ignored data/ on demand.

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { REPO_ROOT, PATHS, REGISTRY, SOURCE_REPO, ARTIFACT_TYPE, CHECKPOINT_ARTIFACT_TYPE } from './config.mjs';

const ORAS_VERSION = '1.2.0';
const TOOLS_DIR = path.join(REPO_ROOT, 'data/nauka/tools');

// Track every spawned child so a cancelled tool call never orphans an oras
// process holding a network connection or a staging file open.
const activeChildren = new Set();
export function killActiveChildren(signal = 'SIGTERM') {
  for (const child of activeChildren) {
    try {
      child.kill(signal);
    } catch {
      /* already gone */
    }
  }
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      args,
      { maxBuffer: 64 * 1024 * 1024, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      },
    );
    activeChildren.add(child);
    const done = () => activeChildren.delete(child);
    child.on('close', done);
    child.on('error', done);
    if (opts.stdin) {
      child.stdin.end(opts.stdin);
    }
  });
}

export async function ensureOras({ log = () => {} } = {}) {
  // Prefer a system oras.
  try {
    await run('oras', ['version']);
    return 'oras';
  } catch {
    /* fall through */
  }
  const local = path.join(TOOLS_DIR, 'oras');
  try {
    await run(local, ['version']);
    return local;
  } catch {
    /* need to download */
  }
  await fs.mkdir(TOOLS_DIR, { recursive: true });
  const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
  const url = `https://github.com/oras-project/oras/releases/download/v${ORAS_VERSION}/oras_${ORAS_VERSION}_linux_${arch}.tar.gz`;
  const tgz = path.join(TOOLS_DIR, 'oras.tgz');
  log(`downloading oras ${ORAS_VERSION} from release`);
  await run('curl', ['-sSL', '-o', tgz, url], { maxBuffer: 1024 * 1024 });
  await run('tar', ['-xzf', tgz, '-C', TOOLS_DIR, 'oras']);
  await fs.chmod(local, 0o755);
  await run(local, ['version']);
  return local;
}

export class Ghcr {
  constructor({ oras, log = () => {} }) {
    this.oras = oras;
    this.log = log;
  }

  static async create(opts) {
    const oras = await ensureOras(opts);
    return new Ghcr({ oras, ...opts });
  }

  async login() {
    const user = process.env.GHCR_USERNAME;
    const token = process.env.GITHUB_TOKEN;
    if (!user || !token) throw new Error('GHCR_USERNAME / GITHUB_TOKEN are required');
    // Token is passed on stdin only; never argv or logs.
    const child = execFile(this.oras, ['login', 'ghcr.io', '-u', user, '--password-stdin'], {
      maxBuffer: 8 * 1024 * 1024,
    });
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`oras login exited ${code}`))));
      child.stdin.end(token);
    });
    this.log('oras login ok');
  }

  async resolve(tag) {
    const ref = `${REGISTRY}:${tag}`;
    const { stdout } = await run(this.oras, ['resolve', ref]);
    return stdout.trim();
  }

  async manifest(tag) {
    const ref = `${REGISTRY}:${tag}`;
    const { stdout } = await run(this.oras, ['manifest', 'fetch', ref]);
    return JSON.parse(stdout);
  }

  async listTags() {
    const { stdout } = await run(this.oras, ['repo', 'tags', REGISTRY]);
    return stdout
      .split(/\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  // Push one file as a single layer.
  async pushFile(tag, filePath, { title, annotations = {} } = {}) {
    const dir = path.dirname(filePath);
    const base = path.basename(filePath);
    // Merge annotations so the caller cannot accidentally create a duplicate
    // key (oras rejects duplicate --annotation keys).
    const ann = {
      'org.opencontainers.image.source': SOURCE_REPO,
      'org.opencontainers.image.title': title || base,
      ...annotations,
    };
    const args = ['push', `${REGISTRY}:${tag}`, '--artifact-type', ARTIFACT_TYPE];
    for (const [k, v] of Object.entries(ann)) {
      args.push('--annotation', `${k}=${v}`);
    }
    args.push(`${base}:application/octet-stream`);
    const { stdout, stderr } = await run(this.oras, args, { cwd: dir });
    const out = `${stdout}\n${stderr}`;
    const digestMatch = /Digest:\s*(sha256:[0-9a-f]{64})/i.exec(out);
    if (!digestMatch) throw new Error(`could not parse push digest for ${tag}`);
    return { tag, digest: digestMatch[1], stdout: out };
  }

  // Push a directory tree (e.g. partial chunks) as a multi-layer checkpoint.
  async pushDir(tag, dir) {
    const args = [
      'push',
      `${REGISTRY}:${tag}`,
      '--artifact-type',
      CHECKPOINT_ARTIFACT_TYPE,
      '--annotation',
      `org.opencontainers.image.source=${SOURCE_REPO}`,
      '.',
    ];
    const { stdout, stderr } = await run(this.oras, args, { cwd: dir });
    const out = `${stdout}\n${stderr}`;
    const digestMatch = /Digest:\s*(sha256:[0-9a-f]{64})/i.exec(out);
    if (!digestMatch) throw new Error(`could not parse dir push digest for ${tag}`);
    return { tag, digest: digestMatch[1], stdout: out };
  }

  // Pull a tag or an immutable digest reference into outDir. Prefer an
  // immutable digest when a recorded checkpoint digest is available.
  async pullRef(ref, outDir) {
    await fs.mkdir(outDir, { recursive: true });
    await run(this.oras, ['pull', ref, '-o', outDir]);
    return outDir;
  }

  // Pull a tag into outDir. Returns list of files pulled.
  async pull(tag, outDir) {
    return this.pullRef(`${REGISTRY}:${tag}`, outDir);
  }
}

export { run as execFileP };
