/**
 * Build the dsh desktop runtime closure for Tauri bundling. The deploy flags,
 * symlink-materialization pass, and closure-manifest model reuse the Python
 * SDK single-exe pipeline
 * (.agents/notes/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md);
 * the destination is a Tauri `bundle.resources` directory instead of a pkg VFS.
 *
 * Pipeline: verify closure → build → pnpm deploy (hoisted, legacy) → restore
 * legacy hoists → materialize symlinks → stage dsh CLI lib/ + config/ → copy
 * into apps/desktop/src-tauri/resources/dsh-runtime/.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

const root = resolve(import.meta.dirname, '..')

/** The closure manifest whose dependencies define the bundled runtime. */
const DEPLOY_ROOT_PACKAGE = '@deepseek-ai/dsh-desktop-runtime'
/** Legacy deploy may hoist peer-specialized workspace packages back here. */
const DEPLOY_SOURCE_NODE_MODULES = 'apps/desktop/desktop-runtime/node_modules'
/** The Tauri resource destination; bundle.resources copies this at build time. */
const RESOURCE_DIR = resolve(root, 'apps/desktop/src-tauri/resources/dsh-runtime')
/** Documentation excluded from the staged runtime directory. */
const DEPLOY_ONLY_DOCS = ['README.md', 'README.zh.md', 'README.i18n.yaml']

/**
 * Validated CLI configuration; construction owns help and parse-error exits.
 */
class Cli {
  private constructor(
    /** Skip `pnpm run build`; lib/ artifacts must already exist. */
    readonly skipBuild: boolean,
    /** Skip `verify-runtime-closure`. */
    readonly skipVerify: boolean,
    /** Print every command and filesystem change instead of executing. */
    readonly dryRun: boolean,
  ) {}

  /** Parse argv. Help exits 0; malformed flags exit 1. */
  static parse(argv: string[]): Cli {
    let values: ReturnType<typeof Cli.parseRaw>
    try {
      values = Cli.parseRaw(argv)
    } catch (error) {
      console.error(`build-desktop-runtime: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(Cli.usage())
      process.exit(1)
    }
    if (values.help) {
      console.log(Cli.usage())
      process.exit(0)
    }
    return new Cli(values['skip-build'], values['skip-verify'], values['dry-run'])
  }

  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'skip-build': { type: 'boolean', default: false },
        'skip-verify': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  private static usage(): string {
    return [
      'Usage: pnpm exec tsx scripts/build-desktop-runtime.ts [flags]',
      '',
      '  --skip-build    skip `pnpm run build` (lib/ artifacts must already exist).',
      '  --skip-verify   skip `pnpm run verify-runtime-closure`.',
      '  --dry-run       print every command and filesystem change without executing.',
      '  --help          print this help.',
      '',
      `Stages the runtime into ${RESOURCE_DIR}.`,
    ].join('\n')
  }
}

function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

/**
 * Spawn a command on Windows reliably. Node 22+ blocks spawning .cmd/.bat
 * files without `shell: true` (CVE-2024-27980), but `shell: true` re-parses
 * arguments and can mangle paths. Wrapping in `cmd /c` with the command as a
 * single string avoids both problems.
 * @param command - the executable (e.g. pnpm.cmd).
 * @param args - its arguments.
 * @param options - spawn options.
 * @returns the ChildProcess.
 */
function spawnReliable(command: string, args: string[], options: SpawnOptions): ChildProcess {
  if (process.platform === 'win32') {
    const line = [command, ...args].map(a => /\s/.test(a) ? `"${a}"` : a).join(' ')
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], options)
  }
  return spawn(command, args, options)
}

/**
 * Render a command for logs and errors, quoting arguments with spaces.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns the printable command line.
 */
function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map(part => (part.includes(' ') ? JSON.stringify(part) : part)).join(' ')
}

/**
 * Run one subprocess with inherited stdio.
 * @param label - the step name used in logs and error messages.
 * @param command - the executable.
 * @param args - its arguments.
 * @param dryRun - when true, print instead of executing.
 */
async function run(label: string, command: string, args: string[], dryRun: boolean): Promise<void> {
  const printable = formatCommand(command, args)
  if (dryRun) {
    console.log(`build-desktop-runtime: [dry-run] ${printable}`)
    return
  }
  console.log(`build-desktop-runtime: ${label}: ${printable}`)
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawnReliable(command, args, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, CI: 'true' },
    })
    child.once('error', (error) => {
      reject(new Error(`build-desktop-runtime: ${label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`build-desktop-runtime: ${label} failed (${cause}): ${printable}`))
    })
  })
}

/**
 * Return the first symbolic link below a directory, if one exists.
 * @param directory - the directory to scan recursively.
 * @returns the first symlink path found, or undefined.
 */
async function findSymlink(directory: string): Promise<string | undefined> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findSymlink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Replace deploy-time package links with files and reject any remaining link.
 * Mirrors the Python SDK pipeline so the staged closure is symlink-free (pnpm
 * isolated links break inside a Tauri resource directory on Windows).
 * @param staging - the deployed closure root.
 * @param dryRun - when true, print instead of executing.
 */
async function materializeStagedLinks(staging: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log('build-desktop-runtime: [dry-run] materialize staged package links')
    return
  }
  const nodeModules = join(staging, 'node_modules')
  let remaining = await findSymlink(nodeModules)
  while (remaining !== undefined) {
    const segments = remaining.slice(nodeModules.length + 1).split(sep)
    const binIndex = segments.lastIndexOf('.bin')
    if (binIndex >= 0) {
      await rm(join(nodeModules, ...segments.slice(0, binIndex + 1)), { recursive: true, force: true })
      remaining = await findSymlink(nodeModules)
      continue
    }
    const destination = remaining
    const source = await realpath(destination)
    const nestedNodeModules = join(source, 'node_modules')
    await rm(destination, { recursive: true, force: true })
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    remaining = await findSymlink(nodeModules)
  }
}

/**
 * Restore direct packages that pnpm's legacy hoister places beside the deploy
 * source instead of in the target.
 * @param staging - the deployed closure root.
 * @param dryRun - when true, print instead of executing.
 */
async function restoreLegacyHoists(staging: string, dryRun: boolean): Promise<void> {
  if (dryRun) {
    console.log('build-desktop-runtime: [dry-run] restore direct dependencies omitted by legacy deploy')
    return
  }
  const manifestPath = join(staging, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    dependencies?: Record<string, string>
  }
  const sourceNodeModules = resolve(root, DEPLOY_SOURCE_NODE_MODULES)
  const restored: string[] = []
  for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
    const destination = join(staging, 'node_modules', dependency)
    if (existsSync(destination)) continue
    const source = join(sourceNodeModules, dependency)
    if (!existsSync(source)) {
      throw new Error(
        `build-desktop-runtime: deployed dependency ${dependency} is absent from both ${destination} and ${source}.`,
      )
    }
    await mkdir(dirname(destination), { recursive: true })
    const nestedNodeModules = join(source, 'node_modules')
    await cp(source, destination, {
      recursive: true,
      dereference: true,
      filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
    })
    restored.push(dependency)
  }
  if (restored.length > 0) {
    console.log(`build-desktop-runtime: restored legacy deploy hoists: ${restored.join(', ')}`)
  }
}

/**
 * Copy the dsh CLI entry (lib/ + config/) into the staged runtime root so the
 * bundled Node can launch `lib/bin.js` with bare-specifier resolution against
 * the sibling node_modules.
 * @param staging - the deployed closure root.
 * @param dryRun - when true, print instead of executing.
 */
async function stageCliEntry(staging: string, dryRun: boolean): Promise<void> {
  const cliLib = resolve(root, 'apps/cli/lib')
  const cliConfig = resolve(root, 'apps/cli/config')
  if (dryRun) {
    console.log(`build-desktop-runtime: [dry-run] cp ${cliLib} ${join(staging, 'lib')}`)
    console.log(`build-desktop-runtime: [dry-run] cp ${cliConfig} ${join(staging, 'config')}`)
    return
  }
  if (!existsSync(cliLib)) {
    throw new Error(`build-desktop-runtime: ${cliLib} missing — run without --skip-build so lib/ artifacts exist.`)
  }
  await cp(cliLib, join(staging, 'lib'), { recursive: true })
  await cp(cliConfig, join(staging, 'config'), { recursive: true })
  console.log('build-desktop-runtime: staged dsh CLI lib/ and config/')
}

/**
 * Assert the staged closure contains zero symbolic links. A residual link would
 * break bare-specifier resolution inside the Tauri resource directory.
 * @param staging - the deployed closure root.
 */
async function assertNoSymlinks(staging: string): Promise<void> {
  const nodeModules = join(staging, 'node_modules')
  if (!existsSync(nodeModules)) return
  const remaining = await findSymlink(nodeModules)
  if (remaining !== undefined) {
    throw new Error(`build-desktop-runtime: residual symlink after materialization: ${remaining}`)
  }
  console.log('build-desktop-runtime: verified zero symlinks in staged node_modules')
}

async function main(): Promise<void> {
  const cli = Cli.parse(process.argv.slice(2))

  if (!cli.skipVerify) {
    await run('runtime dependency closure', pnpmBin(), ['run', 'verify-runtime-closure'], cli.dryRun)
  }
  if (!cli.skipBuild) {
    await run('build', pnpmBin(), ['run', 'build'], cli.dryRun)
  }

  // Clear and create the Tauri resource destination.
  if (RESOURCE_DIR === root || root.startsWith(RESOURCE_DIR + sep)) {
    throw new Error(`build-desktop-runtime: refusing to clear ${RESOURCE_DIR}: it contains the repo root.`)
  }
  if (cli.dryRun) {
    console.log(`build-desktop-runtime: [dry-run] rm -rf ${RESOURCE_DIR}`)
    console.log(`build-desktop-runtime: [dry-run] mkdir ${RESOURCE_DIR}`)
  } else {
    await rm(RESOURCE_DIR, { recursive: true, force: true })
    await mkdir(RESOURCE_DIR, { recursive: true })
  }

  // Deploy the closure hoisted into the resource dir. --ignore-scripts skips
  // lifecycle scripts (postinstall etc.) that reference devDependencies absent
  // from the --prod closure.
  await run('deploy', pnpmBin(), [
    '--filter',
    DEPLOY_ROOT_PACKAGE,
    'deploy',
    '--legacy',
    '--prod',
    '--ignore-scripts',
    '--config.node-linker=hoisted',
    '--config.auto-install-peers=false',
    '--config.link-workspace-packages=true',
    RESOURCE_DIR,
  ], cli.dryRun)

  await restoreLegacyHoists(RESOURCE_DIR, cli.dryRun)
  await materializeStagedLinks(RESOURCE_DIR, cli.dryRun)
  await stageCliEntry(RESOURCE_DIR, cli.dryRun)

  if (!cli.dryRun) {
    for (const name of DEPLOY_ONLY_DOCS) await rm(join(RESOURCE_DIR, name), { force: true })
    await assertNoSymlinks(RESOURCE_DIR)
    await pruneRuntime(RESOURCE_DIR)

    // Report the staged size so the bundle footprint is visible.
    const sizeBytes = await dirSize(RESOURCE_DIR)
    console.log(`build-desktop-runtime: staged runtime at ${RESOURCE_DIR} (${(sizeBytes / (1024 * 1024)).toFixed(1)} MB)`)

    // Zip the runtime into a single archive so NSIS packages one file instead
    // of thousands of deeply-nested paths (which exceed makensis path limits).
    // The Rust host extracts it to app_data_dir on first launch.
    const zipPath = join(dirname(RESOURCE_DIR), 'dsh-runtime.zip')
    await zipDirectory(RESOURCE_DIR, zipPath)
    const zipMb = statSync(zipPath).size / (1024 * 1024)
    console.log(`build-desktop-runtime: zipped runtime to ${zipPath} (${zipMb.toFixed(1)} MB)`)

    // Remove the unpacked directory; only the zip ships as a Tauri resource.
    await rm(RESOURCE_DIR, { recursive: true, force: true })
  }
}

/**
 * File patterns that are unnecessary at runtime. Removing them shrinks the
 * bundle and avoids Windows long-path failures in NSIS/makensis (deeply nested
 * node_modules can exceed the 260-char path limit).
 */
const RUNTIME_PRUNE_PATTERNS = [
  /\.d\.ts$/,
  /\.d\.ts\.map$/,
  /\.tsbuildinfo$/,
  /\.js\.map$/,
  /\.cjs\.map$/,
  /\.mjs\.map$/,
  /\.css\.map$/,
  /\/tests?$/,
  /\/__tests__$/,
  /\/test$/,
  /\.test\.js$/,
  /\.spec\.js$/,
  /\.md$/,
  /\.markdown$/,
  /\/docs?$/,
  /LICENSE/i,
  /CHANGELOG/i,
]

/**
 * Remove non-runtime files (type declarations, sourcemaps, test directories)
 * from the staged closure. This reduces the payload by roughly half and
 * prevents NSIS from failing on deeply nested path names.
 * @param directory - the staged runtime root.
 */
async function pruneRuntime(directory: string): Promise<void> {
  let pruned = 0
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      const relativePath = path.slice(directory.length).replace(/\\/g, '/')
      if (entry.isDirectory()) {
        if (RUNTIME_PRUNE_PATTERNS.some(pattern => pattern.test(relativePath + '/'))) {
          await rm(path, { recursive: true, force: true })
          pruned++
          continue
        }
        await walk(path)
      } else if (RUNTIME_PRUNE_PATTERNS.some(pattern => pattern.test(relativePath))) {
        await rm(path, { force: true })
        pruned++
      }
    }
  }
  await walk(directory)
  console.log(`build-desktop-runtime: pruned ${pruned} non-runtime files/dirs`)
}

/** Sum file sizes recursively; used to report the staged footprint. */
async function dirSize(directory: string): Promise<number> {
  let total = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      total += await dirSize(path)
    } else {
      total += statSync(path).size
    }
  }
  return total
}

/**
 * Zip a directory using the system zip command (available on all target
 * platforms). The archive contains the directory contents at the top level so
 * the Rust host can extract directly into a target directory.
 * @param source - the directory to archive.
 * @param destZip - the destination zip file path.
 */
async function zipDirectory(source: string, destZip: string): Promise<void> {
  await rm(destZip, { force: true })
  await new Promise<void>((resolvePromise, reject) => {
    const child: ChildProcess = spawn(process.platform === 'win32' ? '7z' : 'zip', process.platform === 'win32' ? ['a', '-tzip', destZip, `${source}\\*`] : ['-r', '-q', destZip, '.'], {
      cwd: source,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`build-desktop-runtime: zip failed (exit ${code}).`))
    })
  })
}

await main()
