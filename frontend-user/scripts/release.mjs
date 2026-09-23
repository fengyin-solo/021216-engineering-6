#!/usr/bin/env node
/**
 * 上线流水线：安装依赖 → 类型检查 → 打包校验
 *
 * - 三个环节的开关集中在一个设置面板里，逐项可开关
 * - 设置按当前环境（local / docker / ci）自动给出默认值，并记忆上次选择
 * - 任何一步失败都会指出卡在第几步、失败原因，日志落盘便于排查
 * - 打包先输出到临时目录，成功后原子替换 dist，失败不残留中间产物
 *
 * 用法：
 *   node scripts/release.mjs                 # 交互终端弹出设置面板；非交互终端按默认/记忆执行
 *   node scripts/release.mjs --settings      # 强制弹出设置面板
 *   node scripts/release.mjs -y              # 非交互，直接执行（Docker 构建走这条路径）
 *   node scripts/release.mjs --env docker    # 指定环境（默认自动识别）
 *   node scripts/release.mjs --no-install --no-typecheck
 *   node scripts/release.mjs --typecheck-only
 *   node scripts/release.mjs --force-install # 删除 node_modules 后重新安装
 */

import { spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

const ROOT = process.cwd()
const STATE_FILE = join(ROOT, '.release-pipeline.json')
const CACHE_DIR = join(ROOT, 'node_modules', '.release-pipeline')
const LOG_DIR = join(CACHE_DIR, 'logs')
const TMP_BUILD_DIR = join(CACHE_DIR, 'dist.tmp')

const STEPS = [
  {
    key: 'install',
    index: 1,
    name: '安装依赖',
    detail: 'npm install（同步 package-lock）',
  },
  {
    key: 'typecheck',
    index: 2,
    name: '类型检查',
    detail: 'vue-tsc --noEmit（TS / .vue 全量类型）',
  },
  {
    key: 'build',
    index: 3,
    name: '打包校验',
    detail: 'vite build（含 SCSS 编译），成功后原子替换 dist',
  },
]

// 各环境的默认开关：
// - local：本地改完代码直接上线，三步全跑，避免类型/样式错误到最后一刻才发现
// - docker：镜像内已经单独跑过 npm install，这里默认跳过安装，只做类型检查与打包
// - ci：依赖由流水线预置，同样只做类型检查与打包
const ENV_DEFAULTS = {
  local: { install: true, typecheck: true, build: true },
  docker: { install: false, typecheck: true, build: true },
  ci: { install: false, typecheck: true, build: true },
}

const ENV_LABELS = {
  local: '本地开发',
  docker: 'Docker 构建',
  ci: 'CI 环境',
}

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  inverse: '\x1b[7m',
}

const useColor = process.stdout.isTTY && process.env.NO_COLOR == null
function paint(color, text) {
  return useColor ? `${COLORS[color]}${text}${COLORS.reset}` : text
}

// ---------------------------------------------------------------------------
// 环境识别
// ---------------------------------------------------------------------------

function detectEnv() {
  // 显式声明优先（Dockerfile 中通过 RELEASE_ENV=docker 指明镜像构建环境，
  // 避免仅凭 /.dockerenv 误判开发容器 / CI 容器）
  if (ENV_DEFAULTS[process.env.RELEASE_ENV]) return process.env.RELEASE_ENV
  if (process.env.CI) return 'ci'
  return 'local'
}

// ---------------------------------------------------------------------------
// 参数解析
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    interactive: null, // null = 自动（TTY 且未记忆“不再显示”时弹面板）
    forceSettings: false,
    env: null,
    overrides: {},
    forceInstall: false,
  }
  const args = argv.slice(2)
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    switch (arg) {
      case '-y':
      case '--yes':
      case '--no-interactive':
        opts.interactive = false
        break
      case '--settings':
      case '--config':
      case '--show-settings':
        opts.forceSettings = true
        break
      case '--force-install':
        opts.forceInstall = true
        break
      case '--install-only':
        opts.overrides.install = true
        opts.overrides.typecheck = false
        opts.overrides.build = false
        break
      case '--typecheck-only':
        opts.overrides.install = false
        opts.overrides.typecheck = true
        opts.overrides.build = false
        break
      case '--no-install':
        opts.overrides.install = false
        break
      case '--no-typecheck':
        opts.overrides.typecheck = false
        break
      case '--no-build':
        opts.overrides.build = false
        break
      case '--help':
      case '-h':
        printHelp()
        process.exit(0)
        break
      case '--env':
        opts.env = args[++i]
        break
      default:
        if (arg.startsWith('--env=')) {
          opts.env = arg.slice('--env='.length)
        } else {
          warn(`未知参数已忽略：${arg}`)
        }
    }
  }
  if (opts.env && !ENV_DEFAULTS[opts.env]) {
    warn(`未知环境 "${opts.env}"，回退到自动识别。可选：local / docker / ci`)
    opts.env = null
  }
  return opts
}

function printHelp() {
  console.log(`上线流水线：安装依赖 → 类型检查 → 打包校验

用法:
  npm run release                    弹出设置面板（非交互终端按默认/记忆执行）
  npm run release -- --settings      强制弹出设置面板
  npm run release -- -y              非交互直接执行（Docker 构建使用）
  npm run release -- --env docker    指定环境 local | docker | ci
  npm run release -- --no-install --no-typecheck
  npm run release -- --typecheck-only
  npm run release -- --force-install 删除 node_modules 后重装

设置保存在 frontend-user/.release-pipeline.json（已 gitignore，不影响他人）。`)
}

// ---------------------------------------------------------------------------
// 设置记忆
// ---------------------------------------------------------------------------

function defaultState(detectedEnv) {
  return {
    version: 1,
    // 环境始终自动识别（也可用 --env 临时覆盖），不做持久化；这里仅保留检测结果备查
    detectedEnv,
    skipSettings: false,
    steps: {
      local: { ...ENV_DEFAULTS.local },
      docker: { ...ENV_DEFAULTS.docker },
      ci: { ...ENV_DEFAULTS.ci },
    },
  }
}

function loadState(detectedEnv) {
  if (!existsSync(STATE_FILE)) return defaultState(detectedEnv)
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    const base = defaultState(detectedEnv)
    // 合并以防字段缺失；记忆值覆盖默认值
    for (const env of Object.keys(base.steps)) {
      if (raw.steps && raw.steps[env]) {
        base.steps[env] = { ...base.steps[env], ...raw.steps[env] }
      }
    }
    if (typeof raw.skipSettings === 'boolean') base.skipSettings = raw.skipSettings
    return base
  } catch (err) {
    warn(`设置文件解析失败（${err.message}），本次使用默认设置，不覆盖原文件。`)
    return defaultState(detectedEnv)
  }
}

function saveState(state) {
  try {
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`)
  } catch (err) {
    warn(`设置保存失败（${err.message}），本次选择不会被记忆。`)
  }
}

// ---------------------------------------------------------------------------
// 输出工具
// ---------------------------------------------------------------------------

function info(msg) {
  console.log(`${paint('cyan', 'ℹ')}  ${msg}`)
}
function success(msg) {
  console.log(`${paint('green', '✓')} ${msg}`)
}
function warn(msg) {
  console.log(`${paint('yellow', '⚠')} ${msg}`)
}
function fail(msg) {
  console.log(`${paint('red', '✗')} ${msg}`)
}
function banner(title) {
  const line = '─'.repeat(Math.max(4, 52 - title.length))
  console.log(paint('blue', `\n┌─ ${paint('bold', title)} ${line}`))
}
function bannerEnd() {
  console.log(paint('blue', '└' + '─'.repeat(56)))
}

// ---------------------------------------------------------------------------
// 设置面板
// ---------------------------------------------------------------------------

/**
 * 交互式设置面板。返回 { cancelled: true } 或 { env, steps, skipSettings }。
 */
function settingsPanel(initial) {
  return new Promise((resolve) => {
    const stdin = process.stdin
    const stdout = process.stdout

    if (typeof stdin.setRawMode !== 'function') {
      warn('当前终端不支持交互面板，按已记忆/默认设置直接执行。可用 --settings 在标准 TTY 中打开。')
      resolve({
        cancelled: false,
        env: initial.env,
        steps: { ...initial.steps[initial.env] },
        skipSettings: initial.skipSettings,
      })
      return
    }

    const draft = {
      env: initial.env,
      stepsByEnv: JSON.parse(JSON.stringify(initial.steps)),
      skipSettings: initial.skipSettings,
    }
    // 面板行：3 个步骤 + 1 个“不再显示” + 2 个动作
    const ROWS = STEPS.length + 3 // step rows 0..2, skip row 3, run row 4, quit row 5
    let cursor = 0

    function render() {
      if (useColor) stdout.write('\x1b[?25l') // 隐藏光标
      const L = []
      L.push('')
      L.push(paint('blue', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
      L.push(
        `${paint('bold', ' 上线流水线设置')}    ${paint(
          'gray',
          `当前环境：${ENV_LABELS[draft.env]}（${draft.env}）`,
        )}`,
      )
      L.push(paint('blue', '──────────────────────────────────────────────'))

      for (const step of STEPS) {
        const on = draft.stepsByEnv[draft.env][step.key]
        const checkbox = on ? paint('green', '[●] 开') : paint('gray', '[○] 关')
        L.push(
          row(
            cursor === step.index - 1,
            `${checkbox}  ${paint('bold', `${step.index}. ${step.name}`)}   ${paint(
              'gray',
              step.detail,
            )}`,
          ),
        )
      }

      const skipBox = draft.skipSettings ? paint('green', '[●] 开') : paint('gray', '[○] 关')
      L.push(
        row(
          cursor === STEPS.length,
          `${skipBox}  ${paint('bold', '4. 以后不再显示此面板')}   ${paint(
            'gray',
            '仍可用 --settings 打开',
          )}`,
        ),
      )

      L.push(paint('blue', '──────────────────────────────────────────────'))
      L.push(row(cursor === STEPS.length + 1, paint('bold', '▶ 开始执行')))
      L.push(row(cursor === STEPS.length + 2, paint('bold', '✕ 退出（不执行）')))
      L.push(paint('blue', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'))
      L.push(
        paint(
          'gray',
          ' ↑↓ / j k 移动 · 空格或回车切换开关 · e 切换环境 · r 执行 · q 退出 · 数字键 1-4 直接切换',
        ),
      )

      function row(selected, content) {
        return selected ? `${paint('inverse', ' ')}${paint('inverse', content)}` : ` ${content}`
      }

      stdout.write('\x1b[2J\x1b[H\x1b[3J')
      stdout.write(`${L.join('\n')}\n`)
    }

    function toggleCurrent() {
      if (cursor < STEPS.length) {
        const key = STEPS[cursor].key
        draft.stepsByEnv[draft.env][key] = !draft.stepsByEnv[draft.env][key]
      } else if (cursor === STEPS.length) {
        draft.skipSettings = !draft.skipSettings
      }
    }

    function cycleEnv() {
      const order = ['local', 'docker', 'ci']
      draft.env = order[(order.indexOf(draft.env) + 1) % order.length]
    }

    function finish(run) {
      if (useColor) {
        stdout.write('\x1b[?25h')
        stdin.setRawMode(false)
        stdout.write('\x1b[2J\x1b[H\x1b[3J')
      }
      stdin.pause()
      if (!run) {
        resolve({ cancelled: true })
        return
      }
      resolve({
        cancelled: false,
        env: draft.env,
        steps: { ...draft.stepsByEnv[draft.env] },
        stepsByEnv: draft.stepsByEnv,
        skipSettings: draft.skipSettings,
      })
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')
    render()

    stdin.on('data', (data) => {
      // 方向键转义序列
      if (data === '\x1b[A' || data === '\x1bOA') cursor = (cursor + ROWS - 1) % ROWS
      else if (data === '\x1b[B' || data === '\x1bOB') cursor = (cursor + 1) % ROWS
      else if (data === 'k') cursor = (cursor + ROWS - 1) % ROWS
      else if (data === 'j') cursor = (cursor + 1) % ROWS
      else if (data === ' ') {
        if (cursor <= STEPS.length) toggleCurrent()
        else if (cursor === STEPS.length + 1) finish(true)
        else finish(false)
      } else if (data === '\r' || data === '\n') {
        if (cursor <= STEPS.length) toggleCurrent()
        else if (cursor === STEPS.length + 1) finish(true)
        else finish(false)
      } else if (data === 'e' || data === 'E') cycleEnv()
      else if (data === 'r' || data === 'R') finish(true)
      else if (data === 'q' || data === 'Q' || data === '\x03') finish(false)
      // 数字键 1/2/3 切换对应步骤，4 切换“不再显示”
      else if (data === '1' || data === '2' || data === '3') {
        const idx = Number(data) - 1
        const key = STEPS[idx].key
        draft.stepsByEnv[draft.env][key] = !draft.stepsByEnv[draft.env][key]
      } else if (data === '4') {
        draft.skipSettings = !draft.skipSettings
      }
      render()
    })
  })
}

// ---------------------------------------------------------------------------
// 子进程执行
// ---------------------------------------------------------------------------

/**
 * 以继承输出的方式运行命令，实时把输出同时落盘。
 * 返回 { code, logFile }。
 */
function runLoggedStep(command, args, options = {}) {
  mkdirSync(LOG_DIR, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const logFile = join(LOG_DIR, `${options.label || 'step'}-${stamp}.log`)

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        ...(useColor ? { FORCE_COLOR: '1' } : {}),
      },
    })

    let chunks = ''
    const collect = (buf) => {
      chunks += buf
      // 简单限制内存占用（最多保留约 2MB）
      if (chunks.length > 2 * 1024 * 1024) chunks = chunks.slice(-1024 * 1024)
    }
    child.stdout.on('data', (buf) => {
      process.stdout.write(buf)
      collect(buf.toString())
    })
    child.stderr.on('data', (buf) => {
      process.stderr.write(buf)
      collect(buf.toString())
    })
    child.on('error', (err) => {
      collect(`${err.stack || err.message}\n`)
      writeFileSync(logFile, chunks)
      resolve({ code: 1, logFile })
    })
    child.on('close', (code) => {
      writeFileSync(logFile, chunks || '(无输出)\n')
      resolve({ code: code ?? 1, logFile })
    })
  })
}

/** npm install 直接继承终端输出（进度条体验更好） */
function runInstall(force) {
  return new Promise((resolve) => {
    if (force && existsSync(join(ROOT, 'node_modules'))) {
      info('--force-install：删除 node_modules 后重新安装')
      rmSync(join(ROOT, 'node_modules'), { recursive: true, force: true, maxRetries: 3 })
    }
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npm, ['install'], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 1))
  })
}

// ---------------------------------------------------------------------------
// 各步骤
// ---------------------------------------------------------------------------

async function stepInstall(ctx) {
  banner('步骤 1/3 · 安装依赖（npm install）')
  const code = await runInstall(ctx.forceInstall)
  if (code !== 0) {
    bannerEnd()
    return {
      ok: false,
      reason:
        'npm install 失败。常见原因：网络不通、registry 不可达、package.json 与 lock 文件冲突。',
    }
  }
  success('依赖安装完成')
  bannerEnd()
  return { ok: true }
}

async function stepTypecheck() {
  banner('步骤 2/3 · 类型检查（vue-tsc --noEmit）')
  const result = await runLoggedStep(
    process.execPath,
    [join('node_modules', 'vue-tsc', 'bin', 'vue-tsc.js'), '--noEmit', '-p', 'tsconfig.json'],
    { label: 'typecheck' },
  )
  bannerEnd()
  if (result.code !== 0) {
    return {
      ok: false,
      reason: 'TypeScript 类型检查未通过（详见上方报错；通常是类型不匹配、缺失类型或 .vue 模板类型错误）。',
      logFile: result.logFile,
    }
  }
  success('类型检查通过')
  return { ok: true }
}

async function stepBuild() {
  banner('步骤 3/3 · 打包校验（vite build，含 SCSS 编译）')

  // 清掉上次失败可能残留的临时目录，确保本次从干净状态开始
  rmSync(TMP_BUILD_DIR, { recursive: true, force: true })

  const result = await runLoggedStep(
    process.execPath,
    [
      join('node_modules', 'vite', 'bin', 'vite.js'),
      'build',
      '--outDir',
      TMP_BUILD_DIR,
      '--emptyOutDir',
    ],
    { label: 'build' },
  )

  if (result.code !== 0) {
    // 失败：删除本次半成品，dist 维持上次成功产物，不留任何中间产物
    rmSync(TMP_BUILD_DIR, { recursive: true, force: true })
    bannerEnd()
    return {
      ok: false,
      reason:
        '打包失败（vite build）。常见原因：SCSS 语法/编译错误、import 路径不存在、插件或语法报错。',
      logFile: result.logFile,
    }
  }

  // 成功：原子替换 dist
  const distDir = join(ROOT, 'dist')
  try {
    renameSync(TMP_BUILD_DIR, distDir)
  } catch {
    // Windows 上目标存在时 rename 可能失败：先删旧目录再替换
    rmSync(distDir, { recursive: true, force: true, maxRetries: 3 })
    renameSync(TMP_BUILD_DIR, distDir)
  }
  success(`打包成功，产物已输出到 dist/`)
  bannerEnd()
  return { ok: true }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv)
  const detectedEnv = detectEnv()
  const state = loadState(detectedEnv)
  // 环境始终自动识别，--env 仅本次覆盖；面板里按 e 切换也只对本次生效
  const env = opts.env || detectedEnv

  let chosen

  const isTTY = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  const wantPanel =
    opts.forceSettings ||
    (opts.interactive === null && isTTY && !state.skipSettings) ||
    opts.interactive === true

  if (wantPanel) {
    const panelResult = await settingsPanel({
      env,
      steps: state.steps,
      skipSettings: state.skipSettings,
    })
    if (panelResult.cancelled) {
      warn('已退出，未执行任何步骤。')
      process.exit(1)
    }
    chosen = panelResult
    // 记忆：面板里的逐项开关按环境保存；“不再显示”也记住（环境始终自动识别，不持久化）
    state.steps = panelResult.stepsByEnv
    state.skipSettings = panelResult.skipSettings
    saveState(state)
  } else {
    chosen = {
      env,
      steps: { ...state.steps[env] },
      skipSettings: state.skipSettings,
    }
  }

  // CLI 一次性开关覆盖记忆/默认
  const steps = { ...chosen.steps, ...opts.overrides }

  // 极端情况下 node_modules 不存在却关闭了安装：给出提示
  if (!steps.install && !existsSync(join(ROOT, 'node_modules')) && chosen.env === 'local') {
    warn('未开启「安装依赖」且 node_modules 不存在，后续步骤可能找不到命令。')
  }

  const enabled = STEPS.filter((s) => steps[s.key])
  banner('上线流水线')
  console.log(`  环境    : ${paint('bold', ENV_LABELS[chosen.env])}（${chosen.env}）`)
  console.log(
    `  执行环节: ${
      enabled.length
        ? enabled.map((s) => `${s.index}.${s.name}`).join(paint('gray', ' → '))
        : paint('yellow', '（全部关闭）')
    }`,
  )
  console.log(
    `  已关闭  : ${
      STEPS.filter((s) => !steps[s.key])
        .map((s) => s.name)
        .join('、') || '无'
    }`,
  )
  bannerEnd()

  if (!enabled.length) {
    warn('没有任何开启的环节，已结束。可在设置面板中逐项开启。')
    process.exit(1)
  }

  // 开头先清理陈旧临时目录（上次异常退出可能残留）
  rmSync(TMP_BUILD_DIR, { recursive: true, force: true })

  const ctx = { forceInstall: opts.forceInstall }

  for (const step of STEPS) {
    if (!steps[step.key]) {
      console.log(paint('gray', `○ 步骤 ${step.index}/3 · ${step.name}（已跳过）`))
      continue
    }

    let result
    if (step.key === 'install') result = await stepInstall(ctx)
    else if (step.key === 'typecheck') result = await stepTypecheck()
    else result = await stepBuild()

    if (!result.ok) {
      console.log('')
      fail(paint('bold', `流水线在「步骤 ${step.index}/3 · ${step.name}」中断`))
      console.log(`  原因：${result.reason}`)
      if (result.logFile) console.log(`  日志：${paint('cyan', result.logFile)}`)
      console.log(
        `  ${paint('yellow', '修复后重新执行')} npm run release 即可从第一步重试；` +
          `失败的中间产物已自动清理，dist/ 保留上次成功产物。`,
      )
      process.exit(1)
    }
  }

  console.log('')
  if (steps.build) {
    success(paint('bold', '全部环节通过，可以上线。产物目录：dist/'))
  } else {
    success(paint('bold', `已开启的环节全部通过（本次未执行打包，dist/ 未更新）。`))
  }
  process.exit(0)
}

main().catch((err) => {
  fail(`流水线异常：${err.stack || err.message}`)
  process.exit(1)
})
