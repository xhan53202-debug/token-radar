import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseSnapshot,
  buildRadar,
  boardIssue,
  dataScript,
} from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

interface Options {
  inputFile: string;
  outputDirectory: string;
}

class EntrypointError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = 'EntrypointError';
    this.exitCode = exitCode;
  }
}

const ROOT = dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function optionsFrom(args: string[]): Options {
  let input = '/input';
  let output = process.env.MAKEFUN_OUTPUT_DIR || '/output';

  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flag !== '--input' && flag !== '--output') {
      throw new EntrypointError(`Unknown argument: ${flag}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.length === 0 || value.startsWith('--')) {
      throw new EntrypointError(`${flag} requires a path.`);
    }
    if (flag === '--input') input = value;
    else output = value;
    index++;
  }

  return {
    inputFile: resolve(
      input.endsWith('.json') ? input : join(input, 'snapshot.json'),
    ),
    outputDirectory: resolve(output),
  };
}

function hasCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}

async function readInput(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT') || hasCode(error, 'ENOTDIR')) {
      throw new EntrypointError(`Input snapshot does not exist: ${path}`, 2);
    }
    throw error;
  }
}

async function regularFiles(directory: string): Promise<string[]> {
  const names = (await readdir(directory))
    .filter((name) => !name.startsWith('.'))
    .sort();

  const files: string[] = [];
  for (const name of names) {
    // lstat deliberately excludes symbolic links and directories.
    if ((await lstat(join(directory, name))).isFile()) files.push(name);
  }
  return files;
}

async function copyFiles(
  source: string,
  destination: string,
  names: string[],
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const name of names) {
    const from = join(source, name);
    const to = join(destination, name);
    if (resolve(from) !== resolve(to)) await copyFile(from, to);
  }
}

// A screenshot's pixel size, read from its own header: PNG takes the IHDR
// chunk, JPEG walks the markers to the first start-of-frame. Returns null
// when the bytes are neither, so the caller can name the file instead of
// guessing at a bad magic.
function screenshotDimensions(
  bytes: Buffer,
): { width: number; height: number } | null {
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (
    bytes.length >= 24 &&
    pngMagic.every((byte, index) => bytes[index] === byte)
  ) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1]!;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2 || offset + 2 + length > bytes.length) return null;
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

async function run(): Promise<void> {
  const options = optionsFrom(process.argv.slice(2));
  const snapshot = parseSnapshot(await readInput(options.inputFile));
  const { board, radar } = buildRadar(snapshot);
  const issue = boardIssue(board, snapshot);
  if (issue !== null) throw new EntrypointError(`Board validation failed: ${issue}`);

  const dashboardSource = join(ROOT, 'dashboard');
  const screenshotSource = join(ROOT, 'screenshots');
  const dashboardFiles = await regularFiles(dashboardSource);
  const screenshotFiles = await regularFiles(screenshotSource);

  // The dossier builder only refuses bad dashboard names and sizes; it never
  // asks whether the page itself is complete. Catch a missing entrypoint here,
  // with the missing piece named, instead of shipping a dashboard that cannot
  // open.
  if (!dashboardFiles.includes('index.html')) {
    throw new EntrypointError('Dashboard is missing index.html.');
  }
  if (!dashboardFiles.some((name) => name.endsWith('.css'))) {
    throw new EntrypointError('Dashboard has no .css file.');
  }
  if (!dashboardFiles.some((name) => name.endsWith('.js'))) {
    throw new EntrypointError('Dashboard has no .js file.');
  }

  if (screenshotFiles.length < 3) {
    throw new EntrypointError(
      `At least 3 regular screenshot files are required; found ${screenshotFiles.length}.`,
    );
  }
  for (const name of screenshotFiles) {
    if (!SCREENSHOT_NAME.test(name)) {
      throw new EntrypointError(`Invalid screenshot filename: ${JSON.stringify(name)}`);
    }
  }

  // The dossier builder checks a screenshot is a PNG or JPEG and under its
  // byte cap, but it never measures the picture. The gate refuses a long edge
  // over 1440 or a short edge under 800, so measure here and fail with the
  // file and its size named.
  for (const name of screenshotFiles) {
    const bytes = await readFile(join(screenshotSource, name));
    const size = screenshotDimensions(bytes);
    if (size === null) {
      throw new EntrypointError(`Screenshot is neither a PNG nor a JPEG: ${name}`);
    }
    const longEdge = Math.max(size.width, size.height);
    const shortEdge = Math.min(size.width, size.height);
    if (longEdge > 1440 || shortEdge < 800) {
      throw new EntrypointError(
        `Screenshot ${name} is ${size.width}x${size.height}; long edge must be at most 1440 and short edge at least 800.`,
      );
    }
  }

  const out = options.outputDirectory;
  await mkdir(out, { recursive: true });
  await writeFile(
    join(out, 'board.json'),
    `${JSON.stringify({ rows: board })}\n`,
    'utf8',
  );
  await writeFile(join(out, 'data.js'), dataScript(radar), 'utf8');
  await copyFiles(dashboardSource, join(out, 'dashboard'), dashboardFiles);
  await copyFiles(screenshotSource, join(out, 'screenshots'), screenshotFiles);

  const dossier = buildDossier(out, {
    text_max_bytes: 65536,
    screenshots: { max: 4, max_bytes: 524288 },
    dashboard: { max_files: 400, max_bytes: 4194304 },
  });
  await writeFile(join(out, 'dossier.json'), dossier);

  process.stdout.write(
    `protocols=${snapshot.protocols.length} watchlist=${radar.watchlist_size} rows scored=${radar.board_size} early=${radar.early_size} live=${radar.live_size}\n`,
  );
  process.stdout.write(
    `Files written: board.json, data.js, dashboard/ (${dashboardFiles.length}), screenshots/ (${screenshotFiles.length}), dossier.json\n`,
  );
}

try {
  await run();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`token-radar-01: ${message}\n`);
  process.exitCode = error instanceof EntrypointError ? error.exitCode : 1;
}
