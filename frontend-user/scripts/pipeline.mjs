#!/usr/bin/env node
/**
 * 发布流水线编排脚本：安装依赖 → 类型检查 → 打包校验
 *
 * 设计要点：
 * - 所有环节开关集中在 pipeline.config.json 的「一栏设置」里；
 * - 各环节是否执行按当前环境（local / docker / ci）取配置中的默认值；
 * - 用户通过命令行逐项开关，选择会被记住（.pipeline/state.json），下次自动沿用；
 * - 任一环节失败立即停止，明确显示卡在哪一步、原因与完整日志位置；
 * - 失败后重试前会清理该环节的残留产物，构建环节同时保证 outDir 干净，避免半成品污染。
 *
 * 用法见 `node scripts/pipeline.mjs --help`。
 */
import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = join(ROOT, 'pipeline.config.json')
const STATE_DIR = join(ROOT, '.pipeline')
const STATE_PATH = join(STATE_DIR, 'state.json')
const LOG_PATH = join(STATE_DIR, 'last-run.log')

// ---------------------------------------------------------------------------
// 终端颜色（非 TTY 或设置 NO_COLOR 时自动关闭）
// ---------------------------------------------------------------------------
const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s))
const dim = (s) => c('90', s)
const red = (s) => c('31', s)
const green = (s) => c('32', s)
const yellow = (s) => c('33', s)
const cyan = (s) => c('36', s)
const bold = (s) => c('1', s)

// ---------------------------------------------------------------------------
// 配置与命令行参数
// ---------------------------------------------------------------------------
function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error(red(`找不到流水线配置：${CONFIG_PATH}`))
    process.exit(2)
  }
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
}

const HELP = `发布流水线：安装依赖 → 类型检查 → 打包校验

用法：
  npm run pipeline [-- 选项]

选项（逐项开关，会记住本次选择，下次默认沿用）：
  --install / --no-install        开 / 关「安装依赖」
  --typecheck / --no-typecheck    开 / 关「类型检查」
  --build / --no-build            开 / 关「打包校验」
  --env <local|docker|ci>         覆盖自动识别的当前环境
  --reset-settings                清除已记住的选择，恢复当前环境默认值
  -h, --help                      显示本帮助

默认值集中在 pipeline.config.json，按环境自动选择；原有的
npm run dev / npm run build / docker-compose up --build 均不受影响。`

function parseArgs(config, argv) {
  const stepIds = new Set(config.steps.map((s) => s.id))
  const options = {
    toggles: {}, // stepId -> true/false（仅记录命令行显式指定的）
    envOverride: null,
    resetSettings: false,
    showHelp: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') {
      options.showHelp = true
    } else if (arg === '--reset-settings') {
      options.resetSettings = true
    } else if (arg === '--env') {
      options.envOverride = argv[++i]
    } else if (arg.startsWith('--env=')) {
      options.envOverride = arg.slice('--env='.length)
    } else if (arg.startsWith('--no-')) {
      const id = arg.slice('--no-'.length)
      if (!stepIds.has(id)) failUnknown(arg)
      options.toggles[id] = false
    } else if (arg.startsWith('--')) {
      const id = arg.slice(2)
      if (!stepIds.has(id)) failUnknown(arg)
      options.toggles[id] = true
    } else {
      failUnknown(arg)
    }
  }
  if (options.envOverride && !config.environments.includes(options.envOverride)) {
    console.error(red(`未知环境：${options.envOverride}，可选：${config.environments.join(' / ')}`))
    process.exit(2)
  }
  return options
}

function failUnknown(arg) {
  console.error(red(`无法识别的参数：${arg}（使用 --help 查看用法）`))
  process.exit(2)
}

// ---------------------------------------------------------------------------
// 环境识别
// ---------------------------------------------------------------------------
function detectEnvironment(override) {
  if (override) return override
  if (process.env.BUILD_PIPELINE_ENV) return process.env.BUILD_PIPELINE_ENV
  // CI 往往也运行在容器里，需在 /.dockerenv 之前判断；
  // 镜像构建场景由 Dockerfile 显式设置 BUILD_PIPELINE_ENV=docker
  if (process.env.CI) return 'ci'
  if (fsExists('/.dockerenv')) return 'docker'
  return 'local'
}

function fsExists(p) {
  try {
    return existsSync(p)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 记忆设置（.pipeline/state.json，按环境分别记忆）
// ---------------------------------------------------------------------------
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'))
  } catch {
    return { version: 1, environments: {} }
  }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n')
}

// ---------------------------------------------------------------------------
// 展示辅助（按东亚字符宽度对齐，避免中文标题错位）
// ---------------------------------------------------------------------------
function charWidth(ch) {
  const cp = ch.codePointAt(0)
  if (cp >= 0x1100 && (
    cp <= 0x115f || cp === 0x2329 || cp === 0x232a ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )) {
    return 2
  }
  return 1
}

function displayWidth(s) {
  let w = 0
  for (const ch of s) w += charWidth(ch)
  return w
}

function padEnd(s, width) {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)))
}

// ---------------------------------------------------------------------------
// 产物清理（构建前清空 outDir、失败后清空残留半成品）
// ---------------------------------------------------------------------------
function cleanArtifacts(step, reason) {
  for (const artifact of step.artifacts ?? []) {
    const target = join(ROOT, artifact)
    rmSync(target, { recursive: true, force: true })
    console.log(dim(`  · 已清理 ${artifact}（${reason}）`))
  }
}

// ---------------------------------------------------------------------------
// 单环节执行：输出同时进入终端与日志文件
// ---------------------------------------------------------------------------
function runStep(step, index, total, log) {
  const shownCmd = [step.command, ...step.args].join(' ')
  console.log('')
  console.log(bold(cyan(`[${index}/${total}] ${step.name}`)) + dim(`  (${shownCmd})`))
  log.write(`\n===== [${index}/${total}] ${step.name} — ${shownCmd} =====\n`)

  // 构建前保证产物目录干净，避免混入上次的中间产物
  if (step.id === 'build') cleanArtifacts(step, '构建前清空产物目录')

  const startedAt = Date.now()
  return new Promise((resolve) => {
    const child = spawn(step.command, step.args, {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
      shell: process.platform === 'win32',
    })
    child.stdout.on('data', (d) => {
      process.stdout.write(d)
      log.write(d)
    })
    child.stderr.on('data', (d) => {
      process.stderr.write(d)
      log.write(d)
    })
    child.on('error', (err) => {
      console.error(red(`无法启动命令 ${shownCmd}：${err.message}`))
      resolve({ code: 1, duration: Date.now() - startedAt })
    })
    child.on('close', (code) => {
      resolve({ code: code ?? 1, duration: Date.now() - startedAt })
    })
  })
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
async function main() {
  const config = loadConfig()
  const options = parseArgs(config, process.argv.slice(2))
  if (options.showHelp) {
    console.log(HELP)
    return
  }

  const env = detectEnvironment(options.envOverride)
  let state = loadState()
  if (options.resetSettings) {
    delete state.environments?.[env]
    console.log(yellow(`已清除「${env}」环境下记住的选择，恢复配置默认值。`))
  }
  const remembered = { ...(state.environments?.[env]?.toggles ?? {}) }
  // 命令行显式开关优先级最高，并写入记忆
  for (const [id, on] of Object.entries(options.toggles)) remembered[id] = on
  state.environments[env] = { toggles: remembered, updatedAt: new Date().toISOString() }
  mkdirSync(STATE_DIR, { recursive: true })
  saveState(state)

  // 解析每个环节最终是否执行：命令行 > 上次选择 > 当前环境默认（全 true）
  const resolved = config.steps.map((step) => ({
    step,
    enabled: remembered[step.id] ?? step.defaults[env] ?? true,
    source: step.id in remembered ? '已记住的选择' : '环境默认',
  }))

  // 设置面板：所有环节开关收在这一栏
  console.log(bold('发布流水线设置'))
  console.log(dim('─'.repeat(56)))
  const labelWidth = Math.max(...resolved.map((r) => displayWidth(r.step.name)))
  for (const { step, enabled, source } of resolved) {
    const status = enabled ? green('● 开启') : dim('○ 关闭')
    console.log(`  ${padEnd(step.name, labelWidth)}  ${status}  ${dim(source)}`)
  }
  console.log(dim('─'.repeat(56)))
  console.log(`  当前环境：${bold(env)}（local=本地 docker=容器镜像 ci=持续集成）`)
  console.log(`  集中设置：${dim('pipeline.config.json')}`)
  console.log(`  记忆文件：${dim('.pipeline/state.json')}`)
  console.log(`  执行日志：${dim('.pipeline/last-run.log')}`)

  const enabledSteps = resolved.filter((r) => r.enabled).map((r) => r.step)
  if (enabledSteps.length === 0) {
    console.log(yellow('\n所有环节均已关闭，没有可执行的内容。'))
    console.log(dim('可使用 --install / --typecheck / --build 逐项打开。'))
    return
  }

  const log = openLog()
  log.write(`pipeline run @ ${new Date().toISOString()}，env=${env}`)

  const results = []
  let failed = null
  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i]
    const enabled = enabledSteps.includes(step)
    if (!enabled) {
      results.push({ step, status: 'skipped', code: 0, duration: 0 })
      continue
    }
    const { code, duration } = await runStep(step, results.filter((r) => r.status !== 'skipped').length + 1, enabledSteps.length, log)
    results.push({ step, status: code === 0 ? 'passed' : 'failed', code, duration })
    if (code !== 0) {
      failed = { step, code }
      // 清理失败环节自身以及后续已开启但未执行环节的产物，
      // 保证重试时不会混入上次失败留下的半成品（被关闭的环节产物不动）
      cleanArtifacts(step, '该环节执行失败，清除残留产物')
      for (const later of config.steps.slice(i + 1)) {
        if (enabledSteps.includes(later)) cleanArtifacts(later, `前置环节「${step.name}」失败，清除未执行环节的旧产物`)
      }
      break
    }
  }

  endLog(log)
  printSummary(results)

  if (failed) {
    console.log('')
    console.log(red(bold(`✗ 流水线在「${failed.step.name}」环节中断（退出码 ${failed.code}）`)))
    if (failed.step.failureHint) console.log(red(`  原因排查：${failed.step.failureHint}`))
    console.log(dim(`  完整日志：.pipeline/last-run.log`))
    console.log(dim(`  修复后重新执行 npm run pipeline 即可重试，已自动清除失败环节的残留产物。`))
    process.exit(1)
  }
  console.log('')
  console.log(green(bold('✓ 流水线全部通过，可以发布。')))
}

// 日志：同步 fd 写入，进程失败退出时日志也能完整落盘
function openLog() {
  mkdirSync(STATE_DIR, { recursive: true })
  const fd = openSync(LOG_PATH, 'w')
  return {
    write(chunk) {
      writeSync(fd, chunk)
    },
    close() {
      closeSync(fd)
    },
  }
}

function endLog(log) {
  log.close()
}

function printSummary(results) {
  console.log('')
  console.log(bold('执行结果'))
  console.log(dim('─'.repeat(56)))
  const icon = { passed: green('✓ 通过'), failed: red('✗ 失败'), skipped: dim('— 跳过') }
  const nameWidth = Math.max(...results.map((r) => displayWidth(r.step.name)))
  for (const { step, status, duration } of results) {
    const cost = status === 'skipped' ? '' : dim(`${(duration / 1000).toFixed(2)}s`)
    console.log(`  ${padEnd(step.name, nameWidth)}  ${icon[status]}  ${cost}`)
  }
  console.log(dim('─'.repeat(56)))
}

main().catch((err) => {
  console.error(red(`流水线异常：${err.stack || err.message || err}`))
  process.exit(1)
})
