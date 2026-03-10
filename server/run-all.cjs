require('dotenv').config();

const crypto = require('crypto');
const { spawn } = require('child_process');

const sharedEnv = {
  ...process.env,
  INTERNAL_WEBHOOK_SECRET: process.env.INTERNAL_WEBHOOK_SECRET || crypto.randomBytes(32).toString('hex'),
};

const children = [];

function startProcess(label, script, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: sharedEnv,
    stdio: 'inherit',
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (signal) {
      console.log(`[${label}] exited with signal ${signal}`);
    } else {
      console.log(`[${label}] exited with code ${code}`);
    }
    for (const other of children) {
      if (other !== child && !other.killed) {
        other.kill('SIGTERM');
      }
    }
    process.exit(code || 0);
  });
}

startProcess('api', 'server/index.cjs', ['--no-embedded-worker']);
startProcess('worker', 'server/worker.cjs');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const child of children) {
      if (!child.killed) child.kill(signal);
    }
  });
}
