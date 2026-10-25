# Dokumentasi Teknis & Tech Stack

## Tech Stack
- **Runtime:** Node.js (v18+)
- **Database:** SQLite (`node:sqlite`, bawaan Node.js v22.5+)
- **Frontend:** Vanilla HTML5, CSS (Tailwind via CDN), JavaScript (SPA tunggal)
- **Agent Runner:** OpenCode CLI (`opencode`) dengan format JSONL streaming
- **Version Control:** Git & GitHub CLI (`gh`) untuk manajemen branch & PR otomatis per task

---

## Arsitektur Sistem (`server.js`)
1. **Single-File Backend (`server.js`):** Menggabungkan server HTTP bawaan Node, manajemen database SQLite, dan eksekusi child process (CLI agent).
2. **Database Schema (`tasks.db`):**
   - `root`: Daftar folder root direktori kerja yang diizinkan.
   - `model`: Daftar model AI yang didukung (mis. `9router/deepsek`).
   - `task`: Menyimpan judul, root, folder, prompt, model, status (`todo`, `doing`, `review`, `done`, `error`), log output, dan diff git.
3. **Execution Guard & Git Isolation:**
   - Setiap task dijalankan di folder terisolasi di bawah root yang divalidasi ketat (`safeDir`).
   - Setiap task otomatis membuat branch Git terisolasi (`task/<id>`).
   - Concurrency dikontrol ketat (`MAX_RUN = 2`).

---

## API Endpoints
- `GET /api/tasks` — List semua task, model, roots, dan kolom Kanban.
- `POST /api/tasks` — Tambah task baru.
- `PATCH /api/tasks/:id` — Update status atau properti task.
- `POST /api/tasks/:id/run` — Jalankan task via agent CLI.
- `POST /api/tasks/:id/cancel` — Hentikan proses agent yang sedang berjalan.
- `DELETE /api/tasks/:id` — Hapus task.
- `GET/POST /api/roots` & `GET/POST /api/models` — Pengaturan root folder & model AI.
- `POST /api/repo` — Inisialisasi Git repo dan buat remote repo via GitHub CLI (`gh`).
