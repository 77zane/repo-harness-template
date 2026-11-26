#!/usr/bin/env node
/**
 * 确定性架构边界与防御性编码检查（扫描 src/）：
 * 1. no-cross-domain：禁止 src/domains/<A>/** 导入 src/domains/<B>/** 或 src/app/**
 * 2. foundation-isolation：禁止 src/foundation/** 反向导入 src/domains/** 或 src/app/**
 * 3. no-silent-catch：禁止空 catch {} 静默吞错
 * 4. file-size-cap：单文件超过 500 行需按职责拆分，或添加带理由的 "// harness-allow(file-size-cap): <原因>"
 *
 * 说明：本脚本为零依赖词法示范；复杂 TypeScript/Go/Rust 项目优先接入原生依赖图与 AST Linter。
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const MAX_LINES = 500;
const STATIC_IMPORT_RE =
  /(?:^|[;{}\n])\s*import\s+(?:[^;'"\n]+\s+from\s*|from\s*)?['"]([^'"]+)['"]/gm;
const STATIC_EXPORT_RE =
  /(?:^|[;{}\n])\s*export\s+(?:\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^;{}]*\})\s*from\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const EMPTY_CATCH_RE = /\bcatch\s*(?:\([^)]*\))?\s*\{\s*\}/g;
const LARGE_FILE_ALLOW_RE = /\/\/\s*harness-allow\(file-size-cap\)\s*:\s*\S+/;

/**
 * @param {string} dir
 * @param {string[]} acc
 */
function collectSourceFiles(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, acc);
    } else if (/\.(?:mjs|js|ts|tsx)$/.test(entry.name)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 轻量词法扫描：精准剔除单行与块注释，保留换行符且绝不破坏字符串/模板字面量内的 // 与 /*。
 * 可选将字符串内容替换为空格（供空 catch 检查，避免字符串字面量误报）。
 * @param {string} source
 * @param {{ maskStrings?: boolean }} [options]
 */
export function stripJsComments(source, options = {}) {
  const maskStrings = options.maskStrings === true;
  let out = '';
  let i = 0;
  const n = source.length;

  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];

    // 单行注释
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < n && source[i] !== '\n') {
        out += ' ';
        i += 1;
      }
      continue;
    }

    // 块注释（保留换行维持行号准确）
    if (ch === '/' && next === '*') {
      out += '  ';
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        out += source[i] === '\n' ? '\n' : ' ';
        i += 1;
      }
      if (i < n) {
        out += '  ';
        i += 2;
      }
      continue;
    }

    // 字符串或模板字面量
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < n) {
        const c = source[i];
        if (c === '\\' && i + 1 < n) {
          out += maskStrings ? (source[i + 1] === '\n' ? ' \n' : '  ') : c + source[i + 1];
          i += 2;
          continue;
        }
        if (c === quote) {
          out += c;
          i += 1;
          break;
        }
        out += maskStrings ? (c === '\n' ? '\n' : ' ') : c;
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * 从源码中提取全部相对导入路径（覆盖静态 import、export...from 与动态 import()）。
 * @param {string} codeNoComments
 * @returns {string[]}
 */
function extractImportSpecifiers(codeNoComments) {
  const specs = [];
  for (const re of [STATIC_IMPORT_RE, STATIC_EXPORT_RE, DYNAMIC_IMPORT_RE]) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(codeNoComments)) !== null) {
      specs.push(match[1]);
    }
  }
  return specs;
}

/**
 * @param {string} relPath 相对仓库根的 POSIX 路径
 * @param {string} source
 */
export function checkSourceContent(relPath, source) {
  const violations = [];
  const normalized = relPath.replace(/\\/g, '/');
  const code = stripJsComments(source);
  const codeNoStrings = stripJsComments(source, { maskStrings: true });

  const domainMatch = /^src\/domains\/([^/]+)\//.exec(normalized);
  const isFoundation = normalized.startsWith('src/foundation/');

  for (const spec of extractImportSpecifiers(code)) {
    if (!spec.startsWith('.')) continue;
    const target = posix.normalize(posix.join(posix.dirname(normalized), spec));

    if (isFoundation && (target.startsWith('src/domains/') || target.startsWith('src/app/'))) {
      violations.push(
        `${normalized}: [foundation-isolation] 共享底座禁止反向导入 ${target}`,
      );
    }
    if (domainMatch) {
      const ownDomain = domainMatch[1];
      const targetDomainMatch = /^src\/domains\/([^/]+)\//.exec(target);
      if (targetDomainMatch && targetDomainMatch[1] !== ownDomain) {
        violations.push(
          `${normalized}: [no-cross-domain] 业务域 "${ownDomain}" 禁止直接导入 "${targetDomainMatch[1]}"（${target}），请将公共能力沉淀至 src/foundation/`,
        );
      }
      if (target.startsWith('src/app/')) {
        violations.push(
          `${normalized}: [domain-layer] 业务域 "${ownDomain}" 禁止反向导入装配层 ${target}`,
        );
      }
    }
  }

  EMPTY_CATCH_RE.lastIndex = 0;
  let match;
  while ((match = EMPTY_CATCH_RE.exec(codeNoStrings)) !== null) {
    const lineNum = codeNoStrings.slice(0, match.index).split('\n').length;
    violations.push(
      `${normalized}:${lineNum}: [no-silent-catch] 禁止空 catch 块静默吞掉异常`,
    );
  }

  const trimmed = source.replace(/\r?\n$/, '');
  const lineCount = trimmed === '' ? 0 : trimmed.split(/\r?\n/).length;
  if (lineCount > MAX_LINES && !LARGE_FILE_ALLOW_RE.test(source)) {
    violations.push(
      `${normalized}: [file-size-cap] 当前 ${lineCount} 行超过上限 ${MAX_LINES}，请按职责拆分或添加带理由的 "// harness-allow(file-size-cap): <原因>"`,
    );
  }

  return violations;
}

/**
 * @param {string} [rootDir]
 */
export function checkBoundaries(rootDir = ROOT) {
  const files = collectSourceFiles(join(rootDir, 'src'));
  if (files.length === 0) {
    return {
      fileCount: 0,
      violations: ['src/: 未发现任何可检查的源码文件，请核对扫描目录配置'],
    };
  }
  const violations = [];
  for (const abs of files) {
    const rel = relative(rootDir, abs).replace(/\\/g, '/');
    violations.push(...checkSourceContent(rel, readFileSync(abs, 'utf8')));
  }
  return { fileCount: files.length, violations };
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
  const { fileCount, violations } = checkBoundaries();
  if (violations.length > 0) {
    console.error(`FAIL check-boundaries（发现 ${violations.length} 处违规）：`);
    for (const v of violations) console.error(`  - ${v}`);
    process.exit(1);
  }
  console.log(`PASS check-boundaries（已检查 ${fileCount} 份源码文件）`);
}
