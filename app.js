// =====================================================================
//  Jadwal Pelajaran + Jurnal Harian
//  Vanilla JS (ES modules) + Firebase Auth & Firestore (Web SDK modular)
// =====================================================================
import { firebaseConfig } from "./firebase-config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, query, orderBy,
  writeBatch, setDoc, deleteDoc, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-firestore.js";

// ---------------------------------------------------------------------
// Data jadwal (urutan = jam ke-1 dst). Hanya Senin–Jum'at.
// ---------------------------------------------------------------------
const DAYS = ["Senin", "Selasa", "Rabu", "Kamis", "Jum'at"];
const SCHEDULE = Object.freeze({
  "Senin":  ["MTK", "Sejarah", "KIK", "PJOK"],
  "Selasa": ["Keamanan Jaringan", "Koding", "PPKN"],
  "Rabu":   ["Bahasa Inggris", "Bahasa Indonesia", "TJKN"],
  "Kamis":  ["PAI", "Bahasa Jawa", "PKPJ"],
  "Jum'at": ["ASJ"],
});
const SUBJECTS = [...new Set(DAYS.flatMap((d) => SCHEDULE[d]))];

const DAY_NAMES = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jum'at", "Sabtu"];
const MONTHS = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const DAY_COLORS = ["#e9a77a", "#a9cdb8", "#a9c3e6", "#d9b3d6", "#ecd47e"]; // aksen tipis per hari
const DAY_ICONS = ["🚀", "🔧", "🌐", "📖", "🌟"];
const VIEWS = ["jadwal", "jurnal", "profil"];

// ---------------------------------------------------------------------
// Util
// ---------------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const pad = (n) => String(n).padStart(2, "0");
const toDateStr = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function parseDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "")) return null;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d ? dt : null;
}
/** Index hari 0..4 (Senin..Jum'at), atau -1 kalau akhir pekan / tidak valid. */
function dayIndexOf(s) {
  const d = parseDateStr(s);
  if (!d) return -1;
  const g = d.getDay();
  return g >= 1 && g <= 5 ? g - 1 : -1;
}
function formatDateLong(s) {
  const d = parseDateStr(s);
  return d ? `${DAY_NAMES[d.getDay()]}, ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}` : s;
}
function withTimeout(promise, ms = 15000) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject({ code: "app/timeout" }), ms)),
  ]);
}

const ERROR_MESSAGES = {
  "permission-denied": "Akses ditolak oleh Firestore. Cek firestore.rules dan pastikan UID sudah diganti dengan UID akunmu.",
  "unavailable": "Tidak bisa terhubung ke server. Periksa koneksi internetmu lalu coba lagi.",
  "unauthenticated": "Sesi login berakhir. Silakan masuk lagi.",
  "not-found": "Data tidak ditemukan (mungkin sudah dihapus).",
  "deadline-exceeded": "Server terlalu lama merespons. Coba lagi sebentar lagi.",
  "resource-exhausted": "Kuota Firebase sedang habis. Coba lagi nanti.",
  "app/timeout": "Koneksi terlalu lambat atau sedang offline. Coba lagi saat koneksi membaik.",
  "app/offline": "Kamu sedang offline. Sambungkan internet dulu lalu coba lagi.",
  "auth/invalid-credential": "Email atau password salah.",
  "auth/wrong-password": "Email atau password salah.",
  "auth/user-not-found": "Email atau password salah.",
  "auth/invalid-email": "Format email tidak valid.",
  "auth/user-disabled": "Akun ini dinonaktifkan.",
  "auth/too-many-requests": "Terlalu banyak percobaan. Tunggu beberapa menit lalu coba lagi.",
  "auth/network-request-failed": "Gagal terhubung ke internet. Periksa koneksimu.",
  "auth/operation-not-allowed": "Login email/password belum diaktifkan di Firebase Authentication.",
  "auth/unauthorized-domain": "Domain situs ini belum ditambahkan ke Authorized domains di Firebase.",
  "auth/invalid-api-key": "API key Firebase tidak valid. Periksa firebase-config.js.",
};
function friendlyError(err) {
  const code = String(err?.code || "").replace(/^firestore\//, "");
  return ERROR_MESSAGES[code] || "Terjadi kesalahan. Coba lagi ya.";
}

// ---------------------------------------------------------------------
// Firebase
// ---------------------------------------------------------------------
const configReady = Object.values(firebaseConfig).every(
  (v) => typeof v === "string" && v.trim() !== "" && !v.startsWith("ISI_")
);
let auth = null;
let db = null;
if (configReady) {
  try {
    const app = initializeApp(firebaseConfig);
    auth = getAuth(app);
    db = getFirestore(app);
  } catch (err) {
    console.error("Gagal inisialisasi Firebase:", err);
  }
}

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
const state = {
  user: null,
  teachers: {},          // { [mata pelajaran]: nama guru terakhir }
  profileName: "",
  journals: [],
  journalsLoaded: false,
  journalsError: null,
  editingId: null,
  teacherTouched: false, // true jika user sudah mengetik manual di field Guru (pada form ini)
  periodTouched: false,  // true jika user sudah mengubah manual "Jam ke"
  saving: false,
};

// ---------------------------------------------------------------------
// Elemen
// ---------------------------------------------------------------------
const f = {
  form: $("#journal-form"),
  date: $("#j-date"),
  subject: $("#j-subject"),
  teacher: $("#j-teacher"),
  period: $("#j-period"),
  topic: $("#j-topic"),
  teacherHint: $("#teacher-hint"),
  periodHint: $("#period-hint"),
  submit: $("#journal-submit"),
  title: $("#form-title"),
  cancel: $("#cancel-edit"),
};
const filt = { date: $("#f-date"), subject: $("#f-subject"), reset: $("#f-reset") };

// ---------------------------------------------------------------------
// UI helper
// ---------------------------------------------------------------------
function toast(message, type = "success", ms = 4200) {
  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.setAttribute("role", type === "error" ? "alert" : "status");
  t.innerHTML = `<span aria-hidden="true">${type === "error" ? "⚠️" : "✅"}</span><p>${esc(message)}</p>`;
  $("#toasts").append(t);
  setTimeout(() => {
    t.classList.add("is-leaving");
    setTimeout(() => t.remove(), 400);
  }, ms);
}
function setBusy(btn, busy) {
  if (!btn) return;
  btn.disabled = busy;
  btn.classList.toggle("is-loading", busy);
  btn.setAttribute("aria-busy", String(busy));
}
function setFieldError(input, msg) {
  const field = input.closest(".field");
  const p = field.querySelector(".error-text");
  field.classList.toggle("has-error", !!msg);
  input.setAttribute("aria-invalid", msg ? "true" : "false");
  if (p) { p.textContent = msg || ""; p.hidden = !msg; }
}
function showScreen(name) {
  $("#boot").hidden = true;
  $("#login-screen").hidden = name !== "login";
  $("#app").hidden = name !== "app";
}
function confirmDialog(text) {
  const dlg = $("#confirm-dialog");
  $("#confirm-text").textContent = text;
  if (typeof dlg.showModal !== "function") return Promise.resolve(window.confirm(text));
  return new Promise((resolve) => {
    dlg.returnValue = "";
    dlg.addEventListener("close", () => resolve(dlg.returnValue === "ok"), { once: true });
    dlg.showModal();
  });
}
function assertOnline() {
  if (!navigator.onLine) throw { code: "app/offline" };
}

// ---------------------------------------------------------------------
// Router sederhana (hash)
// ---------------------------------------------------------------------
function route() {
  const name = location.hash.replace("#", "");
  const view = VIEWS.includes(name) ? name : "jadwal";
  VIEWS.forEach((v) => { $(`#view-${v}`).hidden = v !== view; });
  $$(".nav-link").forEach((a) => {
    const active = a.dataset.view === view;
    a.classList.toggle("is-active", active);
    if (active) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  });
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------
function renderGreeting() {
  $("#greeting").textContent = state.profileName ? `Halo, ${state.profileName}` : "Halo!";
  $("#today-label").textContent = formatDateLong(toDateStr(new Date()));
}

function renderSchedule() {
  const g = new Date().getDay();
  const isToday = g >= 1 && g <= 5;
  const hi = isToday ? g - 1 : 0; // akhir pekan -> highlight Senin berikutnya

  $("#schedule-sub").textContent = isToday
    ? `Hari ini ${DAYS[hi]}. Semangat belajar!`
    : "Akhir pekan 🎉 — jadwal berikutnya: Senin.";

  $("#schedule-grid").innerHTML = DAYS.map((day, i) => {
    const lessons = SCHEDULE[day].map((subject, k) => {
      const teacher = state.teachers[subject];
      return `
        <li class="lesson">
          <span class="jam" aria-hidden="true">${k + 1}</span>
          <div>
            <p class="lesson-meta">Jam ke-${k + 1}</p>
            <p class="lesson-name">${esc(subject)}</p>
            ${teacher ? `<p class="lesson-teacher">👤 ${esc(teacher)}</p>` : ""}
          </div>
        </li>`;
    }).join("");
    const badge = i === hi ? `<span class="badge">${isToday ? "Hari ini" : "Berikutnya"}</span>` : "";
    return `
      <article class="day-card ${i === hi ? "is-highlight" : ""}" style="--day:${DAY_COLORS[i]}">
        <header class="day-head">
          <h3><span aria-hidden="true">${DAY_ICONS[i]}</span> ${day}</h3>${badge}
        </header>
        <ol class="lesson-list">${lessons}</ol>
      </article>`;
  }).join("");
}

function renderJournalList() {
  const box = $("#journal-list");

  if (state.journalsError) {
    box.innerHTML = `
      <div class="card empty">
        <span class="emoji">📡</span>
        <h4>Jurnal belum bisa dimuat</h4>
        <p class="muted">${esc(state.journalsError)}</p>
        <button class="btn btn-ghost" type="button" data-action="retry">Coba lagi</button>
      </div>`;
    return;
  }
  if (!state.journalsLoaded) {
    box.innerHTML = `<div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>`;
    return;
  }
  if (!state.journals.length) {
    box.innerHTML = `
      <div class="card empty">
        <span class="emoji">🌱</span>
        <h4>Belum ada jurnal</h4>
        <p class="muted">Yuk catat pelajaran pertamamu lewat form di atas!</p>
      </div>`;
    return;
  }

  const fd = filt.date.value;
  const fs = filt.subject.value;
  const items = state.journals.filter((j) => (!fd || j.date === fd) && (!fs || j.subject === fs));
  if (!items.length) {
    box.innerHTML = `
      <div class="card empty">
        <span class="emoji">🔍</span>
        <h4>Tidak ada yang cocok</h4>
        <p class="muted">Coba ubah atau reset filter.</p>
      </div>`;
    return;
  }

  const groups = new Map();
  items.forEach((j) => {
    if (!groups.has(j.date)) groups.set(j.date, []);
    groups.get(j.date).push(j);
  });

  box.innerHTML = [...groups].map(([date, list]) => {
    const idx = dayIndexOf(date);
    const color = idx >= 0 ? DAY_COLORS[idx] : "#eecaa6";
    return `
      <section class="date-group">
        <h4>${esc(formatDateLong(date))}</h4>
        <div class="entries">
          ${list.map((j) => `
            <article class="entry" style="--day:${color}">
              <div class="entry-top">
                <span class="chip">Jam ke-${j.period}</span>
                <h4 class="entry-subject">${esc(j.subject)}</h4>
                <div class="entry-actions">
                  <button class="icon-btn" type="button" data-action="edit" data-id="${esc(j.id)}" aria-label="Edit jurnal ${esc(j.subject)}" title="Edit">✏️</button>
                  <button class="icon-btn" type="button" data-action="delete" data-id="${esc(j.id)}" aria-label="Hapus jurnal ${esc(j.subject)}" title="Hapus">🗑️</button>
                </div>
              </div>
              ${j.teacher ? `<p class="entry-teacher">👤 ${esc(j.teacher)}</p>` : ""}
              <p class="entry-topic">${esc(j.topic)}</p>
            </article>`).join("")}
        </div>
      </section>`;
  }).join("");
}

function renderAll() {
  renderGreeting();
  renderSchedule();
  renderJournalList();
  applyTeacherSuggestion(); // sinkronkan saran guru setelah data meta termuat
  $("#p-name").value = state.profileName;
}

function fillSubjectSelects() {
  f.subject.innerHTML =
    `<option value="">Pilih mata pelajaran</option>` +
    SUBJECTS.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
  filt.subject.innerHTML =
    `<option value="">Semua pelajaran</option>` +
    SUBJECTS.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join("");
}

// ---------------------------------------------------------------------
// Data (Firestore)
// ---------------------------------------------------------------------
async function loadTeachers() {
  const snap = await getDoc(doc(db, "meta", "subjectTeachers"));
  state.teachers = snap.exists() ? snap.data().teachers || {} : {};
}
async function loadProfile() {
  const snap = await getDoc(doc(db, "meta", "profile"));
  state.profileName = snap.exists() ? String(snap.data().name || "") : "";
}
async function loadJournals() {
  const snap = await getDocs(query(collection(db, "journals"), orderBy("date", "desc")));
  state.journals = snap.docs.map((d) => {
    const x = d.data();
    return {
      id: d.id,
      date: x.date || "",
      subject: x.subject || "",
      teacher: x.teacher || "",
      period: Number(x.period) || 0,
      topic: x.topic || "",
      _ms: x.createdAt?.toMillis?.() ?? 0,
    };
  });
  sortJournals();
}
function sortJournals() {
  state.journals.sort((a, b) =>
    b.date.localeCompare(a.date) || a.period - b.period || a._ms - b._ms
  );
}

async function loadAll() {
  state.journalsLoaded = false;
  state.journalsError = null;
  renderJournalList();

  const results = await Promise.allSettled([
    withTimeout(loadTeachers()),
    withTimeout(loadProfile()),
    withTimeout(loadJournals()),
  ]);
  const journalResult = results[2];
  state.journalsLoaded = journalResult.status === "fulfilled";
  if (journalResult.status === "rejected") state.journalsError = friendlyError(journalResult.reason);

  const failed = results.find((r) => r.status === "rejected");
  if (failed) {
    console.error(failed.reason);
    toast(friendlyError(failed.reason), "error");
  }
  renderAll();
}

// ---------------------------------------------------------------------
// SARAN GURU OTOMATIS
// ---------------------------------------------------------------------
/**
 * Dipanggil saat mata pelajaran berubah (dan setelah data meta dimuat).
 * - Kalau user BELUM mengetik manual di field Guru (state.teacherTouched === false),
 *   field diisi nama guru terakhir untuk pelajaran itu (atau dikosongkan bila belum ada).
 * - Kalau user sudah mengetik manual, teksnya TIDAK ditimpa.
 */
function applyTeacherSuggestion() {
  const suggestion = (f.subject.value && state.teachers[f.subject.value]) || "";
  if (!state.teacherTouched) f.teacher.value = suggestion;
  updateTeacherHint();
}
function updateTeacherHint() {
  const suggestion = (f.subject.value && state.teachers[f.subject.value]) || "";
  f.teacherHint.hidden = !(suggestion && f.teacher.value.trim() === suggestion);
}

/** Prefill "Jam ke" dari jadwal hari tersebut (tidak menimpa input manual). */
function applyPeriodPrefill() {
  if (state.periodTouched) return;
  const idx = dayIndexOf(f.date.value);
  const subject = f.subject.value;
  if (idx < 0 || !subject) return;
  const pos = SCHEDULE[DAYS[idx]].indexOf(subject);
  if (pos >= 0) {
    f.period.value = String(pos + 1);
    f.periodHint.hidden = false;
  }
}

// ---------------------------------------------------------------------
// Form jurnal
// ---------------------------------------------------------------------
function checkDateField() {
  const v = f.date.value;
  if (!v) { setFieldError(f.date, "Tanggal wajib diisi."); return false; }
  const d = parseDateStr(v);
  if (!d) { setFieldError(f.date, "Tanggal tidak valid."); return false; }
  const g = d.getDay();
  if (g === 0 || g === 6) {
    setFieldError(f.date, `Tanggal itu hari ${DAY_NAMES[g]}. Jurnal hanya bisa diisi untuk hari sekolah (Senin–Jum'at).`);
    return false;
  }
  setFieldError(f.date, "");
  return true;
}

function validateForm() {
  let firstInvalid = null;
  const mark = (input, msg) => { setFieldError(input, msg); if (msg && !firstInvalid) firstInvalid = input; };

  mark(f.date, "");
  if (!checkDateField()) firstInvalid = firstInvalid || f.date;

  mark(f.subject, f.subject.value ? "" : "Pilih mata pelajaran.");

  const period = Number(f.period.value);
  mark(f.period, Number.isInteger(period) && period >= 1 && period <= 12 ? "" : "Isi jam ke (1–12).");

  mark(f.teacher, f.teacher.value.trim().length > 60 ? "Nama guru maksimal 60 karakter." : "");
  mark(f.topic, f.topic.value.trim() ? "" : "Topik utama wajib diisi.");

  if (firstInvalid) { firstInvalid.focus(); return null; }
  return {
    date: f.date.value,
    subject: f.subject.value,
    teacher: f.teacher.value.trim().replace(/\s+/g, " "),
    period,
    topic: f.topic.value.trim(),
  };
}

function resetForm({ keepDate = false } = {}) {
  const date = keepDate && f.date.value ? f.date.value : toDateStr(new Date());
  state.editingId = null;
  state.teacherTouched = false;
  state.periodTouched = false;
  f.form.reset();
  f.date.value = date;
  [f.date, f.subject, f.teacher, f.period, f.topic].forEach((el) => setFieldError(el, ""));
  f.teacherHint.hidden = true;
  f.periodHint.hidden = true;
  f.title.textContent = "Tambah Jurnal";
  f.submit.textContent = "💾 Simpan Jurnal";
  f.cancel.hidden = true;
  // Kalau default (hari ini) jatuh di akhir pekan, tampilkan pesannya langsung.
  if (dayIndexOf(f.date.value) < 0) checkDateField();
}

function startEdit(id) {
  const j = state.journals.find((x) => x.id === id);
  if (!j) return;
  state.editingId = id;
  state.teacherTouched = false; // kalau pelajaran diganti saat edit, saran guru baru tetap berlaku
  state.periodTouched = false;
  f.date.value = j.date;
  f.subject.value = j.subject;
  f.teacher.value = j.teacher;
  f.period.value = String(j.period);
  f.topic.value = j.topic;
  [f.date, f.subject, f.teacher, f.period, f.topic].forEach((el) => setFieldError(el, ""));
  f.periodHint.hidden = true;
  updateTeacherHint();
  f.title.textContent = "Edit Jurnal";
  f.submit.textContent = "💾 Simpan Perubahan";
  f.cancel.hidden = false;
  f.form.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function handleJournalSubmit(e) {
  e.preventDefault();
  if (state.saving) return;
  const data = validateForm();
  if (!data) return;

  state.saving = true;
  setBusy(f.submit, true);
  try {
    assertOnline();
    const batch = writeBatch(db);
    const editing = state.editingId;
    let ref;
    if (editing) {
      ref = doc(db, "journals", editing);
      batch.update(ref, data);
    } else {
      ref = doc(collection(db, "journals"));
      batch.set(ref, { ...data, createdAt: serverTimestamp() });
    }
    // Perbarui pemetaan pelajaran -> guru terakhir (menggantikan saran sebelumnya)
    