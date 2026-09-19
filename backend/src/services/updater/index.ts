import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import semver from 'semver';
import { CONFIG_DIR, PROJECT_ROOT } from '../paths';
import { inspectAndExtractArchive } from './archive';
import {
  UpdateIntegrityError,
  canonicalJson,
  loadTrustedUpdateKeys,
  parseReleaseManifest,
  parseReleaseSignature,
  releaseTarget,
  sha256File,
  verifyReleaseSignature,
  type ReleaseManifest,
} from './release-format';
import {
  acquireProgramUpdateLock,
  applyPendingUpdate,
  createUpdateMarker,
  finalizeHealthyUpdate,
  readUpdateMarker,
  recoverInterruptedUpdate,
  rollbackPendingUpdate,
  setUpdateStage,
  type UpdateTransactionMarker,
} from './transaction';

const UPDATE_REPOSITORY_ENV = 'TONGMU_UPDATE_REPOSITORY';
const MAX_RELEASE_LIST_BYTES = 2 * 1024 * 1024;
const MAX_SIDECAR_BYTES = 1024 * 1024;
const METADATA_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const MAX_REDIRECTS = 5;
const UPDATER_COMPATIBILITY_VERSION = '1.0.0';

export class UpdateNotConfiguredError extends Error {
  constructor(message = 'TongMu updater is disabled: no trusted update repository is configured') {
    super(message);
    this.name = 'UpdateNotConfiguredError';
  }
}

interface UpdateRepository { owner: string; name: string }

interface GithubAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

interface GithubRelease {
  tag_name: string;
  body: string | null;
  html_url: string;
  published_at: string;
  prerelease: boolean;
  draft?: boolean;
  assets: GithubAsset[];
}

interface ValidatedRemoteRelease {
  release: GithubRelease;
  manifest: ReleaseManifest;
  manifestBytes: Buffer;
  artifactAsset: GithubAsset;
  signatureAsset: GithubAsset;
}

export interface UpdateInfo {
  currentVersion: string;
  currentCommitSha: string;
  remoteVersion: string;
  remoteCommitSha: string;
  hasUpdate: boolean;
  releaseNotes: string;
  releaseUrl: string;
  publishedAt: string;
  downloadUrl: string;
  isPrerelease: boolean;
  assetName: string;
  assetSize: number;
  sha256: string;
  signatureKeyId: string;
}

export type UpdateStageEvent =
  | { stage: 'downloading'; received: number; total: number }
  | { stage: 'verifying' }
  | { stage: 'extracting' }
  | { stage: 'staged' }
  | { stage: 'done'; message: string }
  | { stage: 'error'; message: string };

function configuredRepository(): UpdateRepository {
  const raw = process.env[UPDATE_REPOSITORY_ENV]?.trim();
  if (!raw) throw new UpdateNotConfiguredError();
  const match = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(raw);
  if (!match) throw new UpdateNotConfiguredError(`${UPDATE_REPOSITORY_ENV} must be owner/repository`);
  const owner = match[1];
  const name = match[2];
  if (owner.toLowerCase() === 'zero-wyc' && name.toLowerCase() === 'zviewer') {
    throw new UpdateNotConfiguredError('TongMu updater refuses the historical ZViewer repository');
  }
  return { owner, name };
}

function isLocalTestHost(hostname: string): boolean {
  return (
    (process.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'development') &&
    process.env.TONGMU_UPDATE_ALLOW_LOCALHOST === 'true' &&
    ['localhost', '127.0.0.1', '::1'].includes(hostname.toLowerCase())
  );
}

function allowedDownloadHosts(): Set<string> {
  const hosts = new Set([
    'api.github.com',
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
  ]);
  for (const item of (process.env.TONGMU_UPDATE_ALLOWED_DOWNLOAD_HOSTS || '').split(',')) {
    const host = item.trim().toLowerCase();
    if (host) hosts.add(host);
  }
  return hosts;
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === '::1' || normalized === '::') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || /^fe[89ab]/.test(normalized)) return true;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized);
  const ipv4 = mapped?.[1] || (net.isIPv4(address) ? address : '');
  if (!ipv4) return false;
  const parts = ipv4.split('.').map(Number);
  return (
    parts[0] === 0 || parts[0] === 10 || parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) ||
    parts[0] >= 224
  );
}

interface ResolvedNetworkTarget {
  url: URL;
  address: string;
  family: number;
}

async function resolveNetworkTarget(raw: string): Promise<ResolvedNetworkTarget> {
  let url: URL;
  try { url = new URL(raw); } catch { throw new UpdateIntegrityError('update URL is invalid'); }
  if (url.username || url.password) throw new UpdateIntegrityError('update URL must not contain credentials');
  if (url.protocol !== 'https:' && !isLocalTestHost(url.hostname)) {
    throw new UpdateIntegrityError('updater only permits HTTPS URLs');
  }
  if (!allowedDownloadHosts().has(url.hostname.toLowerCase()) && !isLocalTestHost(url.hostname)) {
    throw new UpdateIntegrityError(`update URL host is not allowed: ${url.hostname}`);
  }
  const addresses = await dns.lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new UpdateIntegrityError(`update URL did not resolve: ${url.hostname}`);
  }
  if (!isLocalTestHost(url.hostname) && addresses.some((item) => isPrivateAddress(item.address))) {
    throw new UpdateIntegrityError(`update URL resolved to a private or invalid address: ${url.hostname}`);
  }
  return { url, address: addresses[0].address, family: addresses[0].family };
}

async function validateNetworkUrl(raw: string): Promise<URL> {
  return (await resolveNetworkTarget(raw)).url;
}

function networkRequest(
  target: ResolvedNetworkTarget,
  headers: Record<string, string>,
  timeout: number,
  onResponse: (response: http.IncomingMessage) => void,
): http.ClientRequest {
  const { url, address, family } = target;
  const common = {
    protocol: url.protocol,
    hostname: address,
    family,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    headers: { ...headers, Host: url.host },
    timeout,
  };
  if (url.protocol === 'https:') {
    return https.get({ ...common, servername: url.hostname }, onResponse);
  }
  return http.get(common, onResponse);
}

interface FetchOptions {
  maxBytes: number;
  timeoutMs: number;
  expectedJson?: boolean;
  redirects?: number;
}

async function boundedGet(raw: string, options: FetchOptions): Promise<Buffer> {
  const redirects = options.redirects ?? 0;
  if (redirects > MAX_REDIRECTS) throw new UpdateIntegrityError('update request exceeded the redirect limit');
  const target = await resolveNetworkTarget(raw);
  const { url } = target;
  return new Promise((resolve, reject) => {
    const request = networkRequest(
      target,
      {
        'User-Agent': 'TongMu-Updater/1',
        Accept: options.expectedJson ? 'application/json, application/vnd.github+json' : 'application/octet-stream',
      },
      options.timeoutMs,
      (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        boundedGet(new URL(response.headers.location, url).toString(), { ...options, redirects: redirects + 1 }).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`update request failed with HTTP ${status}`));
        return;
      }
      if (options.expectedJson) {
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        if (!contentType.includes('json') && !isLocalTestHost(url.hostname)) {
          response.resume();
          reject(new UpdateIntegrityError('update metadata response is not JSON'));
          return;
        }
      }
      const declared = Number(response.headers['content-length'] || 0);
      if (declared > options.maxBytes) {
        response.resume();
        reject(new UpdateIntegrityError('update response exceeds the size limit'));
        return;
      }
      const chunks: Buffer[] = [];
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > options.maxBytes) request.destroy(new UpdateIntegrityError('update response exceeds the size limit'));
        else chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
      response.on('error', reject);
      },
    );
    request.on('timeout', () => request.destroy(new Error('update request timed out')));
    request.on('error', reject);
  });
}

async function boundedJson<T>(url: string, maxBytes: number): Promise<T> {
  const bytes = await boundedGet(url, { maxBytes, timeoutMs: METADATA_TIMEOUT_MS, expectedJson: true });
  try { return JSON.parse(bytes.toString('utf8')) as T; }
  catch { throw new UpdateIntegrityError('update metadata is not valid JSON'); }
}

export function currentBuildIdentity(root = PROJECT_ROOT): { version: string; commitSha: string } {
  let version = '0.0.0';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string };
    if (typeof pkg.version === 'string' && semver.valid(pkg.version)) version = pkg.version;
  } catch { /* development fallback below */ }
  let commitSha = process.env.TONGMU_BUILD_SHA || 'development';
  try {
    const info = JSON.parse(fs.readFileSync(path.join(root, 'build-info.json'), 'utf8')) as { version?: string; commitSha?: string };
    if (typeof info.version === 'string' && semver.valid(info.version)) version = info.version;
    if (typeof info.commitSha === 'string' && /^[0-9a-f]{40}$/i.test(info.commitSha)) commitSha = info.commitSha.toLowerCase();
  } catch { /* unpackaged development mode */ }
  return { version, commitSha };
}

async function validatedRelease(release: GithubRelease): Promise<ValidatedRemoteRelease> {
  const target = releaseTarget();
  const manifestAssets = release.assets.filter((asset) =>
    asset.name.startsWith('TongMu-') &&
    asset.name.includes(`-${target.platform}-${target.architecture}-`) &&
    asset.name.endsWith(`${target.extension}.manifest.json`),
  );
  if (manifestAssets.length !== 1) throw new UpdateIntegrityError('release must contain exactly one platform manifest');
  const manifestAsset = manifestAssets[0];
  if (manifestAsset.size <= 0 || manifestAsset.size > MAX_SIDECAR_BYTES) throw new UpdateIntegrityError('release manifest asset size is invalid');
  const signatureAsset = release.assets.find((asset) => asset.name === `${manifestAsset.name}.sig`);
  if (!signatureAsset || signatureAsset.size <= 0 || signatureAsset.size > MAX_SIDECAR_BYTES) {
    throw new UpdateIntegrityError('release manifest signature is missing or invalid');
  }
  const [manifestBytes, signatureBytes] = await Promise.all([
    boundedGet(manifestAsset.browser_download_url, { maxBytes: MAX_SIDECAR_BYTES, timeoutMs: METADATA_TIMEOUT_MS, expectedJson: true }),
    boundedGet(signatureAsset.browser_download_url, { maxBytes: MAX_SIDECAR_BYTES, timeoutMs: METADATA_TIMEOUT_MS, expectedJson: true }),
  ]);
  const manifest = parseReleaseManifest(manifestBytes);
  const signature = parseReleaseSignature(signatureBytes);
  verifyReleaseSignature(manifestBytes, manifest, signature, loadTrustedUpdateKeys());
  if (manifest.platform !== target.platform || manifest.architecture !== target.architecture) {
    throw new UpdateIntegrityError('release manifest does not match this platform');
  }
  const tagVersion = release.tag_name.replace(/^v/, '');
  if (!semver.valid(tagVersion) || tagVersion !== manifest.version) {
    throw new UpdateIntegrityError('release tag and manifest version do not match');
  }
  if (semver.gt(manifest.minimumUpdaterCompatibilityVersion, UPDATER_COMPATIBILITY_VERSION)) {
    throw new UpdateIntegrityError('this release requires a newer updater');
  }
  const artifactAsset = release.assets.find((asset) => asset.name === manifest.artifact.filename);
  if (!artifactAsset || artifactAsset.size !== manifest.artifact.size) {
    throw new UpdateIntegrityError('release artifact metadata does not match the signed manifest');
  }
  return { release, manifest, manifestBytes, artifactAsset, signatureAsset };
}

async function selectRemoteRelease(includePrerelease: boolean): Promise<ValidatedRemoteRelease> {
  const repository = configuredRepository();
  const releases = await boundedJson<GithubRelease[]>(
    `https://api.github.com/repos/${repository.owner}/${repository.name}/releases?per_page=20`,
    MAX_RELEASE_LIST_BYTES,
  );
  if (!Array.isArray(releases)) throw new UpdateIntegrityError('GitHub release response is invalid');
  const candidates = releases.filter((release) => !release.draft && (includePrerelease || !release.prerelease));
  if (candidates.length === 0) throw new Error('no eligible TongMu release was found');
  return validatedRelease(candidates[0]);
}

function updateDecision(remote: ValidatedRemoteRelease): { local: ReturnType<typeof currentBuildIdentity>; hasUpdate: boolean } {
  const local = currentBuildIdentity();
  if (!semver.valid(local.version)) throw new UpdateIntegrityError('local version is not valid SemVer');
  const order = semver.compare(remote.manifest.version, local.version);
  if (order < 0) return { local, hasUpdate: false };
  if (order === 0) {
    if (local.commitSha !== remote.manifest.commitSha) throw new UpdateIntegrityError('same-version release has a different commit SHA');
    return { local, hasUpdate: false };
  }
  return { local, hasUpdate: true };
}

function publicInfo(remote: ValidatedRemoteRelease, local: ReturnType<typeof currentBuildIdentity>, hasUpdate: boolean): UpdateInfo {
  return {
    currentVersion: local.version,
    currentCommitSha: local.commitSha,
    remoteVersion: remote.manifest.version,
    remoteCommitSha: remote.manifest.commitSha,
    hasUpdate,
    releaseNotes: remote.release.body || '',
    releaseUrl: remote.release.html_url,
    publishedAt: remote.release.published_at,
    downloadUrl: remote.artifactAsset.browser_download_url,
    isPrerelease: remote.release.prerelease,
    assetName: remote.manifest.artifact.filename,
    assetSize: remote.manifest.artifact.size,
    sha256: remote.manifest.artifact.sha256,
    signatureKeyId: remote.manifest.signature.keyId,
  };
}

export async function getUpdateInfo(includePrerelease = false): Promise<UpdateInfo> {
  const remote = await selectRemoteRelease(includePrerelease);
  const decision = updateDecision(remote);
  return publicInfo(remote, decision.local, decision.hasUpdate);
}

async function downloadArtifact(
  raw: string,
  destination: string,
  expectedSize: number,
  onProgress?: (received: number, total: number) => void,
  redirects = 0,
): Promise<void> {
  if (redirects > MAX_REDIRECTS) throw new UpdateIntegrityError('artifact download exceeded the redirect limit');
  const target = await resolveNetworkTarget(raw);
  const { url } = target;
  await new Promise<void>((resolve, reject) => {
    const request = networkRequest(target, { 'User-Agent': 'TongMu-Updater/1', Accept: 'application/octet-stream' }, DOWNLOAD_TIMEOUT_MS, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        downloadArtifact(new URL(response.headers.location, url).toString(), destination, expectedSize, onProgress, redirects + 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        reject(new Error(`artifact download failed with HTTP ${status}`));
        return;
      }
      const declared = Number(response.headers['content-length'] || 0);
      if (declared && declared !== expectedSize) {
        response.resume();
        reject(new UpdateIntegrityError('artifact Content-Length does not match the manifest'));
        return;
      }
      const writer = fs.createWriteStream(destination, { flags: 'wx', mode: 0o600 });
      let received = 0;
      response.on('data', (chunk: Buffer) => {
        received += chunk.length;
        if (received > expectedSize) request.destroy(new UpdateIntegrityError('artifact exceeds the signed size'));
        else onProgress?.(received, expectedSize);
      });
      response.on('error', reject);
      writer.on('error', reject);
      writer.on('finish', () => {
        if (received !== expectedSize) reject(new UpdateIntegrityError('artifact size does not match the signed manifest'));
        else resolve();
      });
      response.pipe(writer);
    });
    request.on('timeout', () => request.destroy(new Error('artifact download timed out')));
    request.on('error', reject);
  });
}

export async function applyUpdate(
  includePrerelease = false,
  onStage?: (event: UpdateStageEvent) => void,
): Promise<{ success: boolean; message: string; transaction: UpdateTransactionMarker }> {
  const lock = acquireProgramUpdateLock(CONFIG_DIR);
  let marker: UpdateTransactionMarker | null = null;
  try {
    const remote = await selectRemoteRelease(includePrerelease);
    const decision = updateDecision(remote);
    if (!decision.hasUpdate) throw new UpdateIntegrityError('release is not newer than the installed version');
    marker = createUpdateMarker(CONFIG_DIR, remote.manifest, decision.local);
    const transactionRoot = path.dirname(marker.packageDirectory);
    const downloadDirectory = path.join(transactionRoot, 'download');
    fs.mkdirSync(downloadDirectory, { recursive: true, mode: 0o700 });
    const archivePath = path.join(downloadDirectory, remote.manifest.artifact.filename);
    onStage?.({ stage: 'downloading', received: 0, total: remote.manifest.artifact.size });
    await downloadArtifact(remote.artifactAsset.browser_download_url, archivePath, remote.manifest.artifact.size,
      (received, total) => onStage?.({ stage: 'downloading', received, total }));
    setUpdateStage(CONFIG_DIR, marker, 'downloaded');
    onStage?.({ stage: 'verifying' });
    if (sha256File(archivePath) !== remote.manifest.artifact.sha256) {
      throw new UpdateIntegrityError('artifact SHA-256 does not match the signed manifest');
    }
    verifyReleaseSignature(
      remote.manifestBytes,
      remote.manifest,
      parseReleaseSignature(await boundedGet(remote.signatureAsset.browser_download_url, {
        maxBytes: MAX_SIDECAR_BYTES,
        timeoutMs: METADATA_TIMEOUT_MS,
        expectedJson: true,
      })),
      loadTrustedUpdateKeys(),
    );
    setUpdateStage(CONFIG_DIR, marker, 'verified');
    onStage?.({ stage: 'extracting' });
    setUpdateStage(CONFIG_DIR, marker, 'extracting');
    await inspectAndExtractArchive(archivePath, marker.packageDirectory, remote.manifest.platform);
    setUpdateStage(CONFIG_DIR, marker, 'ready-to-apply');
    onStage?.({ stage: 'staged' });
    const message = '更新包已完成签名、大小、SHA-256 与归档安全验证；请通过启动脚本重启以执行安全切换。';
    onStage?.({ stage: 'done', message });
    return { success: true, message, transaction: marker };
  } catch (error) {
    if (marker) {
      fs.rmSync(path.dirname(marker.packageDirectory), { recursive: true, force: true });
      setUpdateStage(CONFIG_DIR, marker, 'failed', error instanceof Error ? error.message : String(error));
    }
    const message = error instanceof Error ? error.message : 'update failed';
    onStage?.({ stage: 'error', message });
    throw error;
  } finally {
    lock.release();
  }
}

export async function applyUpdateFromFile(
  _fileData: Buffer,
  _filename: string,
  onStage?: (event: UpdateStageEvent) => void,
): Promise<{ success: boolean; message: string }> {
  const message = 'Unsigned archive upload is disabled. Publish the archive with its signed TongMu manifest and use the trusted release source.';
  onStage?.({ stage: 'error', message });
  throw new UpdateIntegrityError(message);
}

export function applyPendingUpdateFromCli(): UpdateTransactionMarker {
  return applyPendingUpdate(CONFIG_DIR, PROJECT_ROOT);
}

export function rollbackPendingUpdateFromCli(reason: string): UpdateTransactionMarker {
  return rollbackPendingUpdate(CONFIG_DIR, PROJECT_ROOT, reason);
}

export function finalizePendingUpdateFromCli(version: string, commitSha: string): UpdateTransactionMarker {
  return finalizeHealthyUpdate(CONFIG_DIR, version, commitSha);
}

export function recoverUpdateState(): UpdateTransactionMarker | null {
  return recoverInterruptedUpdate(CONFIG_DIR, PROJECT_ROOT);
}

export function pendingUpdateState(): UpdateTransactionMarker | null {
  return readUpdateMarker(CONFIG_DIR);
}

export const updaterInternalsForTests = {
  configuredRepository,
  validateNetworkUrl,
  boundedGet,
  updateDecision,
  canonicalJson,
  isPrivateAddress,
};
