/**
 * Download and stage a Windows Node binary for the desktop Tauri build. Reuses
 * the wine-windows-gates download pattern: resolve the latest release of the
 * target major from nodejs.org/dist/index.json, download the win-x64 zip,
 * verify against SHASUMS256.txt, cache under .cache/desktop-node/, and extract
 * node.exe to the Tauri externalBin path with the target-triple suffix that
 * `bundle.externalBin` requires.
 *
 * Offline runs fall back to the newest cached zip, loudly.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pipeline } from 'node:stream/promises'

const root = resolve(import.meta.dirname, '..')

/** Default Node major; matches the wine-gates target and the pkg exe. */
const DEFAULT_NODE_MAJOR = 24
/** Cache directory for downloaded zips. */
const CACHE_DIR = resolve(root, '.cache/desktop-node')
/** Tauri externalBin destination; the suffix is the Windows target triple. */
const BINARIES_DIR = resolve(root, 'apps/desktop/src-tauri/binaries')
const NODE_EXE_NAME = 'node-x86_64-pc-windows-msvc.exe'

/**
 * Validated CLI configuration; construction owns help and parse-error exits.
 */
class Cli {
  private constructor(
    /** Node major version to resolve. */
    readonly nodeMajor: number,
    /** Print actions instead of executing. */
    readonly dryRun: boolean,
  ) {}

  /** Parse argv. Help exits 0; malformed flags exit 1. */
  static parse(argv: string[]): Cli {
    let values: ReturnType<typeof Cli.parseRaw>
    try {
      values = Cli.parseRaw(argv)
    } catch (error) {
      console.error(`fetch-node-for-desktop: ${error instanceof Error ? error.message : String(error)}\n`)
      console.error(Cli.usage())
      process.exit(1)
    }
    if (values.help) {
      console.log(Cli.usage())
      process.exit(0)
    }
    const nodeMajor = values['node-major'] === undefined
      ? DEFAULT_NODE_MAJOR
      : Number.parseInt(values['node-major'], 10)
    if (!Number.isInteger(nodeMajor) || nodeMajor < 22) {
      throw new Error(`fetch-node-for-desktop: --node-major must be an integer >= 22, got ${JSON.stringify(values['node-major'])}.`)
    }
    return new Cli(nodeMajor, values['dry-run'])
  }

  private static parseRaw(argv: string[]) {
    return parseArgs({
      args: argv,
      options: {
        'node-major': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        'help': { type: 'boolean', default: false },
      },
    }).values
  }

  private static usage(): string {
    return [
      'Usage: pnpm exec tsx scripts/fetch-node-for-desktop.ts [flags]',
      '',
      '  --node-major=<n>  Node major to resolve (default: 24).',
      '  --dry-run         print actions without executing.',
      '  --help            print this help.',
      '',
      `Stages node.exe to ${join(BINARIES_DIR, NODE_EXE_NAME)}.`,
    ].join('\n')
  }
}

/**
 * Fetch a URL as text. Throws on non-200 or network error.
 * @param url - the URL to fetch.
 * @returns the response body as text.
 */
async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`fetch-node-for-desktop: ${url} returned HTTP ${response.status}.`)
  return response.text()
}

/**
 * Download a URL to a file, with a timeout and stall guard.
 * @param url - the URL to download.
 * @param dest - the destination file path.
 */
async function downloadFile(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(300_000) })
  if (!response.ok || response.body === null) {
    throw new Error(`fetch-node-for-desktop: ${url} returned HTTP ${response.status}.`)
  }
  const stream = createWriteStream(dest)
  await pipeline(response.body, stream)
}

/**
 * Verify a file matches an expected SHA-256 hash.
 * @param expected - the hex digest from SHASUMS256.txt.
 * @param file - the file to verify.
 */
async function verifySha256(expected: string, file: string): Promise<void> {
  const buffer = await readFile(file)
  const actual = createHash('sha256').update(buffer).digest('hex')
  if (actual !== expected) {
    throw new Error(`fetch-node-for-desktop: SHA-256 mismatch for ${file}: expected ${expected}, got ${actual}.`)
  }
}

/**
 * Resolve the latest version of the target major from nodejs.org/dist/index.json.
 * @param nodeMajor - the major version to resolve.
 * @returns the version string including the `v` prefix, or undefined if unreachable.
 */
async function resolveLatestVersion(nodeMajor: number): Promise<string | undefined> {
  try {
    const index = JSON.parse(await fetchText('https://nodejs.org/dist/index.json')) as Array<{ version: string }>
    const entry = index.find(row => row.version.startsWith(`v${nodeMajor}.`))
    return entry?.version
  } catch {
    return undefined
  }
}

/**
 * Find the newest cached zip for the target major, for offline fallback.
 * @param nodeMajor - the major version to match.
 * @returns the cached zip path, or undefined.
 */
async function newestCachedZip(nodeMajor: number): Promise<string | undefined> {
  if (!existsSync(CACHE_DIR)) return undefined
  const entries = await readdir(CACHE_DIR)
  const zips = entries
    .filter(name => name.startsWith(`node-v${nodeMajor}.`) && name.endsWith('-win-x64.zip'))
    .sort()
    .reverse()
  const first = zips[0]
  return first === undefined ? undefined : join(CACHE_DIR, first)
}

/**
 * Extract node.exe from a downloaded zip. Reads the zip, finds the node.exe
 * entry, and writes it to the destination. Uses a simple zip traversal since
 * the Node archive is a flat directory layout.
 * @param zipPath - the downloaded zip file.
 * @param destExe - the destination node.exe path.
 */
async function extractNodeExe(zipPath: string, destExe: string): Promise<void> {
  // Use the system unzip to extract, then copy node.exe. unzip is available on
  // all target platforms (Windows via Git Bash / 7-Zip, macOS, Linux).
  const scratchDir = join(CACHE_DIR, '.extract')
  await rm(scratchDir, { recursive: true, force: true })
  await mkdir(scratchDir, { recursive: true })
  await new Promise<void>((resolvePromise, reject) => {
    const child: ChildProcess = spawn('unzip', ['-q', '-o', zipPath, '-d', scratchDir], { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`fetch-node-for-desktop: unzip extract failed (exit ${code}).`))
    })
  })
  // The zip contains node-<version>-win-x64/node.exe.
  const entries = await readdir(scratchDir)
  const versionDir = entries.find(name => name.startsWith('node-v'))
  if (versionDir === undefined) {
    throw new Error(`fetch-node-for-desktop: extracted zip has no node-v* directory in ${scratchDir}.`)
  }
  const nodeExePath = join(scratchDir, versionDir, 'node.exe')
  if (!existsSync(nodeExePath)) {
    throw new Error(`fetch-node-for-desktop: ${nodeExePath} missing after extract.`)
  }
  await mkdir(dirname(destExe), { recursive: true })
  await copyFile(nodeExePath, destExe)
  await rm(scratchDir, { recursive: true, force: true })
}

async function main(): Promise<void> {
  const cli = Cli.parse(process.argv.slice(2))

  if (cli.dryRun) {
    console.log(`fetch-node-for-desktop: [dry-run] would stage ${join(BINARIES_DIR, NODE_EXE_NAME)}`)
    return
  }

  await mkdir(CACHE_DIR, { recursive: true })
  await mkdir(BINARIES_DIR, { recursive: true })

  const version = await resolveLatestVersion(cli.nodeMajor)
  let zipPath: string | undefined
  if (version !== undefined) {
    zipPath = join(CACHE_DIR, `node-${version}-win-x64.zip`)
    if (!existsSync(zipPath)) {
      const archive = `node-${version}-win-x64.zip`
      const primaryUrl = `https://nodejs.org/dist/${version}/${archive}`
      console.log(`fetch-node-for-desktop: downloading ${primaryUrl}`)
      const tmpZip = `${zipPath}.tmp`
      await downloadFile(primaryUrl, tmpZip)

      const shasums = await fetchText(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)
      const line = shasums.split('\n').find(row => row.endsWith(archive))
      if (line === undefined) {
        throw new Error(`fetch-node-for-desktop: no SHASUMS256 entry for ${archive}.`)
      }
      const expected = line.split(/\s+/)[0]
      if (expected === undefined) {
        throw new Error(`fetch-node-for-desktop: malformed SHASUMS256 line: ${line}`)
      }
      await verifySha256(expected, tmpZip)
      await rename(tmpZip, zipPath)
      console.log(`fetch-node-for-desktop: verified and cached ${archive}`)
    } else {
      console.log(`fetch-node-for-desktop: using cached ${version}`)
    }
  } else {
    zipPath = await newestCachedZip(cli.nodeMajor)
    if (zipPath === undefined) {
      throw new Error(`fetch-node-for-desktop: nodejs.org unreachable and no cached Node v${cli.nodeMajor} zip in ${CACHE_DIR}.`)
    }
    console.log(`fetch-node-for-desktop: nodejs.org unreachable; using cached ${zipPath}`)
  }

  const destExe = join(BINARIES_DIR, NODE_EXE_NAME)
  await extractNodeExe(zipPath, destExe)
  const sizeMb = statSync(destExe).size / (1024 * 1024)
  console.log(`fetch-node-for-desktop: staged ${destExe} (${sizeMb.toFixed(1)} MB)`)
}

void main()
