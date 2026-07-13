import fs from 'node:fs';
import path from 'node:path';

export interface AppConfig {
  photosRoot: string;
  dataDir: string;
  port: number;
}

/**
 * Resolution order: environment variables, then config.json in the working
 * directory, then defaults (./data/photos and ./data).
 */
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  let fileConfig: Partial<Record<'photosRoot' | 'dataDir' | 'port', string | number>> = {};
  const configPath = path.resolve(process.cwd(), 'config.json');
  if (fs.existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch {
      console.warn(`[config] Could not parse ${configPath}; ignoring it.`);
    }
  }

  const photosRoot = path.resolve(
    overrides.photosRoot ?? process.env.PHOTOS_ROOT ?? String(fileConfig.photosRoot ?? './data/photos'),
  );
  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.DATA_DIR ?? String(fileConfig.dataDir ?? './data'),
  );
  const port = overrides.port ?? Number(process.env.PORT ?? fileConfig.port ?? 3000);

  return { photosRoot, dataDir, port };
}

export function ensureDirs(config: AppConfig): void {
  fs.mkdirSync(config.photosRoot, { recursive: true });
  fs.mkdirSync(path.join(config.photosRoot, '_meta'), { recursive: true });
  fs.mkdirSync(path.join(config.photosRoot, '_trash'), { recursive: true });
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'cache', 'thumbs'), { recursive: true });
  fs.mkdirSync(path.join(config.dataDir, 'tmp'), { recursive: true });
}
