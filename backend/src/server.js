import http from 'node:http';
import config from './config.js';
import { createApp } from './app.js';
import { attachWebSocket, closeWebSocket } from './realtime/hub.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';

const app = createApp();
const server = http.createServer(app);

attachWebSocket(server);
startScheduler();

server.listen(config.port, () => {
  console.log(`[api]  http://localhost:${config.port}/api`);
  console.log(`[docs] http://localhost:${config.port}/api/docs`);
  console.log(`[ws]   ws://localhost:${config.port}/ws?showId=<id>`);
  console.log(`[mail] transport=${config.mail.transport}`);
});

function shutdown(signal) {
  console.log(`\n[server] ${signal} received, shutting down`);
  stopScheduler();
  closeWebSocket();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

export default server;
