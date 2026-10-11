const fs = require('node:fs');

async function main() {
  const envText = fs.readFileSync('.env', 'utf8');

  function envValue(name) {
    const line = envText.split(/\r?\n/).find(
      (l) => l.trim().startsWith(`${name}=`)
    );
    return line
      ? line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')
      : undefined;
  }

  const base = 'http://localhost:4000/api/v1';
  const email = process.env.ECOSPHERE_EMAIL;
  const password = process.env.ECOSPHERE_PASSWORD;

  if (!email || !password) {
    console.error('Set ECOSPHERE_EMAIL and ECOSPHERE_PASSWORD in your terminal first.');
    process.exitCode = 1;
    return;
  }

  const cookies = new Map();

  function rememberCookies(response) {
    for (const item of response.headers.getSetCookie?.() ?? []) {
      const pair = item.split(';', 1)[0];
      const index = pair.indexOf('=');
      if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
  }

  function cookieHeader() {
    return [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  async function request(path, options = {}) {
    const headers = { ...(options.headers ?? {}) };
    if (cookies.size) headers.Cookie = cookieHeader();

    const response = await fetch(`${base}${path}`, {
      ...options,
      headers,
      redirect: 'manual',
    });
    rememberCookies(response);

    const body = await response.json().catch(() => null);
    return { status: response.status, body };
  }

  const login = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (login.status !== 200 || !login.body?.data?.csrfToken) {
    console.error('Login failed:', login.status, login.body);
    process.exitCode = 1;
    return;
  }

  const csrf = login.body.data.csrfToken;
  console.log('Logged in successfully.');

  const jobId = '26bfe89a-796d-4cbf-ba36-e67ff3b3807d';
  const saved = await request(`/optimization/jobs/${jobId}/plan`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify({ assignments: [] }),
  });

  console.log('Save response:', JSON.stringify(saved, null, 2));

  if (saved.status >= 200 && saved.status < 300) {
    const check = await request('/routes?page=1&pageSize=50');
    console.log('Routes API:', JSON.stringify({
      status: check.status,
      total: check.body?.meta?.total,
      routes: check.body?.data?.length,
    }, null, 2));
  } else {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('Request failed:', error.message);
  process.exitCode = 1;
});
