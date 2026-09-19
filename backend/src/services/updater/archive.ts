import fs from 'node:fs';
import path from 'node:path';
import yauzl, { Entry } from 'yauzl';
import * as tar from 'tar';
import { UpdateIntegrityError } from './release-format';

const MAX_ENTRIES = 50_000;
const MAX_EXPANDED_BYTES = 2 * 1024 * 1024 * 1024;
const ALLOWED_TOP_LEVEL = new Set([
  'frontend',
  'package.json',
  'build-info.json',
  'browser-runtime.json',
  'start.bat',
  'start.ps1',
  'start.sh',
  'zviewer-backend.exe',
  'zviewer-cert.exe',
  'zviewer-backend',
  'zviewer-cert',
  'THIRD-PARTY-NOTICES.md',
  'LICENSE',
]);
const FORBIDDEN_SEGMENTS = new Set([
  'config', 'uploads', 'media', 'backups', 'log', 'logs', '.env',
  'dev.sqlite', 'secret-vault.json', 'jwt-secrets.json',
]);
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

interface SafeEntry {
  archivePath: string;
  normalized: string;
  directory: boolean;
  size: number;
}

function assertRegularArchiveType(type: string, name: string): void {
  if (type !== 'File' && type !== 'Directory') {
    throw new UpdateIntegrityError(`archive links and special entries are forbidden: ${name}`);
  }
}

function validateArchivePath(raw: string, directory: boolean): string {
  if (!raw || raw.includes('\0') || raw.includes('\\') || raw.startsWith('/') || raw.startsWith('//') || /^[A-Za-z]:/.test(raw)) {
    throw new UpdateIntegrityError(`unsafe archive entry path: ${JSON.stringify(raw)}`);
  }
  const trimmed = directory ? raw.replace(/\/+$/, '') : raw;
  const segments = trimmed.split('/');
  if (segments.length === 0 || segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new UpdateIntegrityError(`unsafe archive entry path: ${JSON.stringify(raw)}`);
  }
  for (const segment of segments) {
    if (segment.endsWith('.') || segment.endsWith(' ') || segment.includes(':') || WINDOWS_RESERVED.test(segment)) {
      throw new UpdateIntegrityError(`Windows-unsafe archive entry path: ${JSON.stringify(raw)}`);
    }
    if (FORBIDDEN_SEGMENTS.has(segment.toLowerCase())) {
      throw new UpdateIntegrityError(`archive contains forbidden persistent-data path: ${JSON.stringify(raw)}`);
    }
  }
  if (!ALLOWED_TOP_LEVEL.has(segments[0])) {
    throw new UpdateIntegrityError(`archive contains an unexpected top-level path: ${segments[0]}`);
  }
  return segments.join('/');
}

function validateEntrySet(entries: SafeEntry[]): void {
  if (entries.length === 0 || entries.length > MAX_ENTRIES) throw new UpdateIntegrityError('archive entry count is invalid');
  let expanded = 0;
  const names = new Set<string>();
  for (const entry of entries) {
    expanded += entry.size;
    if (expanded > MAX_EXPANDED_BYTES) throw new UpdateIntegrityError('archive expanded size exceeds the limit');
    const collisionKey = entry.normalized.toLowerCase();
    if (names.has(collisionKey)) throw new UpdateIntegrityError(`archive contains a duplicate or case-colliding path: ${entry.archivePath}`);
    names.add(collisionKey);
  }
}

function zipEntries(file: string): Promise<SafeEntry[]> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error || new UpdateIntegrityError('cannot open zip archive'));
      const entries: SafeEntry[] = [];
      zip.on('error', reject);
      zip.on('entry', (entry: Entry) => {
        try {
          const directory = /\/$/.test(entry.fileName);
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const kind = mode & 0o170000;
          if (kind === 0o120000) throw new UpdateIntegrityError(`zip symlink entries are forbidden: ${entry.fileName}`);
          if (kind !== 0 && kind !== 0o100000 && kind !== 0o040000) {
            throw new UpdateIntegrityError(`unsupported zip entry type: ${entry.fileName}`);
          }
          entries.push({
            archivePath: entry.fileName,
            normalized: validateArchivePath(entry.fileName, directory),
            directory,
            size: directory ? 0 : entry.uncompressedSize,
          });
          zip.readEntry();
        } catch (caught) {
          zip.close();
          reject(caught);
        }
      });
      zip.on('end', () => {
        try { validateEntrySet(entries); resolve(entries); } catch (caught) { reject(caught); }
      });
      zip.readEntry();
    });
  });
}

function extractZip(file: string, destination: string, approved: Map<string, SafeEntry>): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(error || new UpdateIntegrityError('cannot open zip archive'));
      let settled = false;
      const fail = (caught: unknown) => {
        if (settled) return;
        settled = true;
        try { zip.close(); } catch { /* ignore */ }
        reject(caught);
      };
      zip.on('error', fail);
      zip.on('entry', (entry: Entry) => {
        const approvedEntry = approved.get(entry.fileName);
        if (!approvedEntry) return fail(new UpdateIntegrityError('zip archive changed after validation'));
        const output = path.join(destination, ...approvedEntry.normalized.split('/'));
        if (approvedEntry.directory) {
          fs.mkdirSync(output, { recursive: true });
          zip.readEntry();
          return;
        }
        fs.mkdirSync(path.dirname(output), { recursive: true });
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail(streamError || new UpdateIntegrityError('cannot read zip entry'));
          const writer = fs.createWriteStream(output, { flags: 'wx', mode: 0o600 });
          stream.on('error', fail);
          writer.on('error', fail);
          writer.on('finish', () => zip.readEntry());
          stream.pipe(writer);
        });
      });
      zip.on('end', () => {
        if (!settled) { settled = true; resolve(); }
      });
      zip.readEntry();
    });
  });
}

async function tarEntries(file: string): Promise<SafeEntry[]> {
  const entries: SafeEntry[] = [];
  await tar.t({
    file,
    strict: true,
    onentry(entry) {
      assertRegularArchiveType(entry.type, entry.path);
      const directory = entry.type === 'Directory';
      entries.push({
        archivePath: entry.path,
        normalized: validateArchivePath(entry.path, directory),
        directory,
        size: directory ? 0 : entry.size,
      });
      entry.resume();
    },
  });
  validateEntrySet(entries);
  return entries;
}

function assertNoLinks(root: string): void {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new UpdateIntegrityError(`extracted symlink is forbidden: ${entry.name}`);
    if (stat.isDirectory()) assertNoLinks(absolute);
    else if (!stat.isFile()) throw new UpdateIntegrityError(`extracted special file is forbidden: ${entry.name}`);
  }
}

export function verifyExtractedPackage(destination: string, platform: 'windows' | 'linux'): void {
  const required = platform === 'windows'
    ? ['package.json', 'build-info.json', 'browser-runtime.json', 'frontend/dist/index.html', 'frontend/dist/voice-processor.js', 'frontend/dist/icons.svg', 'zviewer-backend.exe', 'start.bat', 'start.ps1']
    : ['package.json', 'build-info.json', 'browser-runtime.json', 'frontend/dist/index.html', 'frontend/dist/voice-processor.js', 'frontend/dist/icons.svg', 'zviewer-backend', 'start.sh'];
  for (const relative of required) {
    const absolute = path.join(destination, ...relative.split('/'));
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      throw new UpdateIntegrityError(`release package is missing required file: ${relative}`);
    }
  }
  const assetNames = fs.readdirSync(path.join(destination, 'frontend', 'dist', 'assets'));
  if (!assetNames.some((name) => name.endsWith('.wasm')) || !assetNames.some((name) => /worker.*\.js$/i.test(name))) {
    throw new UpdateIntegrityError('release package is missing required WASM or Worker runtime assets');
  }
  assertNoLinks(destination);
}

export async function inspectAndExtractArchive(
  archivePath: string,
  destination: string,
  platform: 'windows' | 'linux',
): Promise<void> {
  if (fs.existsSync(destination)) throw new UpdateIntegrityError('extraction destination must not already exist');
  fs.mkdirSync(destination, { recursive: false, mode: 0o700 });
  try {
    if (archivePath.toLowerCase().endsWith('.zip')) {
      const entries = await zipEntries(archivePath);
      await extractZip(archivePath, destination, new Map(entries.map((entry) => [entry.archivePath, entry])));
    } else if (archivePath.toLowerCase().endsWith('.tar.gz')) {
      const entries = await tarEntries(archivePath);
      const approved = new Set(entries.map((entry) => entry.archivePath));
      await tar.x({
        file: archivePath,
        cwd: destination,
        strict: true,
        preservePaths: false,
        unlink: false,
        noChmod: true,
        filter: (entryPath) => approved.has(entryPath),
      });
    } else {
      throw new UpdateIntegrityError('unsupported release archive format');
    }
    verifyExtractedPackage(destination, platform);
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

export const archivePolicyForTests = {
  validateArchivePath,
  validateEntrySet,
  assertRegularArchiveType,
  allowedTopLevel: [...ALLOWED_TOP_LEVEL],
};
