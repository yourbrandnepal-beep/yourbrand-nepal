import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { createRRChatBackend } from './backend/app.ts';

function getCliArg(name: string): string | undefined {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name && args[i + 1]) {
      return args[i + 1];
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

async function startServer() {
  const cliPort = getCliArg('--port');
  const cliHost = getCliArg('--host');
  const envPort = process.env.PORT ? Number(process.env.PORT) : undefined;
  const PORT = cliPort
    ? Number(cliPort)
    : process.env.NODE_ENV === 'production'
      ? Number(envPort || 3000)
      : Number(process.env.APP_PORT ?? (envPort && envPort !== 8080 ? envPort : 3000));
  const HOST = cliHost || '0.0.0.0';

  const { app, server } = createRRChatBackend({
    storePath: path.resolve('data/rrchat_state.json'),
    repoRoot: process.cwd(),
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve('dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  server.listen(PORT, HOST, () => {
    console.info(`RRchat 1 server listening on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start RRchat 1 server:', err);
  process.exit(1);
});
