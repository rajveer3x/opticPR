import { createDemoApp } from './demo.js';

try {
  const port = Number(process.env.DEMO_PORT ?? 4175);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DEMO_PORT must be between 1 and 65535');
  const app = await createDemoApp();
  const server = app.listen(port, '127.0.0.1', () => {
    console.log(`Open the read-only OpticPR demo at http://127.0.0.1:${port}/demo`);
  });
  server.on('error', () => { console.error('Demo port unavailable. Choose another port with DEMO_PORT.'); process.exitCode = 1; });
  process.once('SIGINT', () => server.close());
  process.once('SIGTERM', () => server.close());
} catch (error) {
  console.error(error instanceof Error && error.message.startsWith('DEMO_PORT') ? error.message :
    'Demo assets or bundled reports are unavailable. Run pnpm build from a complete checkout.');
  process.exitCode = 1;
}
