// Arranca a la vez el servidor (puerto 3000) y la aplicación web (puerto 5173).
// Funciona igual en Windows, Mac y Linux. Para pararlo: Ctrl + C.
import { spawn } from 'node:child_process';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const procs = [
  { name: 'servidor', color: '\x1b[36m', args: ['run', 'dev', '--workspace', 'backend'] },
  { name: 'web     ', color: '\x1b[35m', args: ['run', 'dev', '--workspace', 'frontend'] },
].map(({ name, color, args }) => {
  const child = spawn(npm, args, { stdio: ['inherit', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  const prefix = `${color}[${name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buffer = '';
    stream.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) out.write(prefix + line + '\n');
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  return child;
});

let stopping = false;
const stopAll = (code = 0) => {
  if (stopping) return;
  stopping = true;
  for (const p of procs) if (!p.killed) p.kill('SIGTERM');
  setTimeout(() => process.exit(code), 500);
};
for (const p of procs) p.on('exit', (code) => stopAll(code ?? 0));
process.on('SIGINT', () => stopAll(0));
process.on('SIGTERM', () => stopAll(0));

console.log('\n  KAI arrancando…  Abre http://localhost:5173 en el navegador cuando veas "ready".\n');
