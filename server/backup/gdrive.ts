import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_NAME } from '../../shared/appName.js';
import { NotConnectedError, type BackupTarget, type PutResult } from './types.js';

/**
 * Google Drive mirror via the Drive REST v3 API with the drive.file scope
 * ONLY — the app can see and touch nothing in the user's Drive except files
 * it created itself.
 *
 * The OAuth consent happens in the browser; the refresh token is stored
 * server-side in DATA_DIR/backup/ with 0600 permissions and is never sent
 * to any client again. Client id/secret come from GOOGLE_CLIENT_ID /
 * GOOGLE_CLIENT_SECRET env vars — never from the repo.
 *
 * Endpoints are env-overridable so the automated tests can run against a
 * local mock server (GDRIVE_API_BASE / GDRIVE_UPLOAD_BASE / GDRIVE_TOKEN_URL).
 */

const RESUMABLE_THRESHOLD = 5 * 1024 * 1024;
const CHUNK_SIZE = 8 * 1024 * 1024; // must be a multiple of 256 KiB per Drive docs

const apiBase = () => process.env.GDRIVE_API_BASE ?? 'https://www.googleapis.com/drive/v3';
const uploadBase = () => process.env.GDRIVE_UPLOAD_BASE ?? 'https://www.googleapis.com/upload/drive/v3';
const tokenUrl = () => process.env.GDRIVE_TOKEN_URL ?? 'https://oauth2.googleapis.com/token';
const authBase = () => process.env.GDRIVE_AUTH_BASE ?? 'https://accounts.google.com/o/oauth2/v2/auth';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const APP_PROPERTY = { key: 'momentsApp', value: APP_NAME.toLowerCase() };

interface DriveState {
  refreshToken?: string;
  rootFolderId?: string;
  folderIds: Record<string, string>; // relDir -> folder id
  fileIds: Record<string, string>; // relPath -> file id
}

function md5File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

// ---- OAuth helpers (used by the /api/backup/gdrive routes) ------------------

export function buildAuthUrl(clientId: string, redirectUri: string, state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${authBase()}?${params}`;
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string | undefined,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ refreshToken: string }> {
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  if (clientSecret) body.set('client_secret', clientSecret);
  const res = await fetch(tokenUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    throw new Error(`token exchange failed: ${data.error_description ?? data.error ?? res.status}`);
  }
  return { refreshToken: data.refresh_token };
}

// -----------------------------------------------------------------------------

export class GoogleDriveTarget implements BackupTarget {
  readonly kind = 'gdrive';
  private state: DriveState;
  private accessToken: { token: string; expiresAt: number } | null = null;

  constructor(
    readonly id: string,
    readonly displayName: string,
    private dataDir: string,
    private config: Record<string, any> = {},
  ) {
    this.state = this.loadState();
  }

  private statePath(): string {
    return path.join(this.dataDir, 'backup', `gdrive-${this.id}.json`);
  }

  private loadState(): DriveState {
    try {
      return { folderIds: {}, fileIds: {}, ...JSON.parse(fs.readFileSync(this.statePath(), 'utf8')) };
    } catch {
      return { folderIds: {}, fileIds: {} };
    }
  }

  private saveState(): void {
    const file = this.statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(this.state), { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* chmod is a no-op on some filesystems (e.g. Windows) */
    }
  }

  /** Called by the OAuth callback route after a successful consent. */
  setRefreshToken(refreshToken: string): void {
    this.state.refreshToken = refreshToken;
    this.accessToken = null;
    this.saveState();
  }

  disconnect(): void {
    this.state = { folderIds: {}, fileIds: {} };
    this.accessToken = null;
    fs.rmSync(this.statePath(), { force: true });
  }

  hasCredentials(): boolean {
    return Boolean(this.state.refreshToken);
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt - 30_000) return this.accessToken.token;
    if (!this.state.refreshToken) {
      throw new NotConnectedError('Google Drive is not connected — open the Backup screen to connect.');
    }
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) throw new NotConnectedError('GOOGLE_CLIENT_ID is not set on the server.');
    const body = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: this.state.refreshToken,
    });
    if (process.env.GOOGLE_CLIENT_SECRET) body.set('client_secret', process.env.GOOGLE_CLIENT_SECRET);
    const res = await fetch(tokenUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      if (data.error === 'invalid_grant') {
        // token revoked or expired for good: clear it so the UI offers reconnect
        this.state.refreshToken = undefined;
        this.saveState();
        throw new NotConnectedError('Google Drive access was revoked — reconnect from the Backup screen.');
      }
      throw new Error(`Google token refresh failed: ${data.error ?? res.status}`);
    }
    this.accessToken = { token: data.access_token, expiresAt: Date.now() + Number(data.expires_in ?? 3600) * 1000 };
    return this.accessToken.token;
  }

  private async api(pathname: string, init: RequestInit = {}, base = apiBase()): Promise<Response> {
    const token = await this.getAccessToken();
    const res = await fetch(`${base}${pathname}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    if (res.status === 401) {
      this.accessToken = null; // expired mid-flight: refresh once and retry
      const retryToken = await this.getAccessToken();
      return fetch(`${base}${pathname}`, {
        ...init,
        headers: { Authorization: `Bearer ${retryToken}`, ...(init.headers ?? {}) },
      });
    }
    return res;
  }

  private async apiJson<T = any>(pathname: string, init: RequestInit = {}, base = apiBase()): Promise<T> {
    const res = await this.api(pathname, init, base);
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Drive API ${init.method ?? 'GET'} ${pathname.split('?')[0]}: ${data.error?.message ?? res.status}`);
    return data as T;
  }

  async connect(): Promise<void> {
    await this.getAccessToken();
    if (!this.state.rootFolderId) {
      const name = String(this.config.rootFolderName ?? `${APP_NAME} Backup`);
      // With drive.file scope we only see files we created, so a name search
      // finds our own root folder from a previous session, nothing else.
      const q = encodeURIComponent(`name = '${name}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`);
      const found = await this.apiJson(`/files?q=${q}&fields=files(id)`);
      if (found.files?.[0]?.id) {
        this.state.rootFolderId = found.files[0].id;
      } else {
        const created = await this.apiJson('/files?fields=id', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
        });
        this.state.rootFolderId = created.id;
      }
      this.saveState();
    }
  }

  async isConnected(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  private async ensureFolder(relDir: string): Promise<string> {
    if (relDir === '' || relDir === '.') return this.state.rootFolderId!;
    if (this.state.folderIds[relDir]) return this.state.folderIds[relDir];
    const parent = await this.ensureFolder(path.posix.dirname(relDir) === '.' ? '' : path.posix.dirname(relDir));
    const created = await this.apiJson('/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: path.posix.basename(relDir),
        mimeType: 'application/vnd.google-apps.folder',
        parents: [parent],
      }),
    });
    this.state.folderIds[relDir] = created.id;
    this.saveState();
    return created.id;
  }

  async putFile(relPath: string, localPath: string, contentHash: string): Promise<PutResult> {
    const sizeBytes = fs.statSync(localPath).size;
    const localMd5 = await md5File(localPath);
    const existingId = this.state.fileIds[relPath];
    const parentId = await this.ensureFolder(path.posix.dirname(relPath) === '.' ? '' : path.posix.dirname(relPath));

    const metadata: Record<string, unknown> = {
      name: path.posix.basename(relPath),
      appProperties: { [APP_PROPERTY.key]: APP_PROPERTY.value, momentsHash: contentHash },
    };
    if (!existingId) metadata.parents = [parentId];

    const file =
      sizeBytes > RESUMABLE_THRESHOLD
        ? await this.resumableUpload(existingId, metadata, localPath, sizeBytes)
        : await this.multipartUpload(existingId, metadata, localPath);

    const reportedSize = Number(file.size ?? -1);
    if (reportedSize !== sizeBytes) {
      throw new Error(`Drive reported size ${reportedSize}, expected ${sizeBytes} for ${relPath}`);
    }
    const checksumVerified = typeof file.md5Checksum === 'string' ? file.md5Checksum === localMd5 : false;
    if (typeof file.md5Checksum === 'string' && !checksumVerified) {
      throw new Error(`Drive md5 mismatch for ${relPath}`);
    }
    this.state.fileIds[relPath] = file.id;
    this.saveState();
    return { sizeBytes: reportedSize, checksumVerified };
  }

  private async multipartUpload(existingId: string | undefined, metadata: unknown, localPath: string): Promise<any> {
    const boundary = `moments-${crypto.randomBytes(8).toString('hex')}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
          `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      fs.readFileSync(localPath),
      Buffer.from(`\r\n--${boundary}--`),
    ]);
    const pathname = existingId
      ? `/files/${existingId}?uploadType=multipart&fields=id,size,md5Checksum`
      : `/files?uploadType=multipart&fields=id,size,md5Checksum`;
    return this.apiJson(
      pathname,
      {
        method: existingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
        body,
      },
      uploadBase(),
    );
  }

  /** Resumable upload for files above 5 MB, sent in 8 MiB chunks. */
  private async resumableUpload(
    existingId: string | undefined,
    metadata: unknown,
    localPath: string,
    sizeBytes: number,
  ): Promise<any> {
    const pathname = existingId
      ? `/files/${existingId}?uploadType=resumable&fields=id,size,md5Checksum`
      : `/files?uploadType=resumable&fields=id,size,md5Checksum`;
    const init = await this.api(
      pathname,
      {
        method: existingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Length': String(sizeBytes) },
        body: JSON.stringify(metadata),
      },
      uploadBase(),
    );
    if (!init.ok) throw new Error(`resumable session start failed: ${init.status}`);
    const sessionUrl = init.headers.get('location');
    if (!sessionUrl) throw new Error('resumable session start returned no location');

    const fd = fs.openSync(localPath, 'r');
    try {
      let offset = 0;
      for (;;) {
        const chunk = Buffer.alloc(Math.min(CHUNK_SIZE, sizeBytes - offset));
        fs.readSync(fd, chunk, 0, chunk.length, offset);
        const end = offset + chunk.length;
        const res = await fetch(sessionUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(chunk.length),
            'Content-Range': `bytes ${offset}-${end - 1}/${sizeBytes}`,
          },
          body: chunk,
        });
        if (res.status === 308) {
          // Drive tells us how much it actually has; resume from there.
          const range = res.headers.get('range');
          offset = range ? Number(range.split('-')[1]) + 1 : end;
          continue;
        }
        if (!res.ok) throw new Error(`chunk upload failed: ${res.status}`);
        return await res.json();
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  async listRemoteHashes(_prefix?: string): Promise<Set<string>> {
    const hashes = new Set<string>();
    const q = encodeURIComponent(
      `appProperties has { key = '${APP_PROPERTY.key}' and value = '${APP_PROPERTY.value}' } and trashed = false`,
    );
    let pageToken = '';
    do {
      const page = await this.apiJson(
        `/files?q=${q}&fields=nextPageToken,files(appProperties)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`,
      );
      for (const file of page.files ?? []) {
        const hash = file.appProperties?.momentsHash;
        if (hash) hashes.add(hash);
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    return hashes;
  }

  async deleteFile(relPath: string): Promise<void> {
    const fileId = this.state.fileIds[relPath];
    if (!fileId) return;
    const res = await this.api(`/files/${fileId}`, { method: 'DELETE' });
    if (!res.ok && res.status !== 404) throw new Error(`Drive delete failed: ${res.status}`);
    delete this.state.fileIds[relPath];
    this.saveState();
  }

  async stat(): Promise<{ fileCount: number; bytes: number }> {
    const q = encodeURIComponent(
      `appProperties has { key = '${APP_PROPERTY.key}' and value = '${APP_PROPERTY.value}' } and trashed = false`,
    );
    let fileCount = 0;
    let bytes = 0;
    let pageToken = '';
    do {
      const page = await this.apiJson(
        `/files?q=${q}&fields=nextPageToken,files(size)&pageSize=1000${pageToken ? `&pageToken=${pageToken}` : ''}`,
      );
      for (const file of page.files ?? []) {
        fileCount++;
        bytes += Number(file.size ?? 0);
      }
      pageToken = page.nextPageToken ?? '';
    } while (pageToken);
    return { fileCount, bytes };
  }
}
