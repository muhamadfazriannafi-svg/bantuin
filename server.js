// Kanban + agent runner. Satu folder = satu task. Branch baru per task, review diff sebelum merge.
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

// identitas commit otomatis
const GIT_NAME = process.env.GIT_USER_NAME || 'kanban';
const GIT_EMAIL = process.env.GIT_USER_EMAIL || 'kanban@localhost';

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
try { db.exec('ALTER TABLE task ADD COLUMN base_branch TEXT'); } catch {}
try { db.exec('ALTER TABLE task ADD COLUMN merged_branch TEXT'); } catch {}
try { db.exec('ALTER TABLE task ADD COLUMN pushed INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE task ADD COLUMN smoke_ok INTEGER'); } catch {}
try { db.exec('ALTER TABLE task ADD COLUMN smoke_note TEXT'); } catch {}
try { db.exec('ALTER TABLE task ADD COLUMN archived INTEGER NOT NULL DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE task ADD COLUMN commit_hash TEXT'); } catch {}

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
// Cari root aktif dari path apa pun bentuknya (case/trailing slash/short path Windows).
const findRoot = p => {
  if (!p) return null;
  const all = rootsWithReal();
  const exact = all.find(x => x.path === p);
  if (exact) return exact;
  let real;
  try { real = fs.realpathSync(p); } catch { return null; }
  return all.find(x => x.real === real) || null;
};

// --- git helper ---
const git = (cwd, args) => new Promise((res, rej) => {
  execFile('git', args, { cwd, timeout: 30000 }, (e, out, err) => e ? rej(new Error(err || e.message)) : res(out.trim()));
});

// Folder task: nama relatif di bawah root terpilih. Tolak traversal & symlink keluar.
// requireGit=false dipakai saat akan membuat repo baru (folder memang belum punya .git).
// allowMissing=true dipakai /api/repo: folder kosong baru dibuat, divalidasi tanpa realpath.
function safeDir(root, name, requireGit = true, allowMissing = false) {
  const r = rootsWithReal().find(x => x.path === root) || findRoot(root);
  if (!r) throw new Error('root tidak dikenal');
  if (!name || !/^[\w.-]+$/.test(name) || name === '.' || name === '..') throw new Error('nama folder tidak valid');
  const abs = path.resolve(r.path, name);
  if (!abs.startsWith(r.real + path.sep)) throw new Error('folder di luar root');
  const exists = fs.existsSync(abs);
  if (!exists && !allowMissing) throw new Error('folder tidak ada');
  const real = exists ? fs.realpathSync(abs) : abs;
  if (!real.startsWith(r.real + path.sep)) throw new Error('folder di luar root');
  if (exists && !fs.statSync(real).isDirectory()) throw new Error('bukan folder');
  if (requireGit && !fs.existsSync(path.join(real, '.git'))) throw new Error('folder tanpa git repo');
  return real;
}

// Alur: BUAT TASK -> branch task/<id> -> RUN -> APPROVE (commit+push) -> DONE (merge + smoke test)
async function ensureBranch(dir, id) {
  const branch = `task/${id}`;
  const dirty = await git(dir, ['status', '--porcelain']);
  const cur = await git(dir, ['branch', '--show-current']);
  const base = (cur && !cur.startsWith('task/')) ? cur : (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'main'));
  // commit otomatis dulu supaya kerjaan yang belum di-commit tidak hilang saat pindah branch
  if (dirty && cur && !cur.startsWith('task/')) {
    await autoCommit(dir, `chore: simpan perubahan sebelum task ${id}`);
  }
  const exists = await git(dir, ['branch', '--list', branch]).catch(() => '');
  await git(dir, exists ? ['checkout', branch] : ['checkout', '-b', branch]);
  return { branch, base };
}

// Commit otomatis semua perubahan. Tidak melakukan apa pun kalau tree sudah bersih.
async function autoCommit(dir, msg) {
  const dirty = await git(dir, ['status', '--porcelain']);
  if (!dirty) return { committed: false, head: '' };
  await git(dir, ['add', '-A']);
  await git(dir, ['-c', `user.name=${GIT_NAME}`, '-c', `user.email=${GIT_EMAIL}`, 'commit', '-m', msg]);
  const head = await git(dir, ['rev-parse', '--short', 'HEAD']);
  return { committed: true, head };
}

// APPROVE: commit + push branch task ke origin.
async function approveBranch(t) {
  const dir = safeDir(t.root, t.folder);
  const branch = t.branch;
  if (!branch) throw new Error('task belum punya branch');
  const cur = await git(dir, ['branch', '--show-current']);
  if (cur !== branch) await git(dir, ['checkout', branch]);
  const c = await autoCommit(dir, `feat(kanban-${t.id}): ${t.title}`);
  const remote = await git(dir, ['remote', 'get-url', 'origin']).catch(() => '');
  if (!remote) return { ...c, pushed: false, pushNote: 'tidak ada remote origin, push dilewati' };
  try {
    await git(dir, ['push', '-u', 'origin', branch]);
    return { ...c, pushed: true, pushNote: '' };
  } catch (e) {
    return { ...c, pushed: false, pushNote: 'push gagal: ' + e.message.split('\n')[0] };
  }
}

// DONE: merge branch task ke target, lalu smoke test aplikasi.
// Working tree kotor di-commit otomatis, sisanya di-stash, supaya merge tidak diblokir.
async function mergeInto(t, target) {
  const dir = safeDir(t.root, t.folder);
  const branch = t.branch;
  const ada = await git(dir, ['branch', '--list', target]);
  if (!ada) throw new Error(`branch ${target} tidak ada di repo`);
  await autoCommit(dir, `chore: simpan perubahan sebelum merge kanban-${t.id}`);
  const dirty = await git(dir, ['status', '--porcelain']);
  let stashed = false;
  if (dirty) {
    await git(dir, ['stash', 'push', '-u', '-m', `kanban-merge-${t.id}-auto`]);
    stashed = true;
  }
  let pushed = false, pushNote = '';
  try {
    await git(dir, ['checkout', target]);
    await git(dir, ['merge', '--no-ff', '-m', `merge kanban-${t.id}: ${t.title}`, branch]);
    await git(dir, ['branch', '-d', branch]).catch(() => {});
    const remote = await git(dir, ['remote', 'get-url', 'origin']).catch(() => '');
    if (remote) {
      try { await git(dir, ['push', 'origin', target]); pushed = true; }
      catch (e) { pushNote = 'push gagal: ' + e.message.split('\n')[0]; }
    }
  } catch (e) {
    // merge gagal (bentrok): batalkan supaya repo tidak tertinggal setengah merge
    await git(dir, ['merge', '--abort']).catch(() => {});
    throw new Error(e.message + (stashed ? `\n\nperubahan lokal disimpan di stash: kanban-merge-${t.id}-auto` : ''));
  }
  return { target, stashed, pushed, pushNote, head: await git(dir, ['rev-parse', '--short', 'HEAD']).catch(() => '') };
}

// Smoke test: jalankan backend/frontend sebentar, ambil output. Tidak menggantung.
function detectStart(dir) {
  const has = f => fs.existsSync(path.join(dir, f));
  if (has('composer.json') && has('artisan')) return { cmd: 'php', args: ['artisan', 'serve', '--port=8123'], kind: 'backend laravel' };
  if (has('package.json')) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      const s = pkg.scripts || {};
      for (const key of ['dev', 'start', 'serve']) if (s[key]) return { cmd: 'npm', args: ['run', key], kind: `npm run ${key}` };
    } catch {}
  }
  return null;
}

function smokeTest(dir) {
  const det = detectStart(dir);
  if (!det) return Promise.resolve({ ok: null, note: 'tidak ada package.json/artisan, smoke test dilewati', out: '' });
  return new Promise(resolve => {
    const logFile = path.join(os.tmpdir(), `kanban-smoke-${Date.now()}.log`);
    const fd = fs.openSync(logFile, 'w');
    // shell: true karena npm/php di Windows berupa .cmd
    const child = spawn(det.cmd, det.args, { cwd: dir, shell: true, windowsHide: true, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    let done = false;
    const finish = (ok, note) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch {}
      let out = '';
      try { out = fs.readFileSync(logFile, 'utf8'); } catch {}
      fs.rmSync(logFile, { force: true });
      resolve({ ok, note, kind: det.kind, out: out.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 4000) });
    };
    child.on('error', e => finish(false, 'gagal start: ' + e.message));
    child.on('exit', code => finish(code === 0, `proses keluar dengan kode ${code}`));
    // anggap sukses kalau 20 detik masih hidup (dev server memang tidak exit)
    setTimeout(() => finish(true, 'masih berjalan setelah 20 detik'), 20000);
  });
}

// TOLAK: balik ke cabang asal, buang branch task.
async function discardTask(t) {
  const dir = safeDir(t.root, t.folder);
  const branch = t.branch || `task/${t.id}`;
  const base = t.base_branch || 'main';
  const cur = await git(dir, ['branch', '--show-current']);
  if (cur === branch) await git(dir, ['checkout', base]);
  await git(dir, ['branch', '-D', branch]).catch(() => {});
  return base;
}

function runTask(t) {
  if (running.size >= MAX_RUN || running.has(t.id)) return;
  running.add(t.id);
  q.upd(t.id, { status: 'doing', output: '', diff: '', started: new Date().toISOString() });
  (async () => {
    let dir, branch, base;
    try {
      dir = safeDir(t.root, t.folder);
      ({ branch, base } = await ensureBranch(dir, t.id));
      q.upd(t.id, { branch, base_branch: base });
    } catch (e) {
      q.upd(t.id, { status: 'error', output: 'pre-run: ' + e.message, ended: new Date().toISOString() });
      running.delete(t.id); return;
    }
    const args = ['run', '--model', t.model, '--title', `kanban-${t.id}: ${t.title}`, '--auto', '--format', 'json'];
    if (!fs.existsSync(path.join(dir, 'PRD.md'))) {
      q.upd(t.id, { status: 'error', output: 'pre-run: folder belum punya PRD.md — isi PRD lewat dialog + FOLDER (ketik ulang nama folder yang sama)', ended: new Date().toISOString() });
      running.delete(t.id); return;
    }
    // opencode CLI kadang mengabaikan cwd proses (pakai workspace terakhir). Pagar eksplisit:
    args.push(`LOKASI KERJA: ${dir}\n`
      + `Semua file yang dibaca/diubah WAJIB di dalam folder itu. Jangan menyentuh folder lain (bukan ${__dirname}, bukan root ${t.root}).\n`
      + `WAJIB: baca dulu ${path.join(dir, 'PRD.md')} dan ikuti isinya sebagai spesifikasi utama. Jangan mulai kerja sebelum membacanya.\n\n${t.prompt}`);

    // stdio ke FILE, bukan pipe: opencode.exe di Windows sering tidak menulis apa pun ke pipe
    // (terbukti: pipe 0 byte, file ratusan byte). Tail file untuk log live.
    const logPath = path.join(os.tmpdir(), `kanban-${t.id}-${Date.now()}.jsonl`);
    const fd = fs.openSync(logPath, 'w');
    const child = spawn(AGENT, args, {
      cwd: dir, env: { ...process.env, PWD: dir, INIT_CWD: dir, OLDPWD: dir }, shell: AGENT_SHELL, windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    fs.closeSync(fd);                   // anak sudah memegang handle sendiri
    procs.set(t.id, child);
    let buf = '', pending = false, rest = '', offset = 0;
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
    // baca bagian file yang baru bertambah saja
    const drain = () => {
      try {
        const st = fs.statSync(logPath);
        if (st.size <= offset) return;
        const fd2 = fs.openSync(logPath, 'r');
        const b = Buffer.alloc(st.size - offset);
        fs.readSync(fd2, b, 0, b.length, offset);
        fs.closeSync(fd2);
        offset = st.size;
        onData(b.toString('utf8'));
      } catch {}
    };
    const tailer = setInterval(drain, 700);

    const timer = setTimeout(() => { buf = 'TIMEOUT\n' + buf; child.kill(); }, TIMEOUT);
    let spawnErr = null;
    child.on('error', e => { spawnErr = e; console.error(`[task ${t.id}] spawn error:`, e.message); });
    child.on('spawn', () => console.error(`[task ${t.id}] pid ${child.pid} cwd ${dir}`));

    child.on('close', async (code, signal) => {
      clearTimeout(timer);
      clearInterval(tailer);
      drain();                          // ambil sisa output yang belum terbaca
      if (!buf && rest) { buf = rest; rest = ''; }   // baris terakhir tanpa newline
      let output = buf;
      if (!output.trim()) output = spawnErr
        ? `EXIT ${spawnErr.code ?? '?'}\n${spawnErr.message}\n\n(agent tidak mengeluarkan output)`
        : `EXIT ${code ?? signal}\n(agent tidak mengeluarkan output)`;
      else if (code !== 0) output += `\n\n[exit ${code ?? signal}]`;
      // verifikasi nyata: file apa yang berubah dibanding cabang asal
      const diff = await git(dir, ['diff', '--stat', `${base}...${branch}`]).catch(async () => {
        const head = await git(dir, ['rev-parse', 'HEAD']).catch(() => '');
        return head ? await git(dir, ['diff', '--stat', `${base}...HEAD`]).catch(() => '') : '';
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
      // simpan log mentah ke output kalau render menghasilkan nol baris, biar tidak "0 byte" tanpa jejak
      if (!output.trim()) {
        let raw = '';
        try { raw = clean(fs.readFileSync(logPath, 'utf8')).trim(); } catch {}
        if (raw) q.upd(t.id, { output: `EXIT ${code ?? signal}\n(raw output, ${raw.length} byte)\n\n` + raw.slice(-20000) });
      }
      fs.rmSync(logPath, { force: true });
    });
  })();
}
const cancelledIds = new Set();

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const body = req => new Promise(r => { let b = ''; req.on('data', c => b += c); req.on('end', () => { try { r(JSON.parse(b || '{}')); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/tasks\/(\d+)(\/run|\/cancel|\/approve|\/reject|\/reset|\/merge)?$/);
  const mm = url.pathname.match(/^\/api\/(roots|models)\/(\d+)$/);

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
  }
  // Buat folder repo di bawah root kalau belum ada (idempoten). Root divalidasi lewat realpath.
  if (url.pathname === '/api/folders' && req.method === 'POST') {
    const b = await body(req);
    const r = findRoot(b.root);
    if (!r) return json(res, 400, { error: 'root tidak dikenal' });
    const name = String(b.folder || '').trim();
    if (!/^[\w.-]+$/.test(name) || name === '.' || name === '..') return json(res, 400, { error: 'nama folder tidak valid' });
    const abs = path.resolve(r.path, name);
    fs.mkdirSync(abs, { recursive: true });
    const real = fs.realpathSync(abs);
    if (!real.startsWith(r.real + path.sep)) return json(res, 400, { error: 'folder di luar root' });
    if (!fs.statSync(real).isDirectory()) return json(res, 400, { error: 'bukan folder' });
    // PRD folder: file tunggal, wajib ada sebelum task boleh run.
    // Folder tanpa PRD.md -> 400, tapi folder kosong yang baru dibuat dibuang lagi
    // biar tidak ada folder 0-byte yang terlanjur tercatat.
    const hasPrd = fs.existsSync(path.join(real, 'PRD.md'));
    if (!hasPrd) {
      if (typeof b.prd === 'string' && b.prd.trim()) {
        fs.writeFileSync(path.join(real, 'PRD.md'), b.prd.trim() + '\n');
      } else {
        if (fs.readdirSync(real).length === 0) fs.rmdirSync(real);
        return json(res, 400, { error: 'prd wajib diisi (jadi PRD.md)' });
      }
    }
    return json(res, 200, { ok: true, path: real });
  }
  if (url.pathname === '/api/folders') {
    const r = findRoot(url.searchParams.get('root'));
    if (!r) return json(res, 400, { error: 'root tidak dikenal' });
    return json(res, 200, fs.readdirSync(r.path, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => ({
        name: d.name,
        hasPrd: fs.existsSync(path.join(r.path, d.name, 'PRD.md')),
        hasGit: fs.existsSync(path.join(r.path, d.name, '.git')),
      })));
  }
  // Isi PRD folder yang sudah ada (folder lama / belum punya PRD.md).
  if (url.pathname === '/api/folders/prd') {
    const root = url.searchParams.get('root'), folder = url.searchParams.get('folder');
    let abs;
    try { abs = safeDir(root, folder); } catch (e) { return json(res, 400, { error: e.message }); }
    if (req.method === 'GET') {
      try { return json(res, 200, { prd: fs.readFileSync(path.join(abs, 'PRD.md'), 'utf8') }); }
      catch { return json(res, 200, { prd: '' }); }
    }
    const b = await body(req);
    if (!String(b.prd || '').trim()) return json(res, 400, { error: 'prd wajib diisi' });
    fs.writeFileSync(path.join(abs, 'PRD.md'), String(b.prd).trim() + '\n');
    return json(res, 200, { ok: true });
  }
  // Hapus folder, hanya kalau belum jadi repo (tanpa .git) dan tidak dipakai task.
  if (url.pathname === '/api/folders' && req.method === 'DELETE') {
    const b = await body(req);
    const r = findRoot(b.root);
    if (!r) return json(res, 400, { error: 'root tidak dikenal' });
    let abs;
    try { abs = safeDir(b.root, b.folder); } catch (e) { return json(res, 400, { error: e.message }); }
    if (fs.existsSync(path.join(abs, '.git'))) return json(res, 409, { error: 'folder sudah jadi repo, tidak dihapus' });
    if (q.all().some(t => t.root === r.path && t.folder === b.folder && !t.archived)) return json(res, 409, { error: 'masih ada task di folder ini' });
    fs.rmSync(abs, { recursive: true, force: true });
    return json(res, 200, { ok: true });
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
    try { dir = safeDir(b.root, b.folder, false, true); } catch (e) { return json(res, 400, { error: e.message }); }
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
      const dir = safeDir(url.searchParams.get('root'), url.searchParams.get('folder'), false, true);
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
    return json(res, 200, { tasks: q.all().filter(t => !t.archived), models: modelNames(), cols: COLS, roots: rootsWithReal().map(r => r.path) });
  // laporan: task yang sudah selesai merge (hilang dari board)
  if (url.pathname === '/api/report' && req.method === 'GET')
    return json(res, 200, { tasks: q.all().filter(t => t.archived) });
  if (url.pathname === '/api/branches') {
    // daftar branch lokal sebuah folder, untuk dropdown merge
    try {
      const dir = safeDir(url.searchParams.get('root'), url.searchParams.get('folder'));
      const out = await git(dir, ['branch', '--format=%(refname:short)']);
      const cur = await git(dir, ['branch', '--show-current']).catch(() => '');
      return json(res, 200, out.split('\n').map(s => s.trim()).filter(Boolean).map(name => ({ name, current: name === cur })));
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
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
      if (b.status === 'todo') { patch.output = ''; patch.diff = ''; patch.branch = null; patch.smoke_ok = null; patch.smoke_note = null; patch.archived = 0; patch.merged_branch = null; patch.commit_hash = null; }
    }
    if (typeof b.title === 'string') patch.title = b.title;
    if (typeof b.prompt === 'string') patch.prompt = b.prompt;
    if (modelNames().includes(b.model)) patch.model = b.model;
    if (b.agent !== undefined) patch.agent = b.agent || null;
    q.upd(+m[1], patch);
    return json(res, 200, q.get(+m[1]));
  }
  if (m && m[2] === '/reset' && req.method === 'POST') {
    const t = q.get(+m[1]);
    if (!t) return json(res, 404, { error: 'tidak ada' });
    if (running.has(t.id)) return json(res, 409, { error: 'task masih jalan' });
    let note = '';
    if (t.branch) {
      try {
        const base = await discardTask(t);   // buang branch + balik ke base_branch
        note = `[reset: branch ${t.branch} dihapus, kembali ke ${base}]`;
      } catch (e) {
        note = `[reset: gagal bersihkan branch ${t.branch}: ${e.message}]`;
      }
    }
    q.upd(t.id, { status: 'todo', output: note, diff: '', branch: null, archived: 0, merged_branch: null, commit_hash: null, smoke_ok: null, smoke_note: null });
    return json(res, 200, q.get(t.id));
  }
  if (m && (m[2] === '/approve' || m[2] === '/reject') && req.method === 'POST') {
    const t = q.get(+m[1]);
    if (!t) return json(res, 404, { error: 'tidak ada' });
    if (running.has(t.id)) return json(res, 409, { error: 'task masih jalan' });
    try {
      if (m[2] === '/approve') {
        // APPROVE = commit + push branch task. Merge dilakukan terpisah lewat /merge.
        const r = await approveBranch(t);
        q.upd(t.id, { status: 'done', ended: new Date().toISOString(), pushed: r.pushed ? 1 : 0,
          output: (t.output || '') + `\n\n[disetujui: ${r.committed ? 'commit ' + r.head + ' dibuat, ' : 'tidak ada perubahan baru, '}`
            + (r.pushed ? `branch ${t.branch} di-push ke origin` : r.pushNote) + ']' });
      } else {
        const base = await discardTask(t);
        q.upd(t.id, { status: 'error', base_branch: base,
          output: (t.output || '') + `\n\n[ditolak: branch ${t.branch || 'task/' + t.id} dihapus, kembali ke ${base}]` });
      }
      return json(res, 200, q.get(t.id));
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  if (m && m[2] === '/merge' && req.method === 'POST') {
    const t = q.get(+m[1]);
    if (!t) return json(res, 404, { error: 'tidak ada' });
    if (running.has(t.id)) return json(res, 409, { error: 'task masih jalan' });
    if (t.status !== 'done') return json(res, 409, { error: 'merge hanya dari kolom done' });
    if (!t.branch) return json(res, 409, { error: 'task belum punya branch' });
    const b = await body(req);
    const target = String(b.target || t.base_branch || 'main').trim();
    if (!/^[\w./-]+$/.test(target)) return json(res, 400, { error: 'nama branch tidak valid' });
    // branch task bisa sudah tidak ada (pernah di-merge/dihapus manual) -> jangan biarkan git yang mengeluh
    const dir0 = safeDir(t.root, t.folder);
    const stillThere = await git(dir0, ['branch', '--list', t.branch]).catch(() => '');
    if (!stillThere) {
      return json(res, 409, { error: `branch ${t.branch} sudah tidak ada di repo (mungkin sudah di-merge atau dihapus). Klik ULANG untuk membersihkan task.` });
    }
    try {
      const { target: merged, stashed, pushed, pushNote, head } = await mergeInto(t, target);
      q.upd(t.id, { merged_branch: merged, commit_hash: head,
        output: (t.output || '') + `\n\n[merge: ${t.branch} -> ${merged}, branch task dihapus]`
          + (head ? `\n[commit merge: ${head}]` : '')
          + (pushed ? `\n[push ${merged} ke origin]` : pushNote ? `\n[${pushNote}]` : '')
          + (stashed ? `\n[perubahan lokal otomatis di-stash: kanban-merge-${t.id}-auto]` : '')
          + '\n\n[smoke test: menjalankan aplikasi, tunggu sampai 20 detik]' });
      // smoke test dijalankan setelah merge; selesai (atau gagal) -> task masuk laporan
      smokeTest(dir0).then(sm => {
        const cur = q.get(t.id);
        q.upd(t.id, { smoke_ok: sm.ok === null ? null : (sm.ok ? 1 : 0), smoke_note: sm.note, archived: 1,
          output: (cur.output || '') + `\n[smoke test ${sm.kind ? '(' + sm.kind + ') ' : ''}${sm.ok === null ? 'dilewati' : sm.ok ? 'OK' : 'GAGAL'}: ${sm.note}]`
            + (sm.out ? `\n${sm.out}` : '') });
      }).catch(() => { q.upd(t.id, { archived: 1, smoke_note: 'smoke test error' }); });
      return json(res, 200, q.get(t.id));
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
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

