import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkBoundaries, checkSourceContent } from '../../scripts/check-boundaries.mjs';
import { checkContractTouch } from '../../scripts/check-contract-touch.mjs';
import { checkFileHygiene } from '../../scripts/check-file-hygiene.mjs';
import { checkTestPatterns, findTestPatternViolations } from '../../scripts/check-test-patterns.mjs';
import { evaluateToolAction, extractToolAction } from '../../scripts/hooks/guard-tool.mjs';
import { collectTestFiles, resolveModeGates } from '../../scripts/run-gates.mjs';
import { checkDocBudgets, countUnits } from '../../scripts/verify-doc-budgets.mjs';
import { verifyMarkdownLinks } from '../../scripts/verify-md-links.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/**
 * 在系统临时目录中执行隔离回调并确保结束清理。
 * @param {(dir: string) => void} fn
 */
function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-guard-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 可证伪的文档锚点、门禁与安全钩子全量反例自测。
 */

test('AGENTS.md 与 .agents/hooks.json 存在，且按 Antigravity CWD（.agents/）实跑命令生效', () => {
  const agentsMd = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
  assert.ok(agentsMd.includes('docs/ARCHITECTURE.md'), 'AGENTS.md 必须指向 docs/ARCHITECTURE.md');

  const hooksCfg = JSON.parse(readFileSync(join(ROOT, '.agents/hooks.json'), 'utf8'));
  const cmd = hooksCfg?.['harness-safety-guard']?.PreToolUse?.[0]?.hooks?.[0]?.command;
  assert.equal(typeof cmd, 'string');
  const [, scriptArg] = cmd.split(/\s+/);

  // Antigravity 约定以 hooks.json 所在目录（.agents/）为 CWD 执行命令；直接从该 CWD 实跑验证。
  const runFromAgentsDir = spawnSync(process.execPath, [scriptArg], {
    cwd: join(ROOT, '.agents'),
    input: JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'npm run check' } } }),
    encoding: 'utf8',
  });
  assert.equal(runFromAgentsDir.status, 0);
  assert.equal(JSON.parse(runFromAgentsDir.stdout).decision, 'allow');
});

test('run-gates 必须动态发现全部三层测试文件，并在任意测试层清空时报错', () => {
  const unitFiles = collectTestFiles(['unit'], ROOT);
  assert.ok(unitFiles.includes('tests/unit/ring-buffer.test.mjs'));
  assert.ok(unitFiles.includes('tests/unit/quota-service.test.mjs'));

  const allFiles = collectTestFiles(['unit', 'boundary', 'architecture'], ROOT);
  assert.ok(allFiles.includes('tests/boundary/attach-replay.test.mjs'));
  assert.ok(allFiles.includes('tests/architecture/doc-and-harness-guards.test.mjs'));

  withTempDir((dir) => {
    mkdirSync(join(dir, 'tests/unit'), { recursive: true });
    writeFileSync(join(dir, 'tests/unit/a.test.mjs'), 'export {};\n');
    // 缺少 tests/boundary/ 时，check 模式必须拒绝静默通过。
    assert.throws(() => resolveModeGates('check', dir), /tests\/boundary\//);
  });
});

test('docs/ARCHITECTURE.md 中引用的所有源码锚点存在，且每个业务域都有 contract.md', () => {
  const arch = readFileSync(join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
  const matches = [...arch.matchAll(/`(src\/[a-zA-Z0-9_./-]+\.(?:mjs|md))`/g)].map((m) => m[1]);
  assert.ok(matches.length >= 5, 'docs/ARCHITECTURE.md 应包含完整的源码锚点');
  for (const relPath of matches) {
    assert.ok(existsSync(join(ROOT, relPath)), `docs/ARCHITECTURE.md 引用了不存在的锚点：${relPath}`);
  }

  const domainsDir = join(ROOT, 'src/domains');
  const domains = readdirSync(domainsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(domains.length >= 2);
  for (const d of domains) {
    assert.ok(
      existsSync(join(domainsDir, d.name, 'contract.md')),
      `业务域 "${d.name}" 缺少 src/domains/${d.name}/contract.md`,
    );
  }
});

test('反例自测：verify-doc-budgets 必须拦截超预算、缺失文件与非法清单，并按 LF 稳定计字节', () => {
  assert.equal(countUnits('检查清单 AGENTS.md check'), 6);

  withTempDir((dir) => {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'OK.md'), '一行测试\r\n两行测试\r\n');
    writeFileSync(join(dir, 'OVER.md'), '超限内容'.repeat(20) + '\n');
    writeFileSync(
      join(dir, 'scripts/doc-budgets.manifest.json'),
      JSON.stringify({
        'OK.md': { maxUnits: 20, maxBytes: 26 },
        'OVER.md': { maxUnits: 10, maxBytes: 50 },
        'MISSING.md': { maxUnits: 10 },
        'BAD.md': { maxUnits: '100' },
      }),
    );

    const { failures } = checkDocBudgets(dir);
    assert.ok(!failures.some((f) => f.startsWith('OK.md')), 'CRLF 规范化后 OK.md 不应误判超字节');
    assert.ok(failures.some((f) => f.startsWith('OVER.md') && f.includes('有效词字数')));
    assert.ok(failures.some((f) => f.startsWith('OVER.md') && f.includes('字节数')));
    assert.ok(failures.some((f) => f.startsWith('MISSING.md')));
    assert.ok(failures.some((f) => f.startsWith('BAD.md')));
  });
});

test('反例自测：verify-md-links 必须拦截断链与畸形 URL，并正确处理缩进代码块、查询串与私有文档', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'target file.md'), '# ok\n');
    writeFileSync(join(dir, 'HANDOFF.md'), '[broken](missing-in-local.md)\n');
    writeFileSync(
      join(dir, 'doc.md'),
      [
        '[ok-query](target%20file.md?plain=1#top)',
        '[ok-angle](<target file.md>)',
        '[ok-scheme](data:text/plain;base64,SGk=)',
        '- 示例：',
        '  ```md',
        '  [ignored-in-indented-fence](does-not-exist.md)',
        '  ```',
        '[real-broken](./not-found.md)',
        '[bad-pct](./100%ZZ.md)',
      ].join('\n') + '\n',
    );

    const { failures } = verifyMarkdownLinks(dir);
    assert.equal(failures.length, 2, `预期 2 处失败，实际：${failures.join('; ')}`);
    assert.ok(failures.some((f) => f.includes('not-found.md')));
    assert.ok(failures.some((f) => f.includes('100%ZZ.md')));
  });
});

test('反例自测：check-boundaries 必须拦截静态/动态跨域、空 catch 与 500 行边界，且不被字符串/注释欺骗', () => {
  // 基础规则
  assert.ok(
    checkSourceContent(
      'src/domains/replay/bad.mjs',
      "import { QuotaService } from '../quota/quota-service.mjs';\n",
    ).some((v) => v.includes('no-cross-domain')),
  );
  assert.ok(
    checkSourceContent(
      'src/domains/replay/bad.mjs',
      "import { createApp } from '../../app/server.mjs';\n",
    ).some((v) => v.includes('domain-layer')),
  );
  assert.ok(
    checkSourceContent(
      'src/foundation/bad.mjs',
      "import { ReplayService } from '../domains/replay/replay-service.mjs';\n",
    ).some((v) => v.includes('foundation-isolation')),
  );

  // 曾被正则绕过的边界场景
  assert.ok(
    checkSourceContent(
      'src/domains/replay/dyn.mjs',
      "const m = await import('../quota/quota-service.mjs');\n",
    ).some((v) => v.includes('no-cross-domain')),
  );
  assert.ok(
    checkSourceContent(
      'src/domains/replay/nospace.mjs',
      "import { QuotaService } from'../quota/quota-service.mjs';\n",
    ).some((v) => v.includes('no-cross-domain')),
  );
  assert.ok(
    checkSourceContent(
      'src/domains/replay/export-side.mjs',
      [
        'export const A = 1;',
        "import '../quota/quota-service.mjs';",
        "import { ValidationError } from '../../foundation/errors.mjs';",
      ].join('\n') + '\n',
    ).some((v) => v.includes('no-cross-domain')),
  );
  assert.ok(
    checkSourceContent(
      'src/domains/replay/url-catch.mjs',
      'const u = "https://x.com"; try { work(); } catch {}\n',
    ).some((v) => v.includes('no-silent-catch')),
  );
  assert.equal(
    checkSourceContent(
      'src/domains/replay/glob-comment.mjs',
      [
        'const g = "src/*";',
        "import { QuotaService } from '../quota/quota-service.mjs';",
        'try { work(); } catch {}',
        '/* real comment */',
      ].join('\n') + '\n',
    ).length,
    2,
  );
  // 字符串里的 from 文本不应假阳性
  assert.equal(
    checkSourceContent(
      'src/domains/replay/safe-str.mjs',
      'export function f() { return "loaded from \'../quota/quota-service.mjs\'"; }\n',
    ).length,
    0,
  );
  // 500 行带尾换行合法，501 行拦截，带理由豁免放行
  assert.equal(checkSourceContent('src/app/ok500.mjs', 'const x = 1;\n'.repeat(500)).length, 0);
  assert.ok(
    checkSourceContent('src/app/over501.mjs', 'const x = 1;\n'.repeat(501)).some((v) =>
      v.includes('file-size-cap'),
    ),
  );
  assert.equal(
    checkSourceContent(
      'src/app/exempt501.mjs',
      '// harness-allow(file-size-cap): 生成状态机表\n' + 'const x = 1;\n'.repeat(501),
    ).length,
    0,
  );

  // 空 src/ 必须失败（防 0 文件静默 PASS）
  withTempDir((dir) => {
    assert.ok(checkBoundaries(dir).violations.length > 0);
  });
});

test('反例自测：check-test-patterns 必须拦截 .only/.skip/.todo/选项形式、固定睡眠与空断言', () => {
  const exemptInArch = [
    'test.' + 'only("exempt", () => {}); // harness-fixture',
    'set' + 'Timeout(() => {}, 10); // harness-fixture',
  ].join('\n');
  assert.equal(findTestPatternViolations('tests/architecture/fake.test.mjs', exemptInArch).length, 0);
  // 非 architecture 目录禁用 harness-fixture 逃生口
  assert.equal(findTestPatternViolations('tests/unit/fake.test.mjs', exemptInArch).length, 2);

  // 行尾注释不应误报
  assert.equal(
    findTestPatternViolations(
      'tests/unit/comment.test.mjs',
      'assert.equal(1, 1); // no set' + 'Timeout() here\n', // harness-fixture
    ).length,
    0,
  );

  const realBad = [
    '/* note */ test.' + 'only("x", () => {});', // harness-fixture
    'test("opt", { only: true }, () => {});', // harness-fixture
    'test("skip", { skip: "later" }, () => {});', // harness-fixture
    'test.' + 'todo("pending");', // harness-fixture
    'set' + 'Timeout(() => {}, 50);', // harness-fixture
    'assert.' + 'ok(true);', // harness-fixture
  ].join('\n');
  assert.equal(findTestPatternViolations('tests/unit/bad.test.mjs', realBad).length, 6);

  // 空 tests/ 必须失败
  withTempDir((dir) => {
    assert.ok(checkTestPatterns(dir).violations.length > 0);
  });
});

test('反例自测：check-file-hygiene 必须拦截非法 JSON、单条冲突符与换行问题，且 --fix 不破坏 CRLF 文件', () => {
  withTempDir((dir) => {
    writeFileSync(join(dir, 'bad.json'), '{bad\n');
    writeFileSync(join(dir, 'conflict.txt'), 'ok\n' + '>>>' + '>>>> branch\n');
    writeFileSync(join(dir, 'crlf-no-eol.txt'), 'line1\r\nline2');
    writeFileSync(join(dir, 'mixed.txt'), 'a\r\nb\nc');
    writeFileSync(join(dir, '.env'), 'SECRET=1'); // 本地私有文件应被跳过

    const before = checkFileHygiene(dir, { fix: false });
    assert.ok(before.errors.some((e) => e.startsWith('bad.json')));
    assert.ok(before.errors.some((e) => e.startsWith('conflict.txt')));
    assert.ok(before.errors.some((e) => e.startsWith('crlf-no-eol.txt')));
    assert.ok(before.errors.some((e) => e.startsWith('mixed.txt')));
    assert.ok(!before.errors.some((e) => e.startsWith('.env')));

    // 修复后，crlf-no-eol.txt 与 mixed.txt 必须同时通过后续只读检查
    checkFileHygiene(dir, { fix: true });
    assert.equal(readFileSync(join(dir, 'crlf-no-eol.txt'), 'utf8'), 'line1\r\nline2\r\n');
    assert.equal(readFileSync(join(dir, '.env'), 'utf8'), 'SECRET=1');

    const after = checkFileHygiene(dir, { fix: false });
    assert.ok(!after.errors.some((e) => e.startsWith('crlf-no-eol.txt')));
    assert.ok(!after.errors.some((e) => e.startsWith('mixed.txt')));
  });
});

test('反例自测：check-contract-touch 必须检出源码改动而契约未更新，并在同步更新后清零', () => {
  withTempDir((dir) => {
    mkdirSync(join(dir, 'src/domains/demo'), { recursive: true });
    writeFileSync(join(dir, 'src/domains/demo/contract.md'), '# Demo\n');
    writeFileSync(join(dir, 'src/domains/demo/service.mjs'), 'export const v = 1;\n');

    execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });

    writeFileSync(join(dir, 'src/domains/demo/service.mjs'), 'export const v = 2;\n');
    const staleRes = checkContractTouch(dir, 'main');
    assert.equal(staleRes.stale.length, 1);
    assert.equal(staleRes.stale[0].domain, 'demo');

    writeFileSync(join(dir, 'src/domains/demo/contract.md'), '# Demo v2\n');
    assert.equal(checkContractTouch(dir, 'main').stale.length, 0);
  });
});

test('反例自测：guard-tool 钩子必须拦截各类危险命令与路径、避免误杀正常操作，并严格 fail-closed', () => {
  // 必拦案例（涵盖此前实测绕过）
  const mustBlock = [
    { command: 'git commit --no-verify -m "x"' },
    { command: 'git commit --no-verify; echo ok' },
    { command: 'git commit -n -m "x"' },
    { command: 'git push --force origin main' },
    { command: 'git -C repo push --force origin main' },
    { command: 'git push -uf origin main' },
    { command: 'git push origin +HEAD:main' },
    { command: 'git push origin +main' },
    { command: 'git push --force' },
    { command: 'rm -r -f /' },
    { command: 'rm -rf ./' },
    { command: 'rm -rf /*' },
    { command: 'rm -rf ..' },
    { command: 'Remove-Item -Recurse -Force .' },
    { command: 'echo SECRET=1 > .env' },
    { filePath: '.env.local' },
    { filePath: 'node_modules/pkg/.env.example' },
    { filePath: 'dist/bundle.js' },
  ];
  for (const act of mustBlock) {
    assert.equal(evaluateToolAction(act).allowed, false, `应当拦截：${JSON.stringify(act)}`);
  }

  // 必放行案例（防假阳性误杀）
  const mustAllow = [
    { command: 'npm run check' },
    { command: 'git push --force-with-lease origin main' },
    { command: 'git push -f origin feat/fix-main-nav' },
    { command: 'rm -rf dist && git add .' },
    { command: 'echo EXAMPLE=1 > .env.example' },
    { filePath: '.env.example' },
    { filePath: 'config/.env-schema.json' },
    { filePath: 'src/app/server.mjs' },
  ];
  for (const act of mustAllow) {
    assert.equal(evaluateToolAction(act).allowed, true, `不应误杀：${JSON.stringify(act)}`);
  }

  // 多种载荷字段提取校验
  assert.equal(extractToolAction({ toolInput: { TargetFile: '.env' } }).filePath, '.env');
  assert.equal(extractToolAction({ tool_input: { command: 'npm run check' } }).command, 'npm run check');
  assert.equal(extractToolAction({ unknown: true }).recognized, false);

  // 真实子进程 fail-closed 协议校验（空输入、畸形 JSON、未知结构均拒绝）
  const hookPath = join(ROOT, 'scripts/hooks/guard-tool.mjs');
  for (const badInput of ['', '{invalid-json', JSON.stringify({ unknown: 1 })]) {
    const res = spawnSync(process.execPath, [hookPath], { input: badInput, encoding: 'utf8' });
    assert.equal(res.status, 0);
    assert.equal(JSON.parse(res.stdout).decision, 'deny');
  }
});
