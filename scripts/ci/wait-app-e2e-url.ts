const [url, pidText, timeoutText] = process.argv.slice(2);
const appPid = Number(pidText);
const timeoutMs = Number(timeoutText);
if (!url || !Number.isInteger(appPid) || appPid <= 0 || !Number.isFinite(timeoutMs)) {
  throw new Error('usage: wait-app-e2e-url.ts <url> <app-pid> <timeout-ms>');
}

const deadline = Date.now() + timeoutMs;
let lastError = 'no response';
while (Date.now() < deadline) {
  try {
    process.kill(appPid, 0);
  } catch {
    throw new Error(`app process ${appPid} exited before ${url} became ready`);
  }
  const remainingMs = deadline - Date.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(Math.min(2_000, Math.max(1, remainingMs))),
    });
    if (response.ok) process.exit(0);
    lastError = `HTTP ${response.status}`;
  } catch (error) {
    lastError = String(error);
  }
  await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
}

throw new Error(`${url} not ready within ${timeoutMs}ms: ${lastError}`);
