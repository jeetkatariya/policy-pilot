// Launches the Fastify server and an ngrok tunnel in one command. The tunnel
// is gated with HTTP Basic Auth so the public URL can only be used by someone
// who also has the credentials printed in the startup banner.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const PORT = Number(process.env.PORT) || 3001;
const NGROK_USER = process.env.NGROK_USER || 'infer';
const NGROK_PASS = process.env.NGROK_PASS || randomBytes(9).toString('base64url');
const NGROK_DOMAIN = process.env.NGROK_DOMAIN || null;

let shuttingDown = false;
const children = [];

function prefixed(stream, label) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.trim()) process.stdout.write(`[${label}] ${line}\n`);
    }
  });
}

function track(child, label) {
  children.push(child);
  child.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`[${label}] exited with code ${code} — tearing down`);
      shutdown();
    }
  });
}

async function waitForServerReady(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/carriers`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`server did not become ready on :${PORT}`);
}

async function fetchPublicUrl(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch('http://127.0.0.1:4040/api/tunnels');
      if (r.ok) {
        const j = await r.json();
        const tunnel = (j.tunnels || []).find((t) => t.public_url?.startsWith('https://'));
        if (tunnel) return tunnel.public_url;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  return null;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) c.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

const server = spawn('node', ['server/index.js'], {
  env: { ...process.env, PORT: String(PORT) },
});
prefixed(server.stdout, 'server');
prefixed(server.stderr, 'server');
track(server, 'server');

await waitForServerReady();

const ngrokArgs = [
  'http',
  String(PORT),
  '--basic-auth', `${NGROK_USER}:${NGROK_PASS}`,
  '--log', 'stderr',
];
if (NGROK_DOMAIN) ngrokArgs.push('--domain', NGROK_DOMAIN);
const ngrok = spawn('ngrok', ngrokArgs);
prefixed(ngrok.stderr, 'ngrok');
track(ngrok, 'ngrok');

const publicUrl = await fetchPublicUrl();
const lines = [
  '',
  '────────────────────────────────────────────────',
  ' Policy Pilot — public tunnel',
  '────────────────────────────────────────────────',
  ` URL:      ${publicUrl || '(not detected — check http://127.0.0.1:4040)'}`,
  ` Username: ${NGROK_USER}`,
  ` Password: ${NGROK_PASS}`,
  '────────────────────────────────────────────────',
  '',
];
process.stdout.write(lines.join('\n') + '\n');
