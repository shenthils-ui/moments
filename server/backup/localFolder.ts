import fs from 'node:fs';
import path from 'node:path';
import { sha256File } from '../files.js';
import { NotConnectedError, type BackupTarget, type PutResult } from './types.js';

/**
 * Mirrors the library into any writable folder: an external USB disk, a
 * mounted NAS share, a second internal drive. The mirror is the same plain
 * tree as PHOTOS_ROOT — usable without this app.
 */
export class LocalFolderTarget implements BackupTarget {
  readonly kind = 'local';

  constructor(
    readonly id: string,
    readonly displayName: string,
    private rootPath: string,
  ) {}

  async connect(): Promise<void> {
    fs.mkdirSync(this.rootPath, { recursive: true });
    // prove writability up front so a run fails fast with a clear reason
    const probe = path.join(this.rootPath, `.moments-write-test-${process.pid}`);
    try {
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe);
    } catch (err) {
      throw new NotConnectedError(`folder is not writable: ${this.rootPath} (${(err as Error).message})`);
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

  private walk(dir: string, out: string[] = []): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) this.walk(full, out);
      else if (entry.isFile()) out.push(full);
    }
    return out;
  }

  /**
   * Hashes are computed from the actual remote bytes, so this also catches
   * silent corruption on the mirror — a changed file simply looks "missing"
   * and gets re-uploaded on the next run.
   */
  async listRemoteHashes(prefix?: string): Promise<Set<string>> {
    const base = prefix ? path.join(this.rootPath, prefix) : this.rootPath;
    const hashes = new Set<string>();
    for (const file of this.walk(base)) {
      try {
        hashes.add(await sha256File(file));
      } catch {
        // unreadable remote file counts as absent
      }
    }
    return hashes;
  }

  async putFile(relPath: string, localPath: string, contentHash: string): Promise<PutResult> {
    const target = path.join(this.rootPath, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + `.uploading-${process.pid}`;
    try {
      fs.copyFileSync(localPath, tmp);
      const localSize = fs.statSync(localPath).size;
      const remoteSize = fs.statSync(tmp).size;
      if (remoteSize !== localSize) throw new Error(`size mismatch: wrote ${remoteSize}, expected ${localSize}`);
      const remoteHash = await sha256File(tmp);
      if (remoteHash !== contentHash) throw new Error('checksum mismatch after copy');
      fs.renameSync(tmp, target);
      return { sizeBytes: remoteSize, checksumVerified: true };
    } catch (err) {
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }

  async deleteFile(relPath: string): Promise<void> {
    fs.rmSync(path.join(this.rootPath, relPath), { force: true });
  }

  async stat(): Promise<{ fileCount: number; bytes: number }> {
    const files = this.walk(this.rootPath);
    let bytes = 0;
    for (const file of files) {
      try {
        bytes += fs.statSync(file).size;
      } catch {
        /* raced deletion */
      }
    }
    return { fileCount: files.length, bytes };
  }
}
