#!/usr/bin/env node
/**
 * 标准 PreToolUse 防手滑绊线钩子（tripwire，由 .agents/hooks.json 调用）。
 * 定位声明：本脚本是拦截高频危险误操作的确定性绊线，而非完整 OS/容器安全沙箱边界。
 * 协议说明：默认采用 JSON stdin/stdout 协议（Antigravity 以 .agents/ 为 CWD 启动）；
 * 适配其他 Agent 运行时时仅需调整底部 I/O 适配层与 hooks 配置中的相对路径。
 *
 * 拦截规则：
 * 1. 禁止跳过门禁（--no-verify、git commit -n）与向 main/master 强推或无目标分支强推。
 * 2. 禁止对根目录 / 当前工作区根 / 上级目录 / 家目录执行递归强制删除（POSIX rm 与 PowerShell/cmd）。
 * 3. 禁止直接修改或通过 shell 重定向覆盖密钥文件（.env / .env.*，.env.example 除外）及生成/元数据目录（dist/、node_modules/、.git/）。
 */

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GENERATED_DIR_RE = /(?:^|\/)(?:dist|node_modules|\.git)(?:\/|$)/i;
const ENV_FILE_RE = /(?:^|\/)\.env(?:\.[^/]+)?$/i;
const ENV_EXAMPLE_RE = /(?:^|\/)\.env\.example$/i;
const PROTECTED_BRANCHES = new Set(['main', 'master']);

/**
 * 判断路径是否为受保护的密钥文件（不含 .env.example）。
 * @param {string} rawPath
 */
function isProtectedEnvPath(rawPath) {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^['"]|['"]$/g, '').trim();
  return normalized !== '' && ENV_FILE_RE.test(normalized) && !ENV_EXAMPLE_RE.test(normalized);
}

/**
 * 判断路径是否命中生成目录或受保护文件（先拦生成目录，防止 node_modules/x/.env.example 绕过）。
 * @param {string} rawPath
 */
function isProtectedFilePath(rawPath) {
  const normalized = rawPath.replace(/\\/g, '/').replace(/^['"]|['"]$/g, '').trim();
  if (!normalized) return false;
  if (GENERATED_DIR_RE.test(normalized)) return true;
  return isProtectedEnvPath(normalized);
}

/**
 * 按 shell 命令分隔符（&&、||、;、|、换行）拆分命令段，保留引号内文本完整。
 * @param {string} command
 * @returns {string[]}
 */
export function splitCommandSegments(command) {
  const segments = [];
  let cur = '';
  let quote = null;

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    const next = command[i + 1];

    if (quote) {
      cur += ch;
      if (ch === '\\' && quote === '"' && i + 1 < command.length) {
        cur += next;
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }

    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      if (cur.trim()) segments.push(cur.trim());
      cur = '';
      i += 1;
      continue;
    }

    if (ch === ';' || ch === '|' || ch === '\n' || ch === '\r') {
      if (cur.trim()) segments.push(cur.trim());
      cur = '';
      continue;
    }

    cur += ch;
  }

  if (cur.trim()) segments.push(cur.trim());
  return segments;
}

/**
 * 将单条子命令按空白拆分为参数 token（去除成对引号）。
 * @param {string} segment
 * @returns {string[]}
 */
function tokenizeSegment(segment) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < segment.length) {
        cur += segment[i + 1];
        i += 1;
      } else if (ch === quote) {
        quote = null;
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = '';
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/**
 * 解析 git 命令的子命令与后续参数（跳过 git 全局选项如 -C <dir>、-c <k=v>）。
 * @param {string[]} tokens
 */
function parseGitCommand(tokens) {
  let idx = 0;
  if (tokens[idx] === 'sudo') idx += 1;
  if (tokens[idx]?.toLowerCase() !== 'git') return null;
  idx += 1;

  const optsWithValue = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']);
  while (idx < tokens.length && tokens[idx].startsWith('-')) {
    const tok = tokens[idx];
    idx += 1;
    if (optsWithValue.has(tok) && idx < tokens.length) {
      idx += 1;
    }
  }

  const subcommand = tokens[idx]?.toLowerCase() ?? '';
  return { subcommand, args: tokens.slice(idx + 1) };
}

/**
 * 判断 refspec 目标分支是否为 main / master。
 * @param {string} refspec
 */
function isProtectedRefTarget(refspec) {
  const stripped = refspec.replace(/^\+/, '');
  const dst = stripped.includes(':') ? stripped.slice(stripped.indexOf(':') + 1) : stripped;
  const branch = dst.replace(/^refs\/heads\//, '');
  return PROTECTED_BRANCHES.has(branch);
}

/**
 * 判断删除目标是否命中根目录、当前工作区根、上级目录或家目录。
 * @param {string} rawTarget
 */
function isDangerousDeleteTarget(rawTarget) {
  const normalized = rawTarget.replace(/\\/g, '/').trim();
  if (!normalized) return false;
  return /^(?:\/+\*?|\.\.?\/?\*?|[a-zA-Z]:\/\*?|~(?:\/\*?)?|\$HOME(?:\/\*?)?|\$\{HOME\}(?:\/\*?)?)$/.test(
    normalized,
  );
}

/**
 * 校验单条子命令段。
 * @param {string} segment
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
function evaluateSegment(segment) {
  const tokens = tokenizeSegment(segment);
  if (tokens.length === 0) return { allowed: true };

  // 1. 禁止 --no-verify
  if (tokens.includes('--no-verify')) {
    return {
      allowed: false,
      reason: '已被 Harness 钩子拦截：禁止使用 --no-verify 跳过门禁，请先修复底层问题。',
    };
  }

  // 2. Git 子命令检查（git commit -n / 强推保护分支或省略分支强推）
  const git = parseGitCommand(tokens);
  if (git) {
    if (git.subcommand === 'commit') {
      const hasShortNoVerify = git.args.some(
        (arg) => /^-[a-zA-Z]+$/.test(arg) && !arg.startsWith('--') && arg.includes('n'),
      );
      if (hasShortNoVerify) {
        return {
          allowed: false,
          reason: '已被 Harness 钩子拦截：禁止使用 git commit -n 跳过门禁，请先修复底层问题。',
        };
      }
    }

    if (git.subcommand === 'push') {
      const hasForceFlag = git.args.some(
        (arg) =>
          arg === '--force' ||
          (/^-[a-zA-Z]+$/.test(arg) && !arg.startsWith('--') && arg.includes('f')),
      );

      const optsWithValue = new Set(['-o', '--push-option', '--receive-pack', '--exec', '--repo']);
      const positionals = [];
      for (let i = 0; i < git.args.length; i += 1) {
        const arg = git.args[i];
        if (arg === '--') {
          positionals.push(...git.args.slice(i + 1));
          break;
        }
        if (optsWithValue.has(arg)) {
          i += 1;
          continue;
        }
        if (arg.startsWith('-')) continue;
        positionals.push(arg);
      }

      const refspecs = positionals.slice(1);
      const hasPlusProtected = refspecs.some(
        (ref) => ref.startsWith('+') && isProtectedRefTarget(ref),
      );
      if (hasPlusProtected) {
        return {
          allowed: false,
          reason: '已被 Harness 钩子拦截：禁止通过 +refspec 向 main/master 分支强推代码。',
        };
      }

      if (hasForceFlag) {
        if (refspecs.length === 0) {
          return {
            allowed: false,
            reason:
              '已被 Harness 钩子拦截：禁止省略目标分支执行 git push --force/-f，请显式指定非保护分支并使用 --force-with-lease。',
          };
        }
        if (refspecs.some((ref) => isProtectedRefTarget(ref))) {
          return {
            allowed: false,
            reason: '已被 Harness 钩子拦截：禁止向 main/master 分支强推代码。',
          };
        }
      }
    }
  }

  // 3. 递归强制删除高危路径（POSIX rm + Windows PowerShell/cmd）
  const first = tokens[0] === 'sudo' ? tokens[1] : tokens[0];
  const rest = tokens[0] === 'sudo' ? tokens.slice(2) : tokens.slice(1);
  const cmdLower = (first ?? '').toLowerCase();

  if (cmdLower === 'rm') {
    let hasRecursive = false;
    let hasForce = false;
    const targets = [];
    let endOfOpts = false;
    for (const arg of rest) {
      if (!endOfOpts && arg === '--') {
        endOfOpts = true;
        continue;
      }
      if (!endOfOpts && arg.startsWith('--')) {
        if (arg === '--recursive') hasRecursive = true;
        if (arg === '--force') hasForce = true;
        continue;
      }
      if (!endOfOpts && arg.startsWith('-') && arg.length > 1) {
        if (/[rR]/.test(arg)) hasRecursive = true;
        if (/f/.test(arg)) hasForce = true;
        continue;
      }
      targets.push(arg);
    }
    if (hasRecursive && hasForce && targets.some((t) => isDangerousDeleteTarget(t))) {
      return {
        allowed: false,
        reason: '已被 Harness 钩子拦截：禁止对根目录、工作区根目录、上级目录或家目录执行递归强制删除。',
      };
    }
  }

  if (cmdLower === 'remove-item' || cmdLower === 'ri' || cmdLower === 'rmdir' || cmdLower === 'rd') {
    const lowerRest = rest.map((r) => r.toLowerCase());
    const hasRecursive = lowerRest.some(
      (r) => r === '-recurse' || r === '-r' || r === '/s',
    );
    const targets = rest.filter((r) => !r.startsWith('-') && !r.startsWith('/'));
    if (hasRecursive && targets.some((t) => isDangerousDeleteTarget(t))) {
      return {
        allowed: false,
        reason: '已被 Harness 钩子拦截：禁止对根目录、工作区根目录、上级目录或家目录执行递归删除。',
      };
    }
  }

  // 4. 常见 shell 重定向或写文件命令直接覆盖 .env*
  const redirectRe =
    /(?:>>?|\bOut-File\b|\bSet-Content\b|\bAdd-Content\b|\btee(?:\s+-a)?\b)\s+['"]?([^\s'"|;&]+)['"]?/gi;
  let redirMatch;
  while ((redirMatch = redirectRe.exec(segment)) !== null) {
    if (isProtectedFilePath(redirMatch[1])) {
      return {
        allowed: false,
        reason: `已被 Harness 钩子拦截：禁止通过 shell 命令写入受保护路径 "${redirMatch[1]}"。`,
      };
    }
  }

  return { allowed: true };
}

/**
 * 评估归一化后的工具调用动作，返回放行或拒绝原因。
 * @param {{ command?: string, filePath?: string }} action
 * @returns {{ allowed: true } | { allowed: false, reason: string }}
 */
export function evaluateToolAction(action) {
  const command = typeof action.command === 'string' ? action.command.trim() : '';
  const filePath = typeof action.filePath === 'string' ? action.filePath.replace(/\\/g, '/').trim() : '';

  if (command) {
    for (const segment of splitCommandSegments(command)) {
      const verdict = evaluateSegment(segment);
      if (!verdict.allowed) return verdict;
    }
  }

  if (filePath && isProtectedFilePath(filePath)) {
    return {
      allowed: false,
      reason: `已被 Harness 钩子拦截：禁止直接修改受保护或生成目录路径 "${filePath}"。`,
    };
  }

  return { allowed: true };
}

/**
 * 从 PreToolUse stdin 载荷中提取统一动作字段；无法识别载荷结构时显式标记 recognized=false。
 * @param {any} payload
 * @returns {{ recognized: boolean, command: string, filePath: string }}
 */
export function extractToolAction(payload) {
  const args = payload?.toolCall?.args ?? payload?.toolInput ?? payload?.tool_input;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return {
      recognized: true,
      command: args.CommandLine ?? args.command ?? '',
      filePath: args.Path ?? args.TargetFile ?? args.file_path ?? args.target_file ?? args.path ?? '',
    };
  }
  return { recognized: false, command: '', filePath: '' };
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
  const raw = readFileSync(0, 'utf8').trim();
  if (!raw) {
    console.log(
      JSON.stringify({
        decision: 'deny',
        reason: '已被 Harness 钩子拦截：stdin 载荷为空，按失败关闭（fail-closed）策略拒绝。',
      }),
    );
    process.exit(0);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    console.log(
      JSON.stringify({
        decision: 'deny',
        reason: `已被 Harness 钩子拦截：stdin JSON 解析失败（${err.message}）`,
      }),
    );
    process.exit(0);
  }

  const extracted = extractToolAction(payload);
  if (!extracted.recognized) {
    console.log(
      JSON.stringify({
        decision: 'deny',
        reason: '已被 Harness 钩子拦截：无法识别的工具载荷格式，按失败关闭（fail-closed）策略拒绝。',
      }),
    );
    process.exit(0);
  }

  const verdict = evaluateToolAction(extracted);
  console.log(
    JSON.stringify(
      verdict.allowed
        ? { decision: 'allow' }
        : { decision: 'deny', reason: verdict.reason },
    ),
  );
  process.exit(0);
}
