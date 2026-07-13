import os from 'node:os';
import qrcode from 'qrcode-terminal';
import { APP_NAME } from '../shared/appName.js';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets ?? []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

try {
  const config = loadConfig();
  const { app, snapshots, close } = createApp(config);

  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`\n${APP_NAME} is running.`);
    console.log(`  Photos root: ${config.photosRoot}`);
    console.log(`  Data dir:    ${config.dataDir}`);
    console.log(`  Local:       http://localhost:${config.port}`);
    const lan = lanAddresses();
    for (const addr of lan) {
      console.log(`  On your Wi-Fi: http://${addr}:${config.port}`);
    }
    if (lan.length > 0 && process.env.NO_QR !== '1') {
      const url = `http://${lan[0]}:${config.port}`;
      console.log(`\nScan with your phone (same Wi-Fi):\n`);
      qrcode.generate(url, { small: true });
    }
  });

  const shutdown = () => {
    snapshots.flush();
    server.close(() => {
      close();
      process.exit(0);
    });
    // Don't wait forever on open connections.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('exit', () => snapshots.flush());
} catch (err) {
  console.error(`\n${APP_NAME} could not start:\n`);
  console.error((err as Error).message);
  console.error('\nCheck that PHOTOS_ROOT and DATA_DIR are writable, then try again.');
  process.exit(1);
}
