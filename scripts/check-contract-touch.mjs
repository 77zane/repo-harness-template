#!/usr/bin/env node
/**
 * 非阻塞契约触碰提醒：
 * 当 src/domains/<name>/ 下源码发生改动但对应 contract.md 未变动时输出警告，
 * 不阻断纯重构提交；在 GitHub Actions 中自动输出 ::warning 注解。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const DOMAINS_DIR = 'src/domains';
const CONTRACT_FILE = 'contract.md';
const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function tryGit(args, cwd) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * 收集受检改动文件（兼容 PR 分支对比、push 到默认分支对比以及本地未提交改动）。
 * @param {string} rootDir
 * @param {string} baseRef
 * @param {string} [beforeSha]
 */
export function getChangedFiles(rootDir, baseRef, beforeSha = '') {
  const insideGit = tryGit(['rev-parse', '--is-inside-work-tree'], rootDir);
  if (insideGit !== 'true') return [];

  const headSha = tryGit(['rev-parse', '--verify', 'HEAD'], rootDir);
  const untracked = tryGit(['ls-files', '--others', '--exclude-standard'], rootDir) ?? '';
  if (!headSha) {
    return [...new Set(untracked.split(/\r?\n/).filter(Boolean))];
  }

  let tracked = '';
  const mergeBase = baseRef ? tryGit(['merge-base', baseRef, 'HEAD'], rootDir) : null;

  if (mergeBase && mergeBase !== headSha) {
    tracked = tryGit(['diff', '--name-only', mergeBase], rootDir) ?? '';
  } else {
    // 已在基线分支上时优先检查工作区未提交改动；若工作区干净（如 CI push），再对比上次提交。
    const workingTree = tryGit(['diff', '--name-only', 'HEAD'], rootDir) ?? '';
    if (workingTree || untracked) {
      tracked = workingTree;
    } else if (beforeSha && beforeSha !== ZERO_SHA && tryGit(['cat-file', '-e', `${beforeSha}^{commit}`], rootDir) !== null) {
      tracked = tryGit(['diff', '--name-only', `${beforeSha}..HEAD`], rootDir) ?? '';
    } else if (tryGit(['rev-parse', '--verify', 'HEAD~1'], rootDir)) {
      tracked = tryGit(['diff', '--name-only', 'HEAD~1..HEAD'], rootDir) ?? '';
    }
  }

  return [...new Set(`${tracked}\n${untracked}`.split(/\r?\n/).filter(Boolean))];
}

/**
 * @param {string} [rootDir]
 * @param {string} [baseRef]
 * @param {string} [beforeSha]
 */
export function checkContractTouch(
  rootDir = ROOT,
  baseRef = process.env.CONTRACT_BASE_REF || 'origin/main',
  beforeSha = process.env.CONTRACT_BEFORE_SHA || '',
) {
  const domainsAbs = join(rootDir, DOMAINS_DIR);
  if (!existsSync(domainsAbs)) return { stale: [] };

  const domainNames = readdirSync(domainsAbs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(domainsAbs, e.name, CONTRACT_FILE)))
    .map((e) => e.name);

  const files = getChangedFiles(rootDir, baseRef, beforeSha);
  const touchedSource = new Map();
  const updatedContracts = new Set();

  for (const file of files) {
    for (const domain of domainNames) {
      const prefix = `${DOMAINS_DIR}/${domain}/`;
      if (!file.startsWith(prefix)) continue;
      if (file === posix.join(DOMAINS_DIR, domain, CONTRACT_FILE)) {
        updatedContracts.add(domain);
      } else if (/\.(?:mjs|js|ts|tsx)$/.test(file)) {
        const list = touchedSource.get(domain) ?? [];
        list.push(file);
        touchedSource.set(domain, list);
      }
    }
  }

  const stale = [...touchedSource.entries()]
    .filter(([domain]) => !updatedContracts.has(domain))
    .map(([domain, touched]) => ({
      domain,
      contract: posix.join(DOMAINS_DIR, domain, CONTRACT_FILE),
      touched,
    }));

  return { stale };
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
  const { stale } = checkContractTouch();
  if (stale.length === 0) {
    console.log('PASS check-contract-touch（未发现遗漏更新的领域契约）');
    process.exit(0);
  }

  for (const item of stale) {
    const msg =
      `业务域 ${item.domain} 的源码已改动（${item.touched.join(', ')}），但 ${item.contract} 未同步更新。` +
      '若本次改动影响了存储状态、载荷格式、校验口径或核心不变量，请同步更新该契约文档。';
    if (process.env.GITHUB_ACTIONS === 'true') {
      console.log(`::warning title=领域契约未同步更新::${msg}`);
    } else {
      console.warn(`WARN check-contract-touch: ${msg}`);
    }
  }
  process.exit(0);
}
