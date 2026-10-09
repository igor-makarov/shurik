// Focused tests for the origin reachability probe used to fail a batch fast
// when the origin host cannot be reached at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tcpConnect, originReachable } from '../http.mjs';

function listen() {
  const server = net.createServer((sock) => sock.end());
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('tcpConnect succeeds against a listening socket', async () => {
  const s = await listen();
  try {
    const r = await tcpConnect('127.0.0.1', s.port, 3000);
    assert.equal(r.ok, true);
  } finally {
    await s.close();
  }
});

test('tcpConnect fails (without rejecting) against a closed port', async () => {
  const s = await listen();
  const port = s.port;
  await s.close();
  const r = await tcpConnect('127.0.0.1', port, 3000);
  assert.equal(r.ok, false);
  assert.ok(r.reason, 'a failure reason is reported');
});

test('originReachable resolves ok for a reachable http origin', async () => {
  const s = await listen();
  try {
    const r = await originReachable(`http://127.0.0.1:${s.port}/x.bin`, { attempts: 1, timeoutMs: 3000 });
    assert.equal(r.ok, true);
  } finally {
    await s.close();
  }
});

test('originReachable reports a bounded failure for an unreachable origin', async () => {
  const s = await listen();
  const port = s.port;
  await s.close();
  const r = await originReachable(`http://127.0.0.1:${port}/x.bin`, { attempts: 1, timeoutMs: 3000, gapMs: 0 });
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});
