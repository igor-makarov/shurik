import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { runIteration, type Request } from './worker.ts';
export { runIteration };
if (require.main === module) {
  const path = process.argv[2];
  Promise.resolve().then(async () => {
    const req = JSON.parse(await readFile(path, 'utf8')) as Request;
    try { await runIteration(req); }
    catch (error) {
      await mkdir(req.output, { recursive: true });
      await writeFile(`${req.output}/result.json`, JSON.stringify({ version: 1, outcome: 'runner_failure', error: String(error) }));
      process.exitCode = 1;
    }
  }).catch(error => { console.error(String(error)); process.exitCode = 1; });
}
