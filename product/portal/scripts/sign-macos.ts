import { stat } from '../src/host-files.ts';
import { runProcess } from '../src/host-process.ts';
import { resolve } from 'node:path';

const DEFAULT_IDENTIFIER = 'xyz.veezee.weave.portal';

const run = async (args: string[]) => {
  const output = await runProcess('/usr/bin/codesign', {
    args,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (!output.success) {
    throw new Error(
      new TextDecoder().decode(output.stderr).trim() ||
        `codesign exited with status ${output.code}.`,
    );
  }
  return {
    stdout: new TextDecoder().decode(output.stdout).trim(),
    stderr: new TextDecoder().decode(output.stderr).trim(),
  };
};

if (process.platform !== 'darwin') {
  throw new Error('Portal macOS signing can only run on macOS.');
}

const identity = process.env['WEAVE_PORTAL_CODESIGN_IDENTITY']?.trim();
if (!identity) {
  throw new Error(
    'WEAVE_PORTAL_CODESIGN_IDENTITY is required. Use `security find-identity -v -p codesigning` to list identities.',
  );
}

const identifier = process.env['WEAVE_PORTAL_CODESIGN_IDENTIFIER']?.trim() || DEFAULT_IDENTIFIER;
if (!/^[A-Za-z0-9.-]+$/.test(identifier)) {
  throw new Error('WEAVE_PORTAL_CODESIGN_IDENTIFIER is invalid.');
}

const target = resolve(process.argv.slice(2)[0] || 'dist/weave-portal');
const details = await stat(target);
if (!details.isFile()) throw new Error(`Portal signing target is not a file: ${target}`);

await run([
  '--force',
  '--sign',
  identity,
  '--identifier',
  identifier,
  '--timestamp=none',
  target,
]);
await run(['--verify', '--strict', '--verbose=2', target]);
const requirementOutput = await run(['--display', '--requirements', '-', target]);
const requirement = [requirementOutput.stderr, requirementOutput.stdout].filter(Boolean).join('\n');
if (!requirement.includes(`identifier "${identifier}"`) || requirement.includes('cdhash H"')) {
  throw new Error(`Portal designated requirement is not stable: ${requirement}`);
}

console.log(`Signed ${target} as ${identifier}.`);
