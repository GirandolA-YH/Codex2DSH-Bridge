/**
 * Grandchild process for the fake runner: writes a heartbeat file every 200 ms
 * so tests can prove that cancellation/timeout stops the *whole* tree, not just
 * the direct child. Exits on its own after 10 minutes as a safety net.
 */
import fs from 'node:fs';

const heartbeatFile = process.argv[2] ?? '';
if (heartbeatFile === '') process.exit(2);

fs.writeFileSync(heartbeatFile, `pid=${process.pid}\n`);
const started = Date.now();

const timer = setInterval(() => {
  try {
    fs.appendFileSync(heartbeatFile, `beat ${Date.now() - started}\n`);
  } catch {
    /* the file may be removed by the test */
  }
  if (Date.now() - started > 600000) {
    clearInterval(timer);
    process.exit(0);
  }
}, 200);
