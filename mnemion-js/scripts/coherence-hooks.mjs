import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const verb = process.argv[2];
if (verb !== 'install' && verb !== 'check') {
  console.error('usage: node scripts/coherence-hooks.mjs install|check');
  process.exit(2);
}

// Both host settings files live at the repository root, but Coherence belongs
// to mnemion-js. --command makes this bridge part of Coherence's installed
// configuration, so hooks --check can verify it instead of reporting drift.
const prefix = `repo=$(git -C "\${CLAUDE_PROJECT_DIR:-$PWD}" rev-parse --show-toplevel 2>/dev/null); coherence() { if [ -z "$repo" ]; then exit 0; fi; cli="$repo/mnemion-js/node_modules/@posthog/coherence/dist/cli.js"; if [ ! -f "$cli" ]; then if [ "$2" = SessionStart ]; then printf '%s\\n' '{"systemMessage":"Coherence is configured but dependencies are not installed in mnemion-js."}'; fi; exit 0; fi; cd "$repo/mnemion-js" || exit 78; /bin/sh "$repo/scripts/coherence-root-hook.sh" "$cli" "$@"; }; coherence`;
const cli = resolve('node_modules/@posthog/coherence/dist/cli.js');

for (const host of ['claude', 'codex']) {
  const result = spawnSync(process.execPath, [cli, 'hooks', verb === 'check' ? '--check' : 'install', '--host', host, '--command', prefix], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}
