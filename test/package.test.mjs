import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const packageRoot = resolve(import.meta.dirname, '..');

test('the packed package runs its afk executable outside the repository', () => {
  const outside = mkdtempSync(join(tmpdir(), 'afk-package-test-'));
  try {
    const packDir = join(outside, 'tarball');
    mkdirSync(packDir);
    const npmEnvironment = { ...process.env, npm_config_cache: join(outside, 'npm-cache') };
    const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', packDir], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: npmEnvironment,
    }));
    const tarball = join(packDir, packed[0].filename);
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', outside, tarball], {
      stdio: 'pipe',
      env: npmEnvironment,
    });

    const executable = join(outside, 'node_modules', '.bin', 'afk');
    const run = spawnSync(executable, ['--help'], { cwd: outside, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Usage: afk/);
    assert.equal(run.error, undefined);

    const manifest = JSON.parse(readFileSync(join(outside, 'node_modules', packed[0].name, 'package.json'), 'utf8'));
    assert.equal(manifest.bin.afk, './dist/main.js');
    assert.match(manifest.description, /coding agent/i);
    assert.doesNotMatch(manifest.description, /Codex/i);
    assert.ok(readdirSync(join(outside, 'node_modules', packed[0].name, 'dist')).includes('main.js'));
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});
