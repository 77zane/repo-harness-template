#!/usr/bin/env node
/**
 * 统一本地与 CI 门禁调度器：
 * - node scripts/run-gates.mjs --mode <quick|doc-sync|check>
 * - node scripts/run-gates.mjs --test <unit,boundary,architecture>
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

/**
 * 递归收集指定测试子目录下的全部 *.test.mjs 文件（按 POSIX 路径排序），
 * 避免硬编码文件名导致新增测试静默漏跑。
 * @param {string[]} subDirs
 * @param {string} [rootDir]
 * @returns {string[]}
 */
export function collectTestFiles(subDirs, rootDir = ROOT) {
  const results = [];

  /** @param {string} dir */
  function walk(dir) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.test.mjs')) {
        results.push(relative(rootDir, full).replace(/\\/g, '/'));
      }
    }
  }

  for (const sub of subDirs) {
    walk(join(rootDir, 'tests', sub));
  }
  return results.sort();
}

/**
 * 逐层断言指定测试目录均非空，防止某个测试层整目录被误删仍静默绿灯。
 * @param {string[]} subDirs
 * @param {string} rootDir
 */
function collectRequiredSuites(subDirs, rootDir) {
  const all = [];
  for (const sub of subDirs) {
    const found = collectTestFiles([sub], rootDir);
    if (found.length === 0) {
      throw new Error(`run-gates: 测试层 tests/${sub}/ 未发现任何 *.test.mjs 文件`);
    }
    all.push(...found);
  }
  return all;
}

/**
 * @param {string} mode
 * @param {string} [rootDir]
 * @returns {Array<{ id: string, args: string[], blocking?: boolean }>}
 */
export function resolveModeGates(mode, rootDir = ROOT) {
  if (mode === 'quick') {
    const unitTests = collectRequiredSuites(['unit'], rootDir);
    return [
      { id: 'boundaries', args: ['scripts/check-boundaries.mjs'] },
      { id: 'test-patterns', args: ['scripts/check-test-patterns.mjs'] },
      { id: 'hygiene', args: ['scripts/check-file-hygiene.mjs', '--check'] },
      { id: 'test:unit', args: ['--test', ...unitTests] },
    ];
  }

  if (mode === 'doc-sync') {
    return [
      { id: 'doc-budgets', args: ['scripts/verify-doc-budgets.mjs'] },
      { id: 'md-links', args: ['scripts/verify-md-links.mjs'] },
      { id: 'contract-touch', args: ['scripts/check-contract-touch.mjs'], blocking: false },
    ];
  }

  if (mode === 'check') {
    const allTests = collectRequiredSuites(['unit', 'boundary', 'architecture'], rootDir);
    return [
      { id: 'doc-budgets', args: ['scripts/verify-doc-budgets.mjs'] },
      { id: 'md-links', args: ['scripts/verify-md-links.mjs'] },
      { id: 'boundaries', args: ['scripts/check-boundaries.mjs'] },
      { id: 'test-patterns', args: ['scripts/check-test-patterns.mjs'] },
      { id: 'hygiene', args: ['scripts/check-file-hygiene.mjs', '--check'] },
      { id: 'tests', args: ['--test', ...allTests] },
      { id: 'contract-touch', args: ['scripts/check-contract-touch.mjs'], blocking: false },
    ];
  }

  throw new Error(`run-gates: 未知模式 "${mode}"，可选值：quick, doc-sync, check`);
}

/**
 * @param {string} metaUrl
 */
function isCliEntry(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return resolve(process.argv[1]) === fileURLToPath(metaUrl);
  }
}

if (isCliEntry(import.meta.url)) {
  const argv = process.argv.slice(2);
  const testIdx = argv.indexOf('--test');
  if (testIdx >= 0) {
    const rawSuites = argv[testIdx + 1] ?? 'unit,boundary,architecture';
    const suites = rawSuites.split(',').map((s) => s.trim()).filter(Boolean);
    let files;
    try {
      files = collectRequiredSuites(suites, ROOT);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
    const res = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, stdio: 'inherit' });
    process.exit(res.status ?? 1);
  }

  const idx = argv.indexOf('--mode');
  const mode = idx >= 0 ? argv[idx + 1] : 'check';

  let gates;
  try {
    gates = resolveModeGates(mode);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const t0 = performance.now();
  let failedCount = 0;

  console.log(`run-gates [${mode}]：开始执行 ${gates.length} 项门禁...`);

  for (const gate of gates) {
    const start = performance.now();
    const res = spawnSync(process.execPath, gate.args, {
      cwd: ROOT,
      stdio: 'inherit',
    });
    const ms = Math.round(performance.now() - start);
    const ok = res.status === 0;

    if (!ok && gate.blocking !== false) {
      failedCount += 1;
      console.error(`  [FAIL] ${gate.id} (${ms}ms)`);
    } else if (!ok) {
      console.warn(`  [WARN] ${gate.id} 非阻塞门禁异常退出（status=${res.status}, ${ms}ms）`);
    } else {
      console.log(`  [OK]   ${gate.id} (${ms}ms)`);
    }
  }

  const totalMs = Math.round(performance.now() - t0);
  if (failedCount > 0) {
    console.error(`run-gates [${mode}]：失败（${failedCount} 项阻塞门禁未通过，耗时 ${totalMs}ms）`);
    process.exit(1);
  }

  console.log(`run-gates [${mode}]：全部通过（耗时 ${totalMs}ms）`);
}
