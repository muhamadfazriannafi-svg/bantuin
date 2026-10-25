// Kanban + agent runner. Satu folder = satu task. Branch baru per task, review diff sebelum merge.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 8790;
const AGENT = process.env.AGENT_CMD || 'C:\\Program Files\\nodejs\\node_modules\\@opencode\\cli\\bin\\opencode.exe';
const AGENT_SHELL = process.env.AGENT_SHELL === '1'; // 1 = pakai .cmd (Windows shim)
const MAX_RUN = 2;          // concurrency keras
const TIMEOUT = 30 * 60 * 1000;
const COLS = ['todo', 'doing', 'review', 'done', 'error'];

// --- db ---
const db = new DatabaseSync(path.join(__dirname, 'tasks.db'));
db.exec(`CREATE TABLE IF NOT EXISTS root (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS model (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS task (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL, root TEXT NOT NULL, folder TEXT NOT NULL, prompt TEXT NOT NULL,
    model TEXT NOT NULL, agent TEXT, branch TEXT,
    status TEXT NOT NULL DEFAULT 'todo',
    output TEXT NOT NULL DEFAULT '', diff TEXT NOT NULL DEFAULT '',
    created TEXT NOT NULL, started TEXT, ended TEXT, start_date TEXT
  );`);
// Migrasi ringan untuk DB lama.
try { db.exec('ALTER TABLE task ADD COLUMN start_date TEXT'); } catch {}

// Seed awal cuma kalau tabel kosong. Env ROOTS/WORK_ROOT dipakai sekali di sini.
const seed = (table, vals) => {
  if (db.prepare(`SELECT count(*) c FROM ${table}`).get().c) return;
  const ins = db.prepare(`INSERT INTO ${table} (${table === 'root' ? 'path' : 'name'}) VALUES (?)`);
  for (const v of vals) try { ins.run(v); } catch {}
};
seed('root', (process.env.ROOTS || process.env.WORK_ROOT || 'E:\\produksi\\standar')
  .split(';').map(s => s.trim()).filter(Boolean).map(p => path.resolve(p)));
seed('model', ['9router/deepsek', '9router/combo-command', '9router/opencode']);

const q = {
  all: () => db.prepare('SELECT * FROM task ORDER BY id').all(),
  get: id => db.prepare('SELECT * FROM task WHERE id = ?').get(id),
  insert: t => db.prepare(`INSERT INTO task (title,root,folder,prompt,model,agent,status,created,start_date)
    VALUES (?,?,?,?,?,?,'todo',?,?)`).run(t.title, t.root, t.folder, t.prompt, t.model, t.agent, new Date().toISOString(), t.start_date || null).lastInsertRowid,
  upd: (id, patch) => {
    const keys = Object.keys(patch);
    if (!keys.length) return;
    db.prepare(`UPDATE task SET ${keys.map(k => `${k}=?`).join(',')} WHERE id=?`).run(...keys.map(k => patch[k]), id);
  },
  del: id => db.prepare('DELETE FROM task WHERE id = ?').run(id),
  roots: () => db.prepare('SELECT * FROM root ORDER BY id').all(),
  models: () => db.prepare('SELECT * FROM model ORDER BY id').all(),
};
const running = new Set();
const procs = new Map();   // task id -> ChildProcess, supaya bisa dihentikan
// Server restart membunuh proses agent, tapi status di DB tetap 'doing'. Reset supaya tidak jadi zombie.
db.prepare(`UPDATE task SET status='error', ended=?, output = output || '\n\n[server restart saat task berjalan]' WHERE status='doing'`)
  .run(new Date().toISOString());
// Root aktif, dengan realpath dihitung sekali per request supaya validasi tetap ketat.
const rootsWithReal = () => q.roots().filter(r => r.active).map(r => {
  try { return { path: r.path, real: fs.realpathSync(r.path) }; } catch { return null; }
}).filter(Boolean);
const modelNames = () => q.models().filter(m => m.active).map(m => m.name);

// --- git helper ---
const git = (cwd, args) => new Promise((res, rej) => {
  execFile('git', args, { cwd, timeout: 30000 }, (e, out, err) => e ? rej(new Error(err || e.message)) : res(out.trim()));
});

// Folder task: nama relatif di bawah root terpilih. Tolak traversal & symlink keluar.
// requireGit=false dipakai saat akan membuat repo baru (folder memang belum punya .git).
function safeDir(root, name, requireGit = true) {
  const r = rootsWithReal().find(x => x.path === root);
  if (!r) throw new Error('root tidak dikenal');
  if (!name || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error('nama folder tidak valid');
  const real = fs.realpathSync(path.resolve(r.path, name));
  if (!real.startsWith(r.real + path.sep)) throw new Error('folder di luar root');
  if (!fs.statSync(real).isDirectory()) throw new Error('bukan folder');
  if (requireGit && !fs.existsSync(path.join(real, '.git'))) throw new Error('folder tanpa git repo');
  return real;
}

async function ensureBranch(dir, id) {
  const branch = `task/${id}`;
  const dirty = await git(dir, ['status', '--porcelain']);
  const cur = await git(dir, ['branch', '--show-current']);
  if (cur === branch) return branch; // sudah di branch task ini
  if (dirty && dirty !== '') {
    // ponytail: simpan work-in-progress user di stash, bukan ditimpa. Ceiling: tidak auto-pop.
    await git(dir, ['stash', 'push', '-u', '-m', `kanban-${id}-auto`]);
  }
  const exists = await git(dir, ['branch', '--list', branch]).catch(() => '');
  await git(dir, exists ? ['checkout', branch] : ['checkout', '-b', branch]);
  return branch;
}

function runTask(t) {
  if (running.size >= MAX_RUN || running.has(t.id)) return;
  running.add(t.id);
  q.upd(t.id, { status: 'doing', output: '', diff: '', started: new Date().toISOString() });
  (async () => {
    let dir, branch;
    try {
      dir = safeDir(t.root, t.folder);
      branch = await ensureBranch(dir, t.id);
      q.upd(t.id, { branch });
    } catch (e) {
      q.upd(t.id, { status: 'error', output: 'pre-run: ' + e.message, ended: new Date().toISOString() });
      running.delete(t.id); return;
    }
    const args = ['run', '--model', t.model, '--title', `kanban-${t.id}: ${t.title}`, '--auto', '--format', 'json'];
    args.push(t.prompt);
    // spawn (bukan execFile) supaya output bisa ditulis ke DB bertahap = log live.
    // --format json wajib: mode teks default menahan output saat bukan TTY (nol byte sampai selesai).
    const child = spawn(AGENT, args, { cwd: dir, env: process.env, shell: AGENT_SHELL, windowsHide: true });
    procs.set(t.id, child);
    let buf = '', pending = false, rest = '';
    const clean = s => String(s || '').replace(/\x1b\[[0-9;]*m/g, '');
    const flush = () => {
      if (pending) return;              // throttle: 1 tulis / 800ms
      pending = true;
      setTimeout(() => { pending = false; q.upd(t.id, { output: buf.slice(-200000) }); }, 800);
    };
    const push = s => { buf = (buf + s).slice(-200000); flush(); };
    // Event JSONL -> baris teks yang mirip opencode biasa.
    const render = ev => {
      const p = ev.part || {};
      switch (ev.type) {
        case 'step_start': return '';
        case 'text': return (p.text || '');
        case 'reasoning': return '';
        case 'tool_use': {
          const name = p.tool || 'tool';
          const inp = p.state?.input || p.input || {};
          const detail = inp.filePath || inp.path || inp.command || inp.pattern || inp.description || '';
          return `\n> ${name} ${String(detail).slice(0, 160)}\n`;
        }
        case 'tool_result': {
          const st = p.state || {};
          if (st.status === 'error' || st.isError) return `! ${String(st.output || st.error || 'error').slice(0, 400)}\n`;
          return '';
        }
        case 'step_finish': {
          const tok = p.tokens || {};
          const cost = p.cost ? ` $${Number(p.cost).toFixed(4)}` : '';
          return `\n[step selesai: ${tok.input || 0} in / ${tok.output || 0} out${cost}]\n`;
        }
        case 'error': return `\nERROR: ${ev.error?.message || ev.error?.name || JSON.stringify(ev.error).slice(0, 300)}\n`;
        default: return '';
      }
    };
    const onData = d => {
      console.error(`[task ${t.id}] chunk ${d.length}B`);
      rest += clean(d);
      const lines = rest.split('\n');
      rest = lines.pop();               // simpan baris tak lengkap
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try { push(render(JSON.parse(ln))); } catch { push(ln + '\n'); } // bukan JSON = tulis apa adanya
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    const timer = setTimeout(() => { buf = 'TIMEOUT\n' + buf; child.kill(); }, TIMEOUT);
    let spawnErr = null;
    child.on('error', e => { spawnErr = e; console.error(`[task ${t.id}] spawn error:`, e.message); });
    child.on('spawn', () => console.error(`[task ${t.id}] pid ${child.pid} cwd ${dir}`));

    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      if (!buf && rest) { buf = rest; rest = ''; }   // baris terakhir tanpa newline
      let output = buf;
      if (!output.trim()) output = spawnErr
        ? `EXIT ${spawnErr.code ?? '?'}\n${spawnErr.message}\n\n(agent tidak mengeluarkan output)`
        : `EXIT ${code ?? signal}\n(agent tidak mengeluarkan output)`;
      else if (code !== 0) output += `\n\n[exit ${code ?? signal}]`;
      // verifikasi nyata: ada diff di branch ini?
      const diff = await git(dir, ['diff', '--stat', `${branch}@{u}`]).catch(async () => {
        const base = await git(dir, ['rev-parse', 'HEAD']).catch(() => '');
        return base ? await git(dir, ['diff', '--stat', `${base}...HEAD`]).catch(() => '') : '';
      }).catch(() => '');
      const cancelled = signal === 'SIGTERM' && procs.get(t.id) === child && cancelledIds.has(t.id);
      const ok = code === 0 && !spawnErr && !cancelled;
      q.upd(t.id, {
        status: ok ? 'review' : 'error',
        output: cancelled ? output + '\n\n[dihentikan oleh user]' : output,
        diff, ended: new Date().toISOString(),
      });
      cancelledIds.delete(t.id);
      procs.delete(t.id);
      running.delete(t.id);
    });
  })();
}
const cancelledIds = new Set();

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/tasks\/(\d+)(\/run|\/cancel)?$/);
  const mm = url.pathname.match(/^\/api\/(roots|models)\/(\d+)$/);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  if (url.pathname === '/api/folders') {
    const r = rootsWithReal().find(x => x.path === url.searchParams.get('root'));
    if (!r) return json(res, 400, { error: 'root tidak dikenal' });
    return json(res, 200, fs.readdirSync(r.path, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => d.name));
  }

  // --- master root & model ---
  if (url.pathname === '/api/roots' && req.method === 'GET') return json(res, 200, q.roots());
  if (url.pathname === '/api/roots' && req.method === 'POST') {
    const b = await body(req);
    if (!b.path) return json(res, 400, { error: 'path wajib' });
    const abs = path.resolve(String(b.path).trim());
    try { fs.realpathSync(abs); } catch { return json(res, 400, { error: 'folder tidak ada' }); }
    if (!fs.statSync(abs).isDirectory()) return json(res, 400, { error: 'bukan folder' });
    try { db.prepare('INSERT INTO root (path) VALUES (?)').run(abs); } catch { return json(res, 409, { error: 'sudah ada' }); }
    return json(res, 200, q.roots());
  }
  if (url.pathname === '/api/models' && req.method === 'GET') return json(res, 200, q.models());
  if (url.pathname === '/api/models' && req.method === 'POST') {
    const b = await body(req);
    const name = String(b.name || '').trim();
    if (!/^[\w.-]+\/[\w.#-]+$/.test(name)) return json(res, 400, { error: 'format provider/model' });
    try { db.prepare('INSERT INTO model (name) VALUES (?)').run(name); } catch { return json(res, 409, { error: 'sudah ada' }); }
    return json(res, 200, q.models());
  }
  if (url.pathname === '/api/repo' && req.method === 'POST') {
    const b = await body(req);
    const name = String(b.name || '').trim();
    if (!/^[\w.-]{1,100}$/.test(name)) return json(res, 400, { error: 'nama repo tidak valid' });
    let dir;
    try { dir = safeDir(b.root, b.folder, false); } catch (e) { return json(res, 400, { error: e.message }); }
    if (fs.existsSync(path.join(dir, '.git'))) return json(res, 409, { error: 'folder sudah punya git repo' });
    const priv = b.visibility !== 'public';
    const run = (cmd, args, cwd) => new Promise((ok, no) => {
      execFile(cmd, args, { cwd, timeout: 120000, windowsHide: true }, (e, out, err) =>
        e ? no(new Error((err || out || e.message).trim().split('\n').slice(-6).join('\n'))) : ok(out.trim()));
    });
    const steps = [];
    try {
      steps.push('git init');
      await run('git', ['init', '-b', 'main'], dir);
      // .gitignore minimal kalau belum ada
      const gi = path.join(dir, '.gitignore');
      if (!fs.existsSync(gi)) fs.writeFileSync(gi, 'node_modules/\ntasks.db\ntasks.db-shm\ntasks.db-wal\n.probe*\n*.log\n');
      steps.push('git add');
      await run('git', ['add', '-A'], dir);
      steps.push('git commit');
      await run('git', ['-c', 'user.name=' + (process.env.GIT_USER_NAME || 'kanban'),
        '-c', 'user.email=' + (process.env.GIT_USER_EMAIL || 'kanban@localhost'), 'commit', '-m', 'init: kanban agent'], dir);
      steps.push(`gh repo create ${name} --${priv ? 'private' : 'public'} --source . --remote origin --push`);
      const out = await run('gh', ['repo', 'create', name, priv ? '--private' : '--public',
        '--source', '.', '--remote', 'origin', '--push'], dir);
      return json(res, 200, { ok: true, steps, url: (out.match(/https:\/\/\S+/) || [''])[0], out });
    } catch (e) {
      return json(res, 500, { error: e.message, steps });
    }
  }
  if (url.pathname === '/api/repo' && req.method === 'GET') {
    // Info repo untuk folder task (dipakai UI sebelum menampilkan tombol).
    try {
      const dir = safeDir(url.searchParams.get('root'), url.searchParams.get('folder'), false);
      const hasGit = fs.existsSync(path.join(dir, '.git'));
      let remote = '';
      if (hasGit) remote = await git(dir, ['remote', 'get-url', 'origin']).catch(() => '');
      return json(res, 200, { hasGit, remote });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (mm && req.method === 'PATCH') {
    const table = mm[1] === 'roots' ? 'root' : 'model';
    if (!db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(+mm[2])) return json(res, 404, { error: 'tidak ada' });
    const b = await body(req);
    if (b.active !== undefined) db.prepare(`UPDATE ${table} SET active = ? WHERE id = ?`).run(b.active ? 1 : 0, +mm[2]);
    if (table === 'root' && b.path) {
      const abs = path.resolve(String(b.path).trim());
      try { fs.realpathSync(abs); fs.statSync(abs).isDirectory(); } catch { return json(res, 400, { error: 'folder tidak valid' }); }
      try { db.prepare('UPDATE root SET path = ? WHERE id = ?').run(abs, +mm[2]); } catch { return json(res, 409, { error: 'sudah ada' }); }
    }
    if (table === 'model' && b.name) {
      const name = String(b.name).trim();
      if (!/^[\w.-]+\/[\w.#-]+$/.test(name)) return json(res, 400, { error: 'format provider/model' });
      try { db.prepare('UPDATE model SET name = ? WHERE id = ?').run(name, +mm[2]); } catch { return json(res, 409, { error: 'sudah ada' }); }
    }
    return json(res, 200, table === 'root' ? q.roots() : q.models());
  }
  if (mm && req.method === 'DELETE') {
    const id = +mm[2];
    if (mm[1] === 'root' && running.size) {
      const busy = [...running].map(i => q.get(i)).find(t => t && t.root === db.prepare('SELECT path FROM root WHERE id=?').get(id)?.path);
      if (busy) return json(res, 409, { error: 'root dipakai task yang sedang jalan' });
    }
    db.prepare(`DELETE FROM ${mm[1] === 'roots' ? 'root' : 'model'} WHERE id = ?`).run(id);
    return json(res, 200, mm[1] === 'root' ? q.roots() : q.models());
  }

  // --- task ---
  if (url.pathname === '/api/tasks' && req.method === 'GET')
    return json(res, 200, { tasks: q.all(), models: modelNames(), cols: COLS, roots: rootsWithReal().map(r => r.path) });
  if (url.pathname === '/api/tasks' && req.method === 'POST') {
    const b = await body(req);
    if (!b.title || !b.folder || !b.prompt || !b.root) return json(res, 400, { error: 'root/folder/title/prompt wajib' });
    try { safeDir(b.root, b.folder); } catch (e) { return json(res, 400, { error: e.message }); }
    const models = modelNames();
    const id = q.insert({
      title: b.title, root: b.root, folder: b.folder, prompt: b.prompt,
      model: models.includes(b.model) ? b.model : models[0],
      agent: b.agent || null, start_date: b.start_date || null,
    });
    return json(res, 200, q.get(id));
  }
  if (m && req.method === 'PATCH' && !m[2]) {
    if (!q.get(+m[1])) return json(res, 404, { error: 'tidak ada' });
    const b = await body(req), patch = {};
    if (b.status) {
      if (!COLS.includes(b.status)) return json(res, 400, { error: 'status invalid' });
      patch.status = b.status;
      if (b.status === 'todo') { patch.output = ''; patch.diff = ''; patch.branch = null; }
    }
    if (typeof b.title === 'string') patch.title = b.title;
    if (typeof b.prompt === 'string') patch.prompt = b.prompt;
    if (modelNames().includes(b.model)) patch.model = b.model;
    if (b.agent !== undefined) patch.agent = b.agent || null;
    q.upd(+m[1], patch);
    return json(res, 200, q.get(+m[1]));
  }
  if (m && m[2] === '/cancel' && req.method === 'POST') {
    const child = procs.get(+m[1]);
    if (!child) return json(res, 409, { error: 'tidak sedang jalan' });
    cancelledIds.add(+m[1]);
    child.kill();
    setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 5000);
    return json(res, 200, { ok: true });
  }
  if (m && m[2] && req.method === 'POST') {
    const t = q.get(+m[1]);
    if (!t) return json(res, 404, { error: 'tidak ada' });
    if (running.size >= MAX_RUN) return json(res, 429, { error: `maks ${MAX_RUN} task paralel` });
    if (running.has(t.id)) return json(res, 409, { error: 'sudah jalan' });
    // status 'doing' tanpa proses aktif = sisa restart. Izinkan run ulang.
    if (t.status === 'doing') q.upd(t.id, { status: 'error', output: (t.output || '') + '\n\n[task yatim, dijalankan ulang]' });
    runTask(t); return json(res, 200, q.get(t.id));
  }
  if (m && req.method === 'DELETE') {
    if (running.has(+m[1])) return json(res, 409, { error: 'sedang jalan' });
    q.del(+m[1]); return json(res, 200, { ok: true });
  }
  res.writeHead(404); res.end('not found');
}).listen(PORT, () => console.log(`kanban: http://localhost:${PORT}  db=tasks.db  roots=${q.roots().length}  models=${q.models().length}  max_run=${MAX_RUN}`));
