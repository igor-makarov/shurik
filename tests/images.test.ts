import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import fc from 'fast-check';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node';
import { createReadTool, type ReadToolDetails } from '@earendil-works/pi-durable/tools';
import type { ToolExecutionApi } from '@earendil-works/pi-durable';
import { property, text } from './pbt-support.ts';

const directory = await mkdtemp(join(tmpdir(), 'shurik-image-properties-'));
test.after(() => rm(directory, { recursive: true, force: true }));
const formats = ['png', 'jpg', 'gif', 'webp'] as const;
const images = Object.fromEntries(await Promise.all(formats.map(async extension =>
  [extension, await readFile(resolve('tests/fixtures/images/sample.' + extension))] as const)));
const read = createReadTool();
function api(limits?: { maxWidth: number; maxHeight: number; maxBytes: number }): ToolExecutionApi<ReadToolDetails> {
  const models = builtinModels(), provider = models.getProvider('opencode-go')!;
  const original = models.getModel('opencode-go', 'step-5-preview-free')!;
  if (limits) {
    const model = { ...original, inputLimits: { images: { resize: limits } } };
    models.setProvider({ ...provider, getModels: () => [model], getAllModels: () => [model] });
  }
  // The native read tool only needs these capabilities; provider transport is covered in worker.test.ts.
  return { env: new NodeExecutionEnv({ cwd: directory }), models,
    agent: async () => ({ model: { provider: 'opencode-go', modelId: original.id } }),
  } as unknown as ToolExecutionApi<ReadToolDetails>;
}

property('native image reads preserve complete bytes and MIME regardless of filename extension or absolute/relative path',
  fc.asyncProperty(fc.constantFrom(...formats), fc.constantFrom('.txt', '.png', '.jpg', '.gif', '.webp', ''),
    fc.constantFrom('sample', 'screenshot space', 'écran', '画面'), fc.boolean(), async (format, suffix, name, absolute) => {
      const filename = name + suffix, bytes = images[format]; await writeFile(join(directory, filename), bytes);
      const result = await read.execute({ path: absolute ? join(directory, filename) : filename }, api(), BACKGROUND_CONTEXT);
      assert.ok(!result.isError);
      assert.deepEqual(result.output, [{ type: 'image', mimeType: 'image/' + (format === 'jpg' ? 'jpeg' : format),
        data: bytes.toString('base64') }]);
    }), 75);

property('native image reads honor exact model byte and dimension boundaries without truncating attachments',
  fc.asyncProperty(fc.constantFrom(...formats), fc.integer({ min: 1, max: 3 }), fc.integer({ min: 1, max: 3 }),
    fc.integer({ min: -1, max: 1 }), async (format, maxWidth, maxHeight, delta) => {
      const bytes = images[format], maxBytes = bytes.toString('base64').length + delta;
      await writeFile(join(directory, 'bounded-image'), bytes);
      const result = await read.execute({ path: 'bounded-image' }, api({ maxWidth, maxHeight, maxBytes }), BACKGROUND_CONTEXT);
      const fits = maxWidth >= 2 && maxHeight >= 2 && delta >= 0;
      assert.equal(!result.isError, fits);
      if (fits) assert.deepEqual(result.output, [{ type: 'image', mimeType: 'image/' + (format === 'jpg' ? 'jpeg' : format),
        data: bytes.toString('base64') }]);
      else { assert.deepEqual(result.output, []); assert.equal(result.diagnostics?.[0]?.code, 'unsupported_image'); }
    }), 75);

property('text files with image extensions retain Unicode text and line pagination',
  fc.asyncProperty(fc.array(text, { minLength: 1, maxLength: 8 }), fc.constantFrom(...formats),
    fc.nat(7), fc.integer({ min: 1, max: 8 }), async (lines, extension, requestedOffset, limit) => {
      const content = lines.join('\n'), all = content.split('\n'), start = requestedOffset % all.length;
      const path = 'text.' + extension; await writeFile(join(directory, path), content);
      const result = await read.execute({ path, offset: start + 1, limit }, api(), BACKGROUND_CONTEXT);
      const expected = all.slice(start, start + limit).join('\n');
      assert.ok(!result.isError); assert.deepEqual(result.output, expected ? [{ type: 'text', text: expected }] : []);
    }), 75);

test('native read reports BMP conversion and malformed/oversized image errors without emitting binary text', async () => {
  const png = images.png;
  const huge = Buffer.from(png); huge.writeUInt32BE(2001, 16);
  const malformed = png.subarray(0, 16);
  const oversized = Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024)]);
  for (const [name, bytes] of [['bmp', await readFile(resolve('tests/fixtures/images/sample.bmp'))],
    ['dimensions', huge], ['malformed', malformed], ['size', oversized]] as const) {
    await writeFile(join(directory, name), bytes);
    const result = await read.execute({ path: name }, api(), BACKGROUND_CONTEXT);
    assert.equal(result.isError, true, name); assert.deepEqual(result.output, [], name);
    assert.equal(result.diagnostics?.[0]?.code, 'unsupported_image', name);
  }
});
