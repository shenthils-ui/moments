import crypto from 'node:crypto';
import type { Server } from 'node:http';
import express from 'express';

/**
 * A minimal in-memory mock of the Google Drive REST v3 surface that
 * GoogleDriveTarget actually uses:
 *   POST /token                              (refresh_token + authorization_code)
 *   GET  /drive/files?q=...                  (list: name search, appProperties filter, pagination)
 *   POST /drive/files                        (folder / metadata create)
 *   DELETE /drive/files/:id
 *   POST/PATCH /upload/files[...]?uploadType=multipart|resumable
 *   PUT  /upload/session/:id                 (resumable chunks, 308 + Range handling)
 *
 * Point the target at it with GDRIVE_API_BASE / GDRIVE_UPLOAD_BASE /
 * GDRIVE_TOKEN_URL.
 */

export interface MockFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties?: Record<string, string>;
  content: Buffer | null;
}

export class DriveMock {
  files = new Map<string, MockFile>();
  validAccessTokens = new Set<string>();
  validRefreshTokens = new Set<string>(['rt-valid']);
  /** When true the next /token call answers invalid_grant (revocation). */
  revokeNextRefresh = false;
  /** When true every issued access token dies after its first authorized use. */
  expireTokensAfterFirstUse = false;
  pageSize = 2; // tiny page size so pagination is actually exercised
  tokenRequests = 0;
  resumableSessions = new Map<string, { fileId?: string; metadata: any; chunks: Buffer[]; received: number; total: number }>();

  private server: Server | null = null;
  baseUrl = '';

  async start(): Promise<void> {
    const app = express();

    app.post('/token', express.urlencoded({ extended: false }), (req, res) => {
      this.tokenRequests++;
      const { grant_type, refresh_token, code } = req.body;
      if (grant_type === 'authorization_code') {
        if (code !== 'good-code') return res.status(400).json({ error: 'invalid_grant' });
        const rt = `rt-${crypto.randomUUID()}`;
        this.validRefreshTokens.add(rt);
        return res.json({ access_token: this.issueAccess(), refresh_token: rt, expires_in: 3600 });
      }
      if (grant_type === 'refresh_token') {
        if (this.revokeNextRefresh || !this.validRefreshTokens.has(refresh_token)) {
          return res.status(400).json({ error: 'invalid_grant' });
        }
        return res.json({ access_token: this.issueAccess(), expires_in: 3600 });
      }
      res.status(400).json({ error: 'unsupported_grant_type' });
    });

    const auth = (req: express.Request, res: express.Response, next: express.NextFunction) => {
      const token = (req.headers.authorization ?? '').replace('Bearer ', '');
      if (!this.validAccessTokens.has(token)) {
        return res.status(401).json({ error: { message: 'Invalid Credentials' } });
      }
      if (this.expireTokensAfterFirstUse) this.validAccessTokens.delete(token);
      next();
    };

    app.get('/drive/files', auth, (req, res) => {
      const q = String(req.query.q ?? '');
      let list = [...this.files.values()];
      const nameMatch = q.match(/name = '([^']+)'/);
      if (nameMatch) list = list.filter((f) => f.name === nameMatch[1]);
      if (q.includes("mimeType = 'application/vnd.google-apps.folder'")) {
        list = list.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
      }
      const propMatch = q.match(/appProperties has \{ key = '([^']+)' and value = '([^']+)' \}/);
      if (propMatch) list = list.filter((f) => f.appProperties?.[propMatch[1]] === propMatch[2]);

      const start = Number(req.query.pageToken ?? 0);
      const page = list.slice(start, start + this.pageSize);
      res.json({
        files: page.map((f) => this.toJson(f)),
        ...(start + this.pageSize < list.length ? { nextPageToken: String(start + this.pageSize) } : {}),
      });
    });

    app.post('/drive/files', auth, express.json(), (req, res) => {
      const file = this.createFile(req.body, null);
      res.json(this.toJson(file));
    });

    app.delete('/drive/files/:id', auth, (req, res) => {
      if (!this.files.delete(req.params.id)) return res.status(404).json({ error: { message: 'not found' } });
      res.status(204).end();
    });

    const rawBody = express.raw({ type: () => true, limit: '200mb' });

    const handleUpload = (req: express.Request, res: express.Response, existingId?: string) => {
      const uploadType = String(req.query.uploadType);
      if (uploadType === 'multipart') {
        const { metadata, content } = this.parseMultipart(req);
        const file = existingId ? this.updateFile(existingId, metadata, content) : this.createFile(metadata, content);
        if (!file) return res.status(404).json({ error: { message: 'not found' } });
        return res.json(this.toJson(file));
      }
      if (uploadType === 'resumable') {
        const sessionId = crypto.randomUUID();
        this.resumableSessions.set(sessionId, {
          fileId: existingId,
          metadata: JSON.parse(req.body.toString() || '{}'),
          chunks: [],
          received: 0,
          total: Number(req.headers['x-upload-content-length'] ?? 0),
        });
        res.setHeader('Location', `${this.baseUrl}/upload/session/${sessionId}`);
        return res.status(200).end();
      }
      res.status(400).json({ error: { message: `unsupported uploadType ${uploadType}` } });
    };

    app.post('/upload/files', auth, rawBody, (req, res) => handleUpload(req, res));
    app.patch('/upload/files/:id', auth, rawBody, (req, res) => handleUpload(req, res, req.params.id));

    app.put('/upload/session/:id', rawBody, (req, res) => {
      const session = this.resumableSessions.get(req.params.id);
      if (!session) return res.status(404).json({ error: { message: 'no such session' } });
      const range = String(req.headers['content-range'] ?? ''); // bytes a-b/total
      const match = range.match(/bytes (\d+)-(\d+)\/(\d+)/);
      if (!match) return res.status(400).json({ error: { message: 'bad content-range' } });
      session.chunks.push(req.body as Buffer);
      session.received = Number(match[2]) + 1;
      if (session.received < Number(match[3])) {
        res.setHeader('Range', `bytes=0-${session.received - 1}`);
        return res.status(308).end();
      }
      const content = Buffer.concat(session.chunks);
      const file = session.fileId
        ? this.updateFile(session.fileId, session.metadata, content)
        : this.createFile(session.metadata, content);
      this.resumableSessions.delete(req.params.id);
      if (!file) return res.status(404).json({ error: { message: 'not found' } });
      res.json(this.toJson(file));
    });

    await new Promise<void>((resolve) => {
      this.server = app.listen(0, '127.0.0.1', () => {
        const address = this.server!.address() as { port: number };
        this.baseUrl = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    await new Promise((r) => this.server?.close(r));
  }

  env(): Record<string, string> {
    return {
      GDRIVE_API_BASE: `${this.baseUrl}/drive`,
      GDRIVE_UPLOAD_BASE: `${this.baseUrl}/upload`,
      GDRIVE_TOKEN_URL: `${this.baseUrl}/token`,
    };
  }

  private issueAccess(): string {
    const token = `at-${crypto.randomUUID()}`;
    this.validAccessTokens.add(token);
    return token;
  }

  private createFile(metadata: any, content: Buffer | null): MockFile {
    const file: MockFile = {
      id: crypto.randomUUID(),
      name: String(metadata.name ?? 'untitled'),
      mimeType: String(metadata.mimeType ?? 'application/octet-stream'),
      parents: metadata.parents ?? [],
      appProperties: metadata.appProperties,
      content,
    };
    this.files.set(file.id, file);
    return file;
  }

  private updateFile(id: string, metadata: any, content: Buffer | null): MockFile | null {
    const file = this.files.get(id);
    if (!file) return null;
    if (metadata.name) file.name = String(metadata.name);
    if (metadata.appProperties) file.appProperties = metadata.appProperties;
    if (content) file.content = content;
    return file;
  }

  private toJson(file: MockFile) {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      appProperties: file.appProperties,
      size: file.content ? String(file.content.length) : undefined,
      md5Checksum: file.content ? crypto.createHash('md5').update(file.content).digest('hex') : undefined,
    };
  }

  private parseMultipart(req: express.Request): { metadata: any; content: Buffer } {
    const contentType = String(req.headers['content-type'] ?? '');
    const boundary = contentType.match(/boundary=([^;]+)/)?.[1];
    if (!boundary) throw new Error('no boundary');
    const body = req.body as Buffer;
    const marker = Buffer.from(`--${boundary}`);
    const parts: Buffer[] = [];
    let idx = body.indexOf(marker);
    while (idx !== -1) {
      const next = body.indexOf(marker, idx + marker.length);
      if (next === -1) break;
      parts.push(body.subarray(idx + marker.length, next));
      idx = next;
    }
    const split = (part: Buffer) => part.subarray(part.indexOf('\r\n\r\n') + 4, part.length - 2); // strip trailing \r\n
    return { metadata: JSON.parse(split(parts[0]).toString()), content: split(parts[1]) };
  }
}
