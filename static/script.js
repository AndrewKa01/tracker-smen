/* ── хранилище: теперь настоящий бэкенд на Flask + SQLite ──
   Раньше здесь был выбор window.storage → localStorage → память.
   Теперь единственный источник правды — сервер: GET /api/state
   отдаёт всё разом (settings + shifts), POST /api/state сохраняет
   всё разом. Внешний контракт store.get()/store.set() не поменялся
   ни на бит — поэтому весь остальной код (render, calc, графики)
   вообще не заметил разницы. */
let mode = 'server';

const store = {
  async get() {
    try {
      const r = await fetch('/api/state');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      mode = 'server';
      return await r.json();
    } catch (e) {
      // сервер не запущен / упал — не теряем лицо молча,
      // просто честно предупредим об этом в load()
      mode = 'error';
      return null;
    }
  },
  async set(data) {
    try {
      const r = await fetch('/api/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      mode = 'server';
    } catch (e) {
      mode = 'error';
    }
  }
};

const DEFAULT_SETTINGS = { fuelPrice: null, consumption: 9, monthGoals: {}, theme: 'dark' };
let state = { settings: { ...DEFAULT_SETTINGS }, shifts: [] };

/* ── локальная дата, а не UTC ──
   toISOString() и input.valueAsDate работают в UTC, а Уфа это UTC+5.
   Из-за этого с 00:00 до 05:00 по местному времени дата уезжала на день
   назад — то есть ровно когда записываешь смену после ночной. Считаем
   дату из локальных полей Date, тогда часовой пояс вообще ни при чём. */
const pad2 = n => String(n).padStart(2, '0');
const localDateStr = (d = new Date()) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const localMonthStr = (d = new Date()) => localDateStr(d).slice(0, 7);

async function load() {
  const saved = await store.get();
  /* Раньше было `state = saved` — и если в сохранённых данных не хватало
     блока settings, приложение падало насмерть на первом же обращении
     к state.settings.theme, причём молча: пустой экран без истории.
     Теперь недостающие поля добираются из дефолтов. */
  if (saved && typeof saved === 'object') {
    state = {
      settings: { ...DEFAULT_SETTINGS, ...(saved.settings || {}) },
      shifts: Array.isArray(saved.shifts) ? saved.shifts : []
    };
    if (!state.settings.monthGoals || typeof state.settings.monthGoals !== 'object') {
      state.settings.monthGoals = {};
    }
  }
  sortShifts();   // старые данные могли лежать вразнобой — приводим в порядок сразу
  applyTheme();   // тема сохраняется вместе с настройками
  if (state.settings.fuelPrice) document.getElementById('fuelPrice').value = state.settings.fuelPrice;
  if (state.settings.consumption) document.getElementById('consumption').value = state.settings.consumption;
  migrateGoals();
  syncGoalField();
  // видимая надпись про хранилище убрана по просьбе — но если сервер всё же
  // недоступен, это не должно происходить незаметно, поэтому оставляем след
  // в консоли браузера (F12 → Console), чтобы было что показать при отладке
  if (mode === 'error') console.warn('Сервер недоступен — данные не сохраняются. Проверь, запущен ли python app.py');
  render();
}

/* ── сортировка смен: свежие сверху ──
   Раньше новая запись просто падала в начало массива (unshift), поэтому
   если вносить смены вразброс, 3 сентября могло оказаться выше 4-го.
   Теперь после любого добавления/правки пересортировываем весь список.

   Сравниваем строки дат ('2026-09-04' > '2026-09-03') — для формата
   YYYY-MM-DD лексикографический порядок совпадает с хронологическим.
   Если дата одна и та же — сортируем по времени начала (тоже строкой,
   'ЧЧ:ММ'), чтобы два выхода за день шли в понятном порядке.
   Персоналка времени не имеет, её опускаем вниз дня. */
function sortShifts() {
  state.shifts.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;   // дата: свежие выше
    const at = a.start || '', bt = b.start || '';
    if (at !== bt) return at < bt ? 1 : -1;                   // время: позднее выше
    return 0;
  });
}

async function persist() { await store.set(state); }

/* ── расчёт одной смены ── */
function calc(s) {
  const hours = s.duration / 60;
  let liters = s.liters;
  let estimated = false;
  if (!liters && s.mileage && state.settings.consumption) {
    liters = s.mileage * state.settings.consumption / 100;
    estimated = true;
  }
  const fuelCost = (liters && state.settings.fuelPrice)
    ? liters * state.settings.fuelPrice : 0;
  const expenses = s.expenses || 0;
  const net = s.amount - fuelCost - expenses;
  return {
    hours,
    liters: liters || 0,
    estimated,
    fuelCost,
    expenses,
    net,
    grossRate: hours ? s.amount / hours : 0,
    netRate: hours ? net / hours : 0
  };
}

function saveSettings() {
  state.settings.fuelPrice = parseFloat(document.getElementById('fuelPrice').value) || null;
  state.settings.consumption = parseFloat(document.getElementById('consumption').value) || null;
  persist();
  render();
}
document.getElementById('fuelPrice').addEventListener('change', saveSettings);
document.getElementById('consumption').addEventListener('change', saveSettings);
document.getElementById('monthGoal').addEventListener('change', saveMonthGoal);

/* ══════════════════════════════════════════════════════
   ЦЕЛИ ПО МЕСЯЦАМ
   Раньше цель была одна на всё время, поэтому сентябрь наследовал
   августовскую. Теперь это словарь вида { '2026-08': 15000 },
   а поле в настройках относится к тому месяцу, который выбран
   во вкладках. ══════════════════════════════════════════ */

// старая единая цель переезжает на текущий календарный месяц
function migrateGoals() {
  if (!state.settings.monthGoals) state.settings.monthGoals = {};
  const old = state.settings.monthGoal;
  if (old && old > 0) {
    const nowKey = localMonthStr();
    if (state.settings.monthGoals[nowKey] === undefined) state.settings.monthGoals[nowKey] = old;
    delete state.settings.monthGoal;
    persist();
  }
}

function currentGoal() {
  if (selectedMonth === 'all' || selectedMonth === 'custom') return null;
  const g = (state.settings.monthGoals || {})[selectedMonth];
  return (g && g > 0) ? g : null;
}

function saveMonthGoal() {
  if (selectedMonth === 'all' || selectedMonth === 'custom') return;
  if (!state.settings.monthGoals) state.settings.monthGoals = {};
  const val = parseFloat(document.getElementById('monthGoal').value);
  if (val && val > 0) state.settings.monthGoals[selectedMonth] = val;
  else delete state.settings.monthGoals[selectedMonth];   // пустое поле = цели нет
  persist();
  render();
}

/* поле цели всегда показывает цель выбранного месяца;
   на «Все» и на своём периоде задавать её некуда — блокируем */
function syncGoalField() {
  const input = document.getElementById('monthGoal');
  const label = document.getElementById('goalFieldLabel');
  const hint = document.getElementById('goalFieldHint');
  const isMonth = selectedMonth !== 'all' && selectedMonth !== 'custom';

  input.disabled = !isMonth;
  if (isMonth) {
    label.textContent = `Цель на ${monthLabel(selectedMonth)}, ₽ (чистыми)`;
    const g = (state.settings.monthGoals || {})[selectedMonth];
    input.value = (g && g > 0) ? g : '';
    hint.textContent = 'У каждого месяца своя цель. Переключишь месяц во вкладках — тут появится его цель.';
  } else {
    label.textContent = 'Цель на месяц, ₽ (чистыми)';
    input.value = '';
    hint.textContent = 'Цель задаётся отдельно для каждого месяца. Выбери месяц во вкладках сверху, чтобы задать её.';
  }
}

/* ══════════════════════════════════════════════════════
   ВВОД ВРЕМЕНИ
   Системный <input type="time"> заменён на обычное текстовое поле
   плюс своя панель. Формат значения остался прежним — "ЧЧ:ММ",
   поэтому вся остальная логика (расчёт, сохранение, история)
   об этой замене вообще не знает.
   ══════════════════════════════════════════════════════ */

// набор цифрами: 2200 → 22:00, двоеточие ставится само
function onTimeTyped(el) {
  const digits = el.value.replace(/\D/g, '').slice(0, 4);
  el.value = digits.length <= 2 ? digits : digits.slice(0, 2) + ':' + digits.slice(2);
  if (tpTarget === el.id) syncPickerToField();
  updateDurationPreview();
}

// на выходе из поля приводим к валидному виду или очищаем
function normalizeTime(el) {
  const digits = el.value.replace(/\D/g, '');
  if (!digits) { el.value = ''; updateDurationPreview(); return; }
  // "9" → 09:00, "930" → 09:30, "2215" → 22:15
  let h, m;
  if (digits.length <= 2) { h = +digits; m = 0; }
  else if (digits.length === 3) { h = +digits.slice(0, 1); m = +digits.slice(1); }
  else { h = +digits.slice(0, 2); m = +digits.slice(2); }
  h = Math.min(23, h); m = Math.min(59, m);
  el.value = pad2(h) + ':' + pad2(m);
  updateDurationPreview();
}

let tpTarget = null;   // id поля, которое сейчас редактируем

function openTimePicker(fieldId) {
  tpTarget = fieldId;
  document.getElementById('tpTitle').textContent =
    fieldId === 'startTime' ? 'Начало смены' : 'Конец смены';
  document.getElementById('timePicker').style.display = 'block';
  document.getElementById(fieldId).blur();   // чтобы на телефоне не лезла клавиатура
  buildPickerChips();
  buildPickerGrids();
  syncPickerToField();
}

function closeTimePicker() {
  tpTarget = null;
  document.getElementById('timePicker').style.display = 'none';
}

/* быстрые варианты: «сейчас» и время, которое ты чаще всего ставишь.
   Берём из уже записанных смен — у курьера время выходов повторяется,
   поэтому в 90% случаев нужное значение будет прямо здесь. */
function buildPickerChips() {
  const box = document.getElementById('tpChips');
  const field = tpTarget === 'startTime' ? 'start' : 'end';
  const counts = {};
  state.shifts.forEach(s => {
    const v = s[field];
    if (isValidTime(v)) counts[v] = (counts[v] || 0) + 1;
  });
  const now = new Date();
  const nowVal = pad2(now.getHours()) + ':' + pad2(now.getMinutes());
  // «Сейчас» уже показан отдельной кнопкой — в частых не дублируем
  const top = Object.keys(counts)
    .filter(v => v !== nowVal)
    .sort((a, b) => counts[b] - counts[a])
    .slice(0, 4);
  box.innerHTML =
    `<button type="button" class="tp-chip now" onclick="pickTime('${nowVal}')">Сейчас ${nowVal}</button>` +
    top.map(v => `<button type="button" class="tp-chip" onclick="pickTime('${v}')">${v}</button>`).join('');
}

function buildPickerGrids() {
  const hours = document.getElementById('tpHours');
  const mins = document.getElementById('tpMins');
  if (hours.childElementCount) return;   // сетки статичные, строим один раз
  let h = '';
  for (let i = 0; i < 24; i++) h += `<button type="button" class="tp-cell" data-h="${i}" onclick="pickHour(${i})">${pad2(i)}</button>`;
  hours.innerHTML = h;
  let m = '';
  for (let i = 0; i < 60; i += 5) m += `<button type="button" class="tp-cell" data-m="${i}" onclick="pickMinute(${i})">${pad2(i)}</button>`;
  mins.innerHTML = m;
}

// текущее значение поля, разобранное на часы и минуты
function pickerParts() {
  const v = document.getElementById(tpTarget).value;
  if (isValidTime(v)) {
    const [h, m] = v.split(':').map(Number);
    return { h, m };
  }
  return { h: null, m: null };
}

function setField(h, m) {
  const el = document.getElementById(tpTarget);
  el.value = pad2(h) + ':' + pad2(m);
  syncPickerToField();
  updateDurationPreview();
}

function pickHour(h) {
  const p = pickerParts();
  setField(h, p.m === null ? 0 : p.m);
}

function pickMinute(m) {
  const p = pickerParts();
  setField(p.h === null ? new Date().getHours() : p.h, m);
}

function pickTime(v) {
  const [h, m] = v.split(':').map(Number);
  setField(h, m);
}

// точная подгонка, если смена началась не в круглые пять минут
function nudgeMinute(delta) {
  const p = pickerParts();
  if (p.h === null) { setField(new Date().getHours(), 0); return; }
  let total = (p.h * 60 + p.m + delta + 1440) % 1440;
  setField(Math.floor(total / 60), total % 60);
}

// подсветка выбранных часа и минуты + крупное значение сверху
function syncPickerToField() {
  if (!tpTarget) return;
  const p = pickerParts();
  const v = document.getElementById(tpTarget).value;
  document.getElementById('tpValue').textContent = isValidTime(v) ? v : '--:--';
  document.querySelectorAll('#tpHours .tp-cell').forEach(c =>
    c.classList.toggle('sel', p.h !== null && +c.dataset.h === p.h));
  document.querySelectorAll('#tpMins .tp-cell').forEach(c =>
    c.classList.toggle('sel', p.m !== null && +c.dataset.m === p.m));
}

/* ── редактирование: null = обычное добавление, иначе id смены, которую правим ── */
let editingId = null;

/* ── id смены, которую только что добавили (не отредактировали) — render()
   проигрывает для неё анимацию появления, а затем сбрасывает в null ── */
let justAddedId = null;

/* ── способ ввода времени: 'range' (промежуток) или 'minutes' (просто минуты) ── */
let durationMode = 'range';

// параметр назван next, чтобы не затенять глобальную mode (режим хранилища)
function setDurationMode(next) {
  durationMode = next;
  if (next !== 'range') closeTimePicker();
  document.getElementById('modeRangeBtn').classList.toggle('active', next === 'range');
  document.getElementById('modeMinutesBtn').classList.toggle('active', next === 'minutes');
  document.getElementById('rangeInputBlock').style.display = next === 'range' ? 'block' : 'none';
  document.getElementById('minutesInputBlock').style.display = next === 'minutes' ? 'block' : 'none';
  updateDurationPreview();
}

/* ── длительность из "начало–конец" ──
   Обе точки в формате "ЧЧ:ММ". Если конец раньше начала — считаем,
   что смена перевалила через полночь, и добавляем сутки.
   Возвращает null, если данных не хватает или начало == конец. */
/* поле времени теперь обычный текст, поэтому в нём может лежать
   недописанное значение вроде "22" или "2:3" — считаем только полное */
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const isValidTime = v => TIME_RE.test((v || '').trim());

function computeDuration(start, end) {
  if (!isValidTime(start) || !isValidTime(end)) return null;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  let mins = (eh * 60 + em) - (sh * 60 + sm);
  if (mins <= 0) mins += 1440;
  return mins;
}

/* ── текущая длительность в минутах, независимо от способа ввода ──
   Одна точка входа: и превью, и сохранение спрашивают минуты отсюда,
   чтобы логика не разъезжалась между двумя режимами. */
function currentDurationMinutes() {
  if (durationMode === 'minutes') {
    const mins = parseFloat(document.getElementById('durationMinutes').value);
    return (mins && mins > 0) ? Math.round(mins) : null;
  }
  return computeDuration(
    document.getElementById('startTime').value,
    document.getElementById('endTime').value
  );
}

function updateDurationPreview() {
  const preview = document.getElementById('durationPreview');
  if (document.getElementById('period').value === 'personal') {
    preview.value = 'не учитывается';
    return;
  }
  const mins = currentDurationMinutes();
  if (mins === null) { preview.value = '—'; return; }
  const h = Math.floor(mins / 60), m = mins % 60;
  preview.value = m ? `${h} ч ${m} мин` : `${h} ч`;
}
/* у полей времени в разметке уже стоит oninput="onTimeTyped(this)", а он сам
   зовёт updateDurationPreview — второй слушатель тут давал двойной пересчёт */
document.getElementById('durationMinutes').addEventListener('input', updateDurationPreview);

function addEntry() {
  const amount = parseFloat(document.getElementById('amount').value);
  const period = document.getElementById('period').value;
  const startTime = document.getElementById('startTime').value;
  const endTime = document.getElementById('endTime').value;

  let duration;
  if (period === 'personal') {
    // персоналка не привязана к часам — на неё время не тратится отдельно,
    // поэтому длительность всегда 0 и в часовую ставку она не идёт (см. calc())
    duration = 0;
  } else {
    duration = currentDurationMinutes();
    // правим старую смену, а время не тронули — не затираем её длительность
    if (duration === null && editingId) {
      const existing = state.shifts.find(s => s.id === editingId);
      if (existing && existing.period !== 'personal') duration = existing.duration;
    }
    if (!duration) {
      alert(durationMode === 'minutes'
        ? 'Укажи длительность смены в минутах'
        : 'Укажи начало и конец смены (не совпадающие)');
      return;
    }
  }

  if (!amount) {
    alert('Укажи сумму заработка');
    return;
  }
  saveSettingsSilent();

  const isPersonal = period === 'personal';
  // время начала/конца сохраняем только если его реально вводили промежутком —
  // в режиме "минуты" его просто нет, и в истории такая смена покажет только часы
  const keepRange = !isPersonal && durationMode === 'range';
  const data = {
    date: document.getElementById('date').value || localDateStr(),
    period,
    duration,
    start: keepRange ? (startTime || null) : null,
    end: keepRange ? (endTime || null) : null,
    amount,
    mileage: isPersonal ? null : (parseFloat(document.getElementById('mileage').value) || null),
    liters: isPersonal ? null : (parseFloat(document.getElementById('liters').value) || null),
    expenses: isPersonal ? 0 : (parseFloat(document.getElementById('expenses').value) || 0)
  };

  const wasEditing = !!editingId;
  if (editingId) {
    const idx = state.shifts.findIndex(s => s.id === editingId);
    if (idx !== -1) state.shifts[idx] = { ...state.shifts[idx], ...data };
    editingId = null;
  } else {
    justAddedId = Date.now();
    state.shifts.push({ id: justAddedId, ...data });
  }
  sortShifts();   // вносим вразброс, а список всё равно остаётся по датам

  /* После правки старой смены в поле оставалась её дата, и следующая новая
     смена молча уходила в тот же старый месяц. Возвращаем сегодняшнюю.
     При обычном добавлении дату не трогаем — удобно вносить несколько
     смен за одно и то же число подряд. */
  if (wasEditing) document.getElementById('date').value = localDateStr();

  persist();
  ['startTime','endTime','durationMinutes','amount','mileage','liters','expenses'].forEach(id => document.getElementById(id).value = '');
  updateDurationPreview();
  closeTimePicker();
  updateFormMode();
  render();
}

function startEdit(id) {
  const s = state.shifts.find(x => x.id === id);
  if (!s) return;
  document.getElementById('date').value = s.date;
  document.getElementById('period').value = s.period;
  document.getElementById('startTime').value = s.start || '';
  document.getElementById('endTime').value = s.end || '';
  // смена без сохранённого промежутка записана минутами — открываем её в том же режиме
  if (s.period !== 'personal') {
    setDurationMode((s.start && s.end) ? 'range' : 'minutes');
    document.getElementById('durationMinutes').value = (s.start && s.end) ? '' : (s.duration || '');
  }
  document.getElementById('amount').value = s.amount;
  document.getElementById('mileage').value = s.mileage ?? '';
  document.getElementById('liters').value = s.liters ?? '';
  document.getElementById('expenses').value = s.expenses ?? '';
  updatePeriodFieldsVisibility();
  updateDurationPreview();
  editingId = id;
  updateFormMode();
  document.getElementById('shiftForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function cancelEdit() {
  editingId = null;
  closeTimePicker();
  ['startTime','endTime','durationMinutes','amount','mileage','liters','expenses'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('date').value = localDateStr();
  document.getElementById('period').value = 'night';
  setDurationMode('range');
  updatePeriodFieldsVisibility();
  updateDurationPreview();
  updateFormMode();
}

/* ── показ/скрытие полей формы в зависимости от типа записи ──
   для персоналки не нужны ни время, ни пробег/бензин, ни доп. расходы —
   это просто сумма, привязанная к дате */
function updatePeriodFieldsVisibility() {
  const isPersonal = document.getElementById('period').value === 'personal';
  document.getElementById('timeFieldsBlock').style.display = isPersonal ? 'none' : 'block';
  document.getElementById('mileageFieldsBlock').style.display = isPersonal ? 'none' : 'block';
  document.getElementById('expensesFieldsBlock').style.display = isPersonal ? 'none' : 'block';
  document.getElementById('personalHint').style.display = isPersonal ? 'block' : 'none';
  if (isPersonal) closeTimePicker();
  updateDurationPreview();
}
document.getElementById('period').addEventListener('change', updatePeriodFieldsVisibility);

function updateFormMode() {
  const title = document.getElementById('shiftFormTitle');
  const btn = document.getElementById('submitBtn');
  const cancelBtn = document.getElementById('cancelEditBtn');
  if (editingId) {
    title.textContent = 'Редактирование смены';
    btn.textContent = 'Сохранить изменения';
    cancelBtn.style.display = 'block';
  } else {
    title.textContent = 'Новая смена';
    btn.textContent = 'Записать смену';
    cancelBtn.style.display = 'none';
  }
}

/* ══════════════════════════════════════════════════════
   ОФОРМЛЕНИЕ
   Тема хранится в настройках вместе с ценой бензина, так что
   выбор переживает перезагрузку. Вся разница между темами живёт
   в CSS (переменные + body[data-theme]), здесь только
   переключение атрибута и перерисовка шкалы «Приборки». */
const THEMES = ['dark', 'priborka', 'putevoi'];

function setTheme(name) {
  if (!THEMES.includes(name)) name = 'dark';
  state.settings.theme = name;
  applyTheme();
  persist();
}

function applyTheme() {
  const name = state.settings.theme || 'dark';
  // у тёмной темы атрибута нет — она базовая, её значения лежат в :root
  if (name === 'dark') document.body.removeAttribute('data-theme');
  else document.body.setAttribute('data-theme', name);
  THEMES.forEach(t => {
    const btn = document.getElementById('themeBtn-' + t);
    if (btn) btn.classList.toggle('active', t === name);
  });
  drawGauge(lastNetRate);
}

/* ── шкала для темы «Приборка» ──
   Рисуем дугу 0..GAUGE_MAX ₽/ч: серая подложка на весь полукруг,
   янтарная — до текущего значения, плюс риска на самом значении.
   Точку на дуге считаем через угол: 180° это ноль слева, 0° — максимум
   справа, поэтому доля пути превращается в угол как 180 - 180*доля. */
/* Предел шкалы не фиксированный: пока ставка ниже 1000 — шкала до 1000,
   как было. Если заработал больше, предел поднимается до следующих 500,
   иначе стрелка просто упиралась в максимум и разницы было не видно. */
const GAUGE_BASE_MAX = 1000;
const gaugeMaxFor = rate => Math.max(GAUGE_BASE_MAX, Math.ceil((rate || 0) / 500) * 500);
let lastNetRate = null;

function arcPoint(frac, r) {
  const deg = 180 - 180 * frac;
  const rad = deg * Math.PI / 180;
  return { x: 170 + r * Math.cos(rad), y: 170 - r * Math.sin(rad) };
}

function drawGauge(rate) {
  lastNetRate = rate;
  const box = document.getElementById('gaugeBox');
  if (!box) return;
  if ((state.settings.theme || 'dark') !== 'priborka') { box.innerHTML = ''; return; }

  const gaugeMax = gaugeMaxFor(rate);
  const frac = Math.max(0, Math.min(1, (rate || 0) / gaugeMax));
  const p = arcPoint(frac, 130);
  // шкала — ровно полукруг, поэтому дуга никогда не длиннее 180°:
  // large-arc-flag всегда 0, иначе SVG нарисует её «длинным путём»
  const fill = frac > 0.001
    ? `<path d="M 40 170 A 130 130 0 0 1 ${p.x.toFixed(1)} ${p.y.toFixed(1)}"
         fill="none" stroke="var(--amber)" stroke-width="13" stroke-linecap="round"/>` : '';
  const t1 = arcPoint(frac, 118), t2 = arcPoint(frac, 145);
  const mark = frac > 0.001
    ? `<line x1="${t1.x.toFixed(1)}" y1="${t1.y.toFixed(1)}" x2="${t2.x.toFixed(1)}" y2="${t2.y.toFixed(1)}"
         stroke="var(--amber)" stroke-width="4" stroke-linecap="round"/>` : '';

  // насечки шкалы через равные доли
  let ticks = '';
  for (let i = 0; i <= 6; i++) {
    const a = arcPoint(i / 6, 112), b = arcPoint(i / 6, 124);
    ticks += `<line x1="${a.x.toFixed(1)}" y1="${a.y.toFixed(1)}" x2="${b.x.toFixed(1)}" y2="${b.y.toFixed(1)}" stroke="var(--line)" stroke-width="2"/>`;
  }

  box.innerHTML = `
    <svg viewBox="0 0 340 202" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M 40 170 A 130 130 0 0 1 300 170" fill="none" stroke="var(--card-2)" stroke-width="13" stroke-linecap="round"/>
      ${fill}
      <g>${ticks}</g>
      ${mark}
      <g fill="var(--muted)" font-size="11" text-anchor="middle">
        <text x="40" y="192">0</text>
        <text x="170" y="26">${gaugeMax / 2}</text>
        <text x="300" y="192">${gaugeMax}</text>
      </g>
    </svg>`;
}

function saveSettingsSilent() {
  state.settings.fuelPrice = parseFloat(document.getElementById('fuelPrice').value) || null;
  state.settings.consumption = parseFloat(document.getElementById('consumption').value) || null;
}

/* Проигрывает исчезновение конкретной записи (класс entry-leaving —
   см. CSS: гаснет, съезжает в сторону и схлопывается по высоте), и
   только ПОСЛЕ того, как переход реально доиграл, вызывает onDone —
   там, где уже безопасно менять state и перерисовывать список.
   Если анимации отключены (prefers-reduced-motion) или узла почему-то
   нет в DOM — просто сразу вызываем onDone без анимации. Таймаут-
   подстраховка на случай, если transitionend по какой-то причине
   не долетит (например, вкладка на секунду ушла в фон). */
function removeEntryAnimated(id, onDone) {
  const el = document.querySelector(`.entry[data-id="${id}"]`);
  if (!el || prefersReducedMotion()) { onDone(); return; }
  let done = false;
  const finish = () => { if (done) return; done = true; onDone(); };
  el.classList.add('entry-leaving');
  el.addEventListener('transitionend', finish, { once: true });
  setTimeout(finish, 400);
}

/* Удаление необратимо, а ✕ стоит вплотную к ✎ — на планшете промахнуться
   легко. Поэтому спрашиваем подтверждение и показываем, что именно удаляем. */
async function delEntry(id) {
  const s = state.shifts.find(x => x.id === id);
  if (s) {
    const when = new Date(s.date + 'T00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
    const what = s.period === 'personal'
      ? `персоналку за ${when} на ${rub(s.amount)}`
      : `смену за ${when}${s.start && s.end ? ` (${s.start}–${s.end})` : ''} на ${rub(s.amount)}`;
    if (!confirm(`Удалить ${what}?\n\nОтменить это будет нельзя.`)) return;
  }
  removeEntryAnimated(id, async () => {
    state.shifts = state.shifts.filter(x => x.id !== id);
    if (editingId === id) { editingId = null; updateFormMode(); }
    await persist();
    render();
  });
}

const rub = n => Math.round(n).toLocaleString('ru-RU') + '₽';

/* Склонение по русским правилам: 1 смена, 2 смены, 5 смен, 21 смена, 22 смены.
   Прежняя формула смотрела только на само число и врала на 21, 22 и т.п. */
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* ── разделение по месяцам ──
   selectedMonth хранит либо 'all' (весь период), либо ключ 'YYYY-MM'.
   Ключ берём прямо из даты смены (первые 7 символов '2026-08-05' → '2026-08'),
   так что сортировка ключей строкой == сортировка по времени. */
const MONTH_NAMES = ['Янв','Фев','Мар','Апр','Май','Июн','Июл','Авг','Сен','Окт','Ноя','Дек'];
let selectedMonth = 'all';
let customRange = null; // { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' } — активно, когда selectedMonth === 'custom'

const monthKey = dateStr => dateStr.slice(0, 7);

function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

const shortRuDate = dateStr => new Date(dateStr + 'T00:00').toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
const formatRangeLabel = range => `${shortRuDate(range.from)}–${shortRuDate(range.to)}`;

// уникальные месяцы, за которые есть хоть одна смена, свежие — первые
function getMonthList() {
  const set = new Set(state.shifts.map(s => monthKey(s.date)));
  return [...set].sort().reverse();
}

let tabsSignature = null;   // чтобы не пересоздавать кнопки без надобности

function renderMonthTabs(months) {
  const box = document.getElementById('monthTabs');
  if (!months.length) { box.innerHTML = ''; tabsSignature = null; return; }

  const rangeLabel = (selectedMonth === 'custom' && customRange) ? formatRangeLabel(customRange) : '📅 Период';
  const sig = months.join(',') + '|' + rangeLabel;

  /* Кнопки пересоздаём, только если изменился сам набор вкладок.
     Раньше DOM перестраивался на каждой перерисовке — и если render()
     случался прямо во время клика (например, поле цели теряло фокус и
     сохранялось), кнопку подменяли под курсором и клик пропадал. */
  if (sig !== tabsSignature) {
    const monthButtons = ['all', ...months].map(key => {
      const label = key === 'all' ? 'Все' : monthLabel(key);
      return `<button class="month-tab" data-key="${key}" onclick="selectMonth('${key}')">${label}</button>`;
    }).join('');
    box.innerHTML = monthButtons +
      `<button class="month-tab" data-key="custom" onclick="toggleRangePanel()">${rangeLabel}</button>`;
    tabsSignature = sig;
  }

  // подсветка активной вкладки — всегда, она дешёвая и DOM не трогает
  box.querySelectorAll('.month-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.key === selectedMonth);
  });
}

function selectMonth(key) {
  selectedMonth = key;
  document.getElementById('rangePanel').style.display = 'none';
  render();
}

/* ── произвольный период: пользователь сам вводит "с" и "по" ── */
function toggleRangePanel() {
  const panel = document.getElementById('rangePanel');
  // смотрим на вычисленный стиль, а не на inline — не зависим от того,
  // задан ли display атрибутом в разметке
  const opening = getComputedStyle(panel).display === 'none';
  panel.style.display = opening ? 'block' : 'none';
  if (opening && !document.getElementById('rangeFrom').value && state.shifts.length) {
    // подставляем разумные дефолты, чтобы не открывать пустые поля
    const dates = state.shifts.map(s => s.date).sort();
    document.getElementById('rangeFrom').value = dates[0];
    document.getElementById('rangeTo').value = dates[dates.length - 1];
  }
}

function applyCustomRange() {
  const from = document.getElementById('rangeFrom').value;
  const to = document.getElementById('rangeTo').value;
  if (!from || !to) { alert('Укажи обе даты периода'); return; }
  if (from > to) { alert('Дата начала позже даты конца — поменяй местами'); return; }
  customRange = { from, to };
  selectedMonth = 'custom';
  document.getElementById('rangePanel').style.display = 'none';
  render();
}

// ключ предыдущего календарного месяца относительно данного 'YYYY-MM'
function prevMonthKey(key) {
  let [y, m] = key.split('-').map(Number);
  m -= 1;
  if (m === 0) { m = 12; y -= 1; }
  return `${y}-${String(m).padStart(2, '0')}`;
}

/* ── цель на месяц + сравнение с прошлым месяцем ──
   Обе штуки — про календарный месяц, поэтому имеют смысл только
   когда выбран конкретный месяц, а не «Все» и не произвольный период. */
function updateMonthExtras(totNet) {
  const goalRow = document.getElementById('goalRow');
  const compareEl = document.getElementById('monthCompare');

  if (selectedMonth === 'all' || selectedMonth === 'custom' || totNet === null) {
    goalRow.style.display = 'none';
    compareEl.style.display = 'none';
    return;
  }

  const goal = currentGoal();
  if (goal && goal > 0) {
    // процент в подписи — настоящий (может быть и 220%), ограничиваем
    // только ширину полоски, иначе перевыполнение выглядело как ровно 100%
    const pct = Math.round(totNet / goal * 100);
    const fill = document.getElementById('goalFill');
    fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    fill.classList.toggle('over', totNet >= goal);
    document.getElementById('goalLabel').textContent = `${rub(totNet)} из ${rub(goal)} · ${pct}%`;
    goalRow.style.display = 'block';
  } else {
    goalRow.style.display = 'none';
  }

  const prevKey = prevMonthKey(selectedMonth);
  const prevShifts = state.shifts.filter(s => monthKey(s.date) === prevKey);
  const prevNet = prevShifts.reduce((a, s) => a + calc(s).net, 0);
  if (prevShifts.length && prevNet > 0) {
    const diff = ((totNet - prevNet) / prevNet) * 100;
    const arrow = diff >= 0 ? '▲' : '▼';
    compareEl.textContent = `${arrow} ${diff >= 0 ? '+' : ''}${Math.round(diff)}% к ${monthLabel(prevKey)}`;
    compareEl.style.color = diff >= 0 ? 'var(--green)' : 'var(--red)';
    compareEl.style.display = 'block';
  } else {
    compareEl.style.display = 'none';
  }
}

/* ── пробег и литры бензина за текущую выборку ──
   Остальная приборка (чистыми/расходы/часов) уже пересчитывается
   через обычную фильтрацию filtered — здесь только то, чего там
   ещё нет: суммарный пробег и литры. Показываем всегда, когда есть
   данные — независимо от того, «Все» это, месяц или свой период. */
function updateRangeExtra(shiftsArr, calcs) {
  const el = document.getElementById('rangeExtra');
  if (!shiftsArr || !shiftsArr.length) {
    el.style.display = 'none';
    return;
  }
  const totKm = shiftsArr.reduce((a, s) => a + (s.mileage || 0), 0);
  const totLiters = calcs.reduce((a, c) => a + (c.liters || 0), 0);
  let html = `Пробег: <b>${totKm ? totKm.toFixed(0) : 0} км</b> · Бензина потрачено: <b>${totLiters.toFixed(1)} л</b>`;

  // реальный расход — только по сменам, где литры вписаны вручную (не estimated),
  // то есть по факту, а не по расчёту из настройки. Так можно свериться,
  // не занижена ли/завышена ли цифра расхода в настройках
  let realKm = 0, realLiters = 0;
  shiftsArr.forEach((s, i) => {
    const c = calcs[i];
    if (!c.estimated && c.liters > 0 && s.mileage > 0) { realKm += s.mileage; realLiters += c.liters; }
  });
  if (realKm > 0) {
    const real100 = realLiters / realKm * 100;
    const setting = state.settings.consumption;
    const vs = setting ? ` <span style="opacity:.75">(в настройках ${setting})</span>` : '';
    html += `<br>Факт расход по вводу: <b>${real100.toFixed(1)} л/100км</b>${vs}`;
  }

  el.innerHTML = html;
  el.style.display = 'block';
}

/* ── разбивка по дням недели: средняя ставка чистыми по Пн..Вс
   на текущей выборке (весь период или выбранный месяц) ── */
const WEEKDAY_NAMES = ['Пн','Вт','Ср','Чт','Пт','Сб','Вс'];

function weekdayIndex(dateStr) {
  const d = new Date(dateStr + 'T00:00').getDay(); // 0=Вс..6=Сб
  return (d + 6) % 7;                              // → 0=Пн..6=Вс
}

function drawWeekdayChart(shiftsArr) {
  const buckets = Array.from({ length: 7 }, () => ({ net: 0, hours: 0 }));
  shiftsArr.forEach(s => {
    const c = calc(s);
    const idx = weekdayIndex(s.date);
    buckets[idx].net += c.net;
    buckets[idx].hours += c.hours;
  });
  const bars = buckets.map((b, i) => ({
    value: b.hours > 0 ? b.net / b.hours : 0,
    label: WEEKDAY_NAMES[i],
    period: 'week',
    display: b.hours > 0 ? Math.round(b.net / b.hours) : '—'
  }));
  drawChart('chartWeekday', bars);
}

/* ── накопительный график: сколько чистыми набежало к каждой дате ──
   В отличие от остальных графиков, тут персоналку НЕ исключаем —
   это про общие деньги на руках, а не про часовую ставку, так что
   бонусы тут вполне уместны (та же логика, что и в totNet). */
function drawCumulativeChart(containerId, shiftsArr) {
  const box = document.getElementById(containerId);
  lastCumulativeShifts = shiftsArr;   // чтобы перерисовать при смене размера окна

  const byDate = new Map();
  shiftsArr.forEach(s => {
    const c = calc(s);
    byDate.set(s.date, (byDate.get(s.date) || 0) + c.net);
  });
  let dates = [...byDate.keys()].sort();
  if (!dates.length) { box.innerHTML = '<div class="chart-empty">Нет данных</div>'; cumHoverData = null; return; }

  let running = 0;
  let dailyVals = dates.map(d => byDate.get(d));   // сумма именно за этот день — нужна для подсказки
  let points = dailyVals.map(v => { running += v; return running; });

  /* Одна дата — линию рисовать не из чего, и график выходил пустым:
     точка в левом углу и обрезанная подпись. Дублируем точку, чтобы
     получилась ровная линия на всю ширину: «за этот день столько». */
  const singleDay = points.length === 1;
  if (singleDay) {
    points = [points[0], points[0]];
    dates = [dates[0], dates[0]];
    dailyVals = [dailyVals[0], dailyVals[0]];
  }

  const goal = currentGoal();   // null, если «Все»/свой период или цель не задана

  /* Масштаб считаем по реальному размаху значений, включая минус.
     Раньше максимум брался как Math.max(...points, goal, 1) — и если
     все суммы были отрицательными (смена в убыток), максимум становился
     единицей, координаты взлетали до сотен тысяч, а заливка вылезала
     из блока и закрашивала все графики ниже. */
  const hi = Math.max(...points, goal || 0, 0);
  const lo = Math.min(...points, 0);
  const span = (hi - lo) || 1;

  const H = 150, plotH = 104, topPad = 18;
  const W = Math.max(box.clientWidth || box.getBoundingClientRect().width || 300, 260);
  const leftPad = 6, rightPad = 6;
  const usableW = W - leftPad - rightPad;
  const stepX = points.length > 1 ? usableW / (points.length - 1) : 0;
  const xAt = i => leftPad + stepX * i;
  const yAt = v => topPad + plotH - ((v - lo) / span) * plotH;
  const zeroY = yAt(0);

  let path = '';
  points.forEach((v, i) => { path += (i === 0 ? 'M' : 'L') + xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1) + ' '; });
  path = path.trim();
  // заливку замыкаем по нулевой линии, а не по низу холста — тогда
  // убыточный участок честно оказывается ниже нуля
  const areaPath = `${path} L${xAt(points.length - 1).toFixed(1)},${zeroY.toFixed(1)} L${xAt(0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  // нулевая линия нужна только когда есть уход в минус
  const zeroSvg = lo < 0
    ? `<line x1="${leftPad}" y1="${zeroY.toFixed(1)}" x2="${(W - rightPad).toFixed(1)}" y2="${zeroY.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`
    : '';

  let goalSvg = '';
  if (goal) {
    const gy = yAt(goal);
    goalSvg = `
      <line class="cum-goal-line" x1="${leftPad}" y1="${gy.toFixed(1)}" x2="${(W - rightPad).toFixed(1)}" y2="${gy.toFixed(1)}"/>
      <text class="cum-goal-label" x="${(W - rightPad).toFixed(1)}" y="${(gy - 5).toFixed(1)}">цель ${rub(goal)}</text>`;
  }

  // подписи под точками — не под каждой (тесно), а через равный шаг плюс всегда последняя
  const shortDate = d => new Date(d + 'T00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'numeric' });
  let labels = '';
  if (singleDay) {
    labels = `<text class="bar-x" x="${(W / 2).toFixed(1)}" y="${H - 4}">${shortDate(dates[0])}</text>`;
  } else {
    const step = Math.ceil(points.length / 6) || 1;
    dates.forEach((d, i) => {
      if (i % step === 0 || i === dates.length - 1) {
        labels += `<text class="bar-x" x="${xAt(i).toFixed(1)}" y="${H - 4}">${shortDate(d)}</text>`;
      }
    });
  }

  const lastI = points.length - 1;
  const lastVal = points[lastI];
  const lastY = yAt(lastVal);

  // если цифра итога оказалась рядом с линией цели — подпись переезжает
  // вниз от точки, а не вверх, чтобы они не наезжали друг на друга
  const goalY = goal ? yAt(goal) : null;
  let valueLabelY = (goalY !== null && Math.abs(lastY - goalY) < 16) ? lastY + 16 : lastY - 9;
  valueLabelY = Math.max(11, Math.min(H - 14, valueLabelY));   // не вылезаем за холст

  // данные для подсказки при наведении/тапе — читает handleCumPointer()
  cumHoverData = {
    xs: points.map((_, i) => xAt(i)),
    ys: points.map(yAt),
    dates, dailyVals, points,
    W, H, topPad, plotH
  };

  box.innerHTML = `
    <svg viewBox="0 0 ${W.toFixed(0)} ${H}" width="${W.toFixed(0)}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${goalSvg}
      ${zeroSvg}
      <path class="cum-area" d="${areaPath}"/>
      <path class="cum-line" d="${path}"/>
      <circle class="cum-dot" cx="${xAt(lastI).toFixed(1)}" cy="${lastY.toFixed(1)}" r="4"/>
      <text class="bar-val" style="text-anchor:end" x="${(W - rightPad).toFixed(1)}" y="${valueLabelY.toFixed(1)}">${rub(lastVal)}</text>
      ${labels}
      <rect class="cum-hover-area" x="0" y="0" width="${W.toFixed(0)}" height="${H}"
            onmousemove="handleCumPointer(event)" onmouseleave="hideCumHover()"
            ontouchstart="handleCumPointer(event)" ontouchmove="handleCumPointer(event)"/>
      <line id="cumHoverLine" class="cum-hover-line" style="display:none"/>
      <circle id="cumHoverDot" class="cum-hover-dot" r="5" style="display:none"/>
      <g id="cumTooltip" class="cum-tooltip" style="display:none">
        <rect id="cumTtBg" class="cum-tt-bg" rx="7" ry="7"/>
        <text id="cumTtDate" class="cum-tt-date"></text>
        <text id="cumTtDay" class="cum-tt-day"></text>
        <text id="cumTtTotal" class="cum-tt-total"></text>
      </g>
    </svg>`;
}

/* ── подсказка при наведении/тапе на накопительный график ──
   Показывает не только итог нарастающим, но и сколько заработано именно
   в этот день — на самой линии видно только общую сумму, а конкретный
   день без подсказки не узнать. */
let cumHoverData = null;

function handleCumPointer(evt) {
  if (!cumHoverData) return;
  const svg = evt.currentTarget.ownerSVGElement;
  if (!svg) return;
  const touch = evt.touches && evt.touches[0];
  const clientX = touch ? touch.clientX : evt.clientX;
  if (clientX === undefined) return;
  if (evt.cancelable) evt.preventDefault();   // чтобы палец не скроллил страницу поверх графика

  const rect = svg.getBoundingClientRect();
  if (!rect.width) return;
  // переводим экранные координаты в единицы viewBox (обычно 1:1, но
  // мало ли CSS всё-таки что-то смасштабировало)
  const x = (clientX - rect.left) * (cumHoverData.W / rect.width);

  let idx = 0, best = Infinity;
  cumHoverData.xs.forEach((px, i) => {
    const d = Math.abs(px - x);
    if (d < best) { best = d; idx = i; }
  });
  showCumHover(idx);
}

function showCumHover(idx) {
  const d = cumHoverData;
  if (!d || idx < 0 || idx >= d.points.length) return;
  const x = d.xs[idx], y = d.ys[idx];

  const line = document.getElementById('cumHoverLine');
  line.setAttribute('x1', x); line.setAttribute('x2', x);
  line.setAttribute('y1', d.topPad); line.setAttribute('y2', d.topPad + d.plotH);
  line.style.display = 'block';

  const dot = document.getElementById('cumHoverDot');
  dot.setAttribute('cx', x); dot.setAttribute('cy', y);
  dot.style.display = 'block';

  const dateLabel = new Date(d.dates[idx] + 'T00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const dayVal = d.dailyVals[idx];
  const dayText = (dayVal >= 0 ? '+' : '') + rub(dayVal);
  const totalText = 'Итого на эту дату: ' + rub(d.points[idx]);

  const dateEl = document.getElementById('cumTtDate');
  const dayEl = document.getElementById('cumTtDay');
  const totalEl = document.getElementById('cumTtTotal');
  dateEl.textContent = dateLabel;
  dayEl.textContent = dayText + ' в этот день';
  dayEl.style.fill = dayVal < 0 ? 'var(--red)' : 'var(--green)';
  totalEl.textContent = totalText;

  // ширина плашки — по самой длинной строке, но не шире холста
  const maxLen = Math.max(dateLabel.length, (dayText + ' в этот день').length, totalText.length);
  const boxW = Math.min(d.W - 8, Math.max(122, maxLen * 6.3 + 18));
  const boxH = 52;

  let boxX = Math.max(4, Math.min(d.W - boxW - 4, x - boxW / 2));
  // плашка сверху от точки, а если места нет — снизу
  let boxY = y - boxH - 12;
  if (boxY < 2) boxY = Math.min(d.H - boxH - 2, y + 12);

  document.getElementById('cumTtBg').setAttribute('x', boxX);
  document.getElementById('cumTtBg').setAttribute('y', boxY);
  document.getElementById('cumTtBg').setAttribute('width', boxW);
  document.getElementById('cumTtBg').setAttribute('height', boxH);

  const cx = boxX + boxW / 2;
  dateEl.setAttribute('x', cx); dateEl.setAttribute('y', boxY + 16);
  dayEl.setAttribute('x', cx); dayEl.setAttribute('y', boxY + 31);
  totalEl.setAttribute('x', cx); totalEl.setAttribute('y', boxY + 44);

  document.getElementById('cumTooltip').style.display = 'block';
}

function hideCumHover() {
  const line = document.getElementById('cumHoverLine');
  const dot = document.getElementById('cumHoverDot');
  const tt = document.getElementById('cumTooltip');
  if (line) line.style.display = 'none';
  if (dot) dot.style.display = 'none';
  if (tt) tt.style.display = 'none';
}

/* На тач-устройствах (планшет) отдельного "увести курсор" не бывает —
   палец либо на графике, либо нет, и на обычном тапе touchstart/touchend
   срабатывают почти одновременно. Если прятать подсказку по touchend,
   она бы просто мигала. Поэтому она держится, пока не тронешь что-то
   ещё — прячем её здесь, по тапу вне самого графика. */
document.addEventListener('touchstart', e => {
  const chart = document.getElementById('chartCumulative');
  if (chart && !chart.contains(e.target)) hideCumHover();
}, { passive: true });

/* ── перерисовка при смене размера окна ──
   Масштаб этого графика зашит по ширине контейнера в момент отрисовки
   (у него viewBox в пикселях, в отличие от столбиковых). При повороте
   планшета viewBox оставался старым, и весь текст съезжал по размеру.
   Ловим resize и перерисовываем — с задержкой, чтобы не молотить
   на каждый пиксель во время поворота. */
let lastCumulativeShifts = null;
let cumResizeTimer = null;
let lastCumWidth = null;

window.addEventListener('resize', () => {
  if (!lastCumulativeShifts) return;
  clearTimeout(cumResizeTimer);
  cumResizeTimer = setTimeout(() => {
    const box = document.getElementById('chartCumulative');
    if (!box) return;
    const w = box.clientWidth;
    if (w && w !== lastCumWidth) {
      lastCumWidth = w;
      drawCumulativeChart('chartCumulative', lastCumulativeShifts);
    }
  }, 150);
});

/* ── группировка смен по дате для графиков ──
   Если за день несколько смен (например, два выхода днём), суммируем
   их часы/деньги в одну "дневную" запись — на графике будет один
   столбик за дату, а не несколько соседних. Порядок дат сохраняем
   таким же, каким шли смены на входе (ожидается хронологический). */
function aggregateByDate(shiftsArr) {
  const map = new Map();
  const order = [];
  shiftsArr.forEach(s => {
    if (!map.has(s.date)) {
      map.set(s.date, { date: s.date, fuelCost: 0, expenses: 0, net: 0, hours: 0, periods: new Set() });
      order.push(s.date);
    }
    const c = calc(s);
    const agg = map.get(s.date);
    agg.fuelCost += c.fuelCost;
    agg.expenses += c.expenses;
    agg.net += c.net;
    agg.hours += c.hours;
    agg.periods.add(s.period);
  });
  return order.map(date => {
    const agg = map.get(date);
    const period = agg.periods.size === 1 ? [...agg.periods][0] : 'mixed';
    return {
      date,
      hours: agg.hours,
      fuelCost: agg.fuelCost,
      expenses: agg.expenses,
      net: agg.net,
      netRate: agg.hours ? agg.net / agg.hours : 0,
      period
    };
  });
}

function drawChart(containerId, bars) {
  const box = document.getElementById(containerId);

  if (!bars.length) {
    box.innerHTML = '<div class="chart-empty">Нет данных</div>';
    return;
  }

  // геометрия "холста" в его собственных координатах (viewBox),
  // а по ширине SVG растянется на весь контейнер через CSS
  const H = 150;                 // общая высота
  const plotH = 110;             // высота зоны столбиков (сверху место для цифры, снизу для даты)
  const topPad = 22;             // отступ сверху под подпись значения
  const gap = 10;                // расстояние между столбиками
  // Раньше ширина холста считалась только по формуле n*46, без оглядки на
  // реальный размер контейнера — из-за этого при разном n (7 у "по дням
  // недели", до 14 у "ставки чистыми") получались РАЗНЫЕ пропорции
  // холста, и при растягивании на одинаковую ширину колонки высота
  // выходила разной: один график казался приземистым, другой — квадратным.
  // drawCumulativeChart ниже всегда меряет box.clientWidth — берём тот же
  // приём: если места в контейнере достаточно, просто заполняем его
  // целиком (высота остаётся ровно H у всех графиков одинаково), и только
  // если баров реально много и по 46 на каждый не помещается — холст
  // становится шире контейнера, и контейнер уходит в горизонтальный скролл
  // (overflow-x в .chart), а не сжимает бары до нечитаемых.
  const n = bars.length;
  const idealW = n * 46;
  const containerW = box.clientWidth || idealW;
  const W = Math.max(containerW, idealW, 300);
  const barW = (W - gap * (n - 1)) / n;

  /* Масштаб по размаху значений с нулём внутри.
     Раньше было maxVal = Math.max(...values, 1), и у отрицательного
     значения (смена в убыток) высота столбика выходила отрицательной —
     он рисовался за пределами холста и день просто исчезал с графика.
     Теперь ноль — это отдельная линия, минус растёт вниз от неё. */
  const values = bars.map(b => b.value);
  const hi = Math.max(...values, 0);
  const lo = Math.min(...values, 0);
  const span = (hi - lo) || 1;
  const yOf = v => topPad + plotH - ((v - lo) / span) * plotH;
  const zeroY = yOf(0);

  let rects = '';
  bars.forEach((b, i) => {
    const x = i * (barW + gap);
    const cx = x + barW / 2;
    const vy = yOf(b.value);
    const negative = b.value < 0;
    // столбик всегда между нулевой линией и значением
    const top = Math.min(vy, zeroY);
    const h = Math.max(Math.abs(vy - zeroY), 1);
    /* Подпись всегда над верхним краем столбика. Для убыточного это место
       прямо над нулевой линией — там пусто, столбика нет. Если ставить её
       под столбик, она налезает на подпись даты внизу холста. */
    const labelY = top - 5;
    rects += `
      <rect class="bar-${b.period}${negative ? ' bar-neg' : ''}" x="${x.toFixed(1)}" y="${top.toFixed(1)}"
            width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3"/>
      <text class="bar-val" x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}">${b.display}</text>
      <text class="bar-x"   x="${cx.toFixed(1)}" y="${(H - 4)}">${b.label}</text>
    `;
  });

  // нулевую линию показываем только когда есть уход в минус
  const zeroSvg = lo < 0
    ? `<line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`
    : '';

  box.innerHTML =
    `<svg viewBox="0 0 ${W.toFixed(0)} ${H}" width="${W.toFixed(0)}" height="${H}"
          xmlns="http://www.w3.org/2000/svg">${zeroSvg}${rects}</svg>`;
}

/* ── сравнение месяц-к-месяцу — по образцу графика в приложении Яндекс.Про
   ("эта неделя vs прошлая"), только с шагом в месяц вместо недели: ось X —
   число месяца (1, 2, 3...), одна линия — текущий календарный месяц,
   вторая — предыдущий. Так сразу видно, обгоняешь ли ты себя же
   месяц назад на ту же дату, а не просто сумму за прошлый период.

   Специально не завязана на выбранную вкладку месяца/периода — это
   сравнение всегда про "прямо сейчас vs месяц назад", а не про то, что
   выбрано на вкладках сверху. Поэтому и берёт state.shifts напрямую,
   а не filtered. */
function drawMonthCompareChart(containerId) {
  const box = document.getElementById(containerId);
  const legendBox = document.getElementById('monthCompareLegend');

  const today = new Date();
  const curYear = today.getFullYear(), curMonthIdx = today.getMonth();
  const todayDay = today.getDate();

  const prevRef = new Date(curYear, curMonthIdx - 1, 1);
  const prevYear = prevRef.getFullYear(), prevMonthIdx = prevRef.getMonth();
  const daysInPrevMonth = new Date(prevYear, prevMonthIdx + 1, 0).getDate();

  // суммируем net по датам из ВСЕХ смен — см. комментарий выше про то,
  // почему не filtered
  const byDate = new Map();
  state.shifts.forEach(s => {
    const c = calc(s);
    byDate.set(s.date, (byDate.get(s.date) || 0) + c.net);
  });

  const prefix = (y, m) => `${y}-${pad2(m + 1)}-`;
  const curPrefix = prefix(curYear, curMonthIdx), prevPrefix = prefix(prevYear, prevMonthIdx);
  const hasPrevData = [...byDate.keys()].some(d => d.startsWith(prevPrefix));

  const curDaily = Array.from({ length: todayDay }, (_, i) => byDate.get(curPrefix + pad2(i + 1)) || 0);
  const prevDaily = Array.from({ length: daysInPrevMonth }, (_, i) => byDate.get(prevPrefix + pad2(i + 1)) || 0);

  const curTotal = curDaily.reduce((a, b) => a + b, 0);
  const prevTotal = prevDaily.reduce((a, b) => a + b, 0);
  const curName = today.toLocaleDateString('ru-RU', { month: 'long' });
  const prevName = prevRef.toLocaleDateString('ru-RU', { month: 'long' });

  legendBox.innerHTML = `
    <span class="mc-legend-item"><i class="dot mc-dot-cur"></i>${curName} · ${rub(curTotal)}</span>
    <span class="mc-legend-item"><i class="dot mc-dot-prev"></i>${prevName} · ${hasPrevData ? rub(prevTotal) : 'нет данных'}</span>
  `;

  // ось X растягиваем на больший из двух диапазонов — обычно это длина
  // прошлого месяца (30/31 день), но если сегодня, скажем, 31 число,
  // а прошлый месяц был короче — не обрезаем текущую линию
  const numDays = Math.max(daysInPrevMonth, todayDay, 2);

  const H = 150, plotH = 110, topPad = 18, leftPad = 34, rightPad = 6;
  const W = Math.max(box.clientWidth || 300, 300);
  const usableW = W - leftPad - rightPad;
  const stepX = numDays > 1 ? usableW / (numDays - 1) : 0;
  const xAt = i => leftPad + stepX * i;

  const hi = Math.max(...curDaily, ...prevDaily, 0);
  const lo = Math.min(...curDaily, ...prevDaily, 0);
  const span = (hi - lo) || 1;
  const yAt = v => topPad + plotH - ((v - lo) / span) * plotH;

  /* «Красивые» деления оси Y (500, 1000, 1500...), а не голое span/4 —
     иначе шаг получался бы вида 733.4, что бесполезно для прикидки на
     глаз. Раунд до 1/2/5×10^n — стандартный приём для осей графиков. */
  const niceStep = raw => {
    const exp = Math.floor(Math.log10(raw));
    const base = Math.pow(10, exp);
    const frac = raw / base;
    return (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * base;
  };
  const yStep = niceStep(span / 4) || 1;
  const yTicks = [];
  for (let t = Math.ceil(lo / yStep) * yStep; t <= hi + 1e-6; t += yStep) yTicks.push(Math.round(t));

  let gridSvg = '';
  yTicks.forEach(t => {
    const y = yAt(t).toFixed(1);
    gridSvg += `
      <line class="mc-grid-line" x1="${leftPad}" y1="${y}" x2="${(W - rightPad).toFixed(1)}" y2="${y}"/>
      <text class="mc-grid-label" x="${leftPad - 6}" y="${(yAt(t) + 3).toFixed(1)}">${t}</text>`;
  });

  const pathOf = arr => arr.map((v, i) => (i === 0 ? 'M' : 'L') + xAt(i).toFixed(1) + ',' + yAt(v).toFixed(1)).join(' ');
  const curPath = pathOf(curDaily);
  const prevPath = hasPrevData ? pathOf(prevDaily) : '';

  // подписи по оси X — числа месяца через равный шаг, чтобы не налезали друг на друга
  const xLabelStep = Math.ceil(numDays / 7) || 1;
  let xLabels = '';
  for (let i = 0; i < numDays; i += xLabelStep) {
    xLabels += `<text class="bar-x" x="${xAt(i).toFixed(1)}" y="${H - 4}">${i + 1}</text>`;
  }
  const lastDayNum = numDays;
  if ((lastDayNum - 1) % xLabelStep !== 0) {
    xLabels += `<text class="bar-x" x="${xAt(lastDayNum - 1).toFixed(1)}" y="${H - 4}">${lastDayNum}</text>`;
  }

  const curLastI = curDaily.length - 1;
  const curLastY = yAt(curDaily[curLastI]);
  const curLastX = xAt(curLastI);
  // подпись — прямо над точкой "сегодня", а не у правого края холста:
  // "сегодня" почти никогда не совпадает с последним днём месяца, в
  // отличие от cumulative-графика, где последняя точка всегда с краю
  const curDot = curLastI >= 0
    ? `<circle class="mc-dot-cur" cx="${curLastX.toFixed(1)}" cy="${curLastY.toFixed(1)}" r="4"/>
       <text class="bar-val" x="${curLastX.toFixed(1)}" y="${Math.max(11, curLastY - 10).toFixed(1)}">${rub(curDaily[curLastI])}</text>`
    : '';

  box.innerHTML = `
    <svg viewBox="0 0 ${W.toFixed(0)} ${H}" width="${W.toFixed(0)}" height="${H}" xmlns="http://www.w3.org/2000/svg">
      ${gridSvg}
      ${prevPath ? `<path class="mc-line-prev" d="${prevPath}"/>` : ''}
      <path class="mc-line-cur" d="${curPath}"/>
      ${curDot}
      ${xLabels}
    </svg>`;
}


function render() {
  const list = document.getElementById('entries');
  // "забираем" флаг сразу, чтобы он не пережил этот render() ни при каком
  // раскладе (в т.ч. если ранний return ниже прервёт обычный путь)
  const idToAnimate = justAddedId;
  justAddedId = null;

  // список месяцев считаем от ВСЕХ смен, чтобы вкладки не пропадали
  const months = getMonthList();
  // если удалили последнюю смену выбранного месяца — откатываемся на "Все"
  // ('custom' сюда не относится — это не месяц из списка, а свой диапазон дат)
  if (selectedMonth !== 'all' && selectedMonth !== 'custom' && !months.includes(selectedMonth)) selectedMonth = 'all';
  renderMonthTabs(months);
  syncGoalField();   // поле цели всегда соответствует выбранному месяцу

  // не зависит от выбранной вкладки — поэтому считается и рисуется здесь,
  // раньше любых ранних return ниже (иначе на пустой вкладке график тоже
  // пустел бы, хотя реальные смены за этот и прошлый месяц могут быть)
  drawMonthCompareChart('chartMonthCompare');

  if (!state.shifts.length) {
    list.innerHTML = '<div class="empty">Пока пусто — запиши первую смену выше</div>';
    setDash(null);
    updateMonthExtras(null);
    updateRangeExtra(null);
    ['chartRate','chartWeekday','chartCumulative'].forEach(id =>
      document.getElementById(id).innerHTML = '<div class="chart-empty">Появятся после первой смены</div>');
    document.getElementById('chartWindowNote').textContent = '';
    return;
  }

  // ── фильтр по выбранному месяцу или своему периоду: дальше везде используем filtered ──
  const filtered = selectedMonth === 'all'
    ? state.shifts
    : selectedMonth === 'custom'
      ? state.shifts.filter(s => s.date >= customRange.from && s.date <= customRange.to)
      : state.shifts.filter(s => monthKey(s.date) === selectedMonth);

  if (!filtered.length) {
    const periodLabel = selectedMonth === 'custom' ? formatRangeLabel(customRange) : monthLabel(selectedMonth);
    list.innerHTML = `<div class="empty">Нет смен за «${periodLabel}»</div>`;
    setDash(null);
    updateMonthExtras(null);
    updateRangeExtra(null);
    ['chartRate','chartWeekday','chartCumulative'].forEach(id =>
      document.getElementById(id).innerHTML = '<div class="chart-empty">Нет данных за этот период</div>');
    document.getElementById('chartWindowNote').textContent = '';
    return;
  }

  list.innerHTML = filtered.map(s => {
    const c = calc(s);
    const dateStr = new Date(s.date + 'T00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

    if (s.period === 'personal') {
      return `
      <div class="entry" data-id="${s.id}">
        <div class="top">
          <span class="date">${dateStr}
            <span class="badge personal">персоналка</span>
          </span>
          <span class="actions">
            <button class="edit" onclick="startEdit(${s.id})" aria-label="Редактировать">✎</button>
            <button class="del" onclick="delEntry(${s.id})" aria-label="Удалить">✕</button>
          </span>
        </div>
        <div class="math">
          <span class="net">${rub(s.amount)} · в общую сумму, не в ставку</span>
        </div>
      </div>`;
    }

    const timeStr = (s.start && s.end) ? `${s.start}–${s.end} · ` : '';
    return `
      <div class="entry" data-id="${s.id}">
        <div class="top">
          <span class="date">${dateStr} · ${timeStr}${(c.hours).toFixed(1)} ч
            <span class="badge ${s.period}">${s.period === 'day' ? 'день' : 'ночь'}</span>
          </span>
          <span class="actions">
            <button class="edit" onclick="startEdit(${s.id})" aria-label="Редактировать">✎</button>
            <button class="del" onclick="delEntry(${s.id})" aria-label="Удалить">✕</button>
          </span>
        </div>
        <div class="math">
          <span class="gross">${rub(s.amount)}</span>
          <span class="fuel">− ${rub(c.fuelCost)} бенз</span>
          ${c.expenses ? `<span class="fuel">− ${rub(c.expenses)} доп</span>` : ''}
          <span class="net">= ${rub(c.net)} · ${Math.round(c.netRate)}₽/ч</span>
        </div>
        <div class="sub">
          ${s.mileage ? s.mileage + ' км · ' : ''}${c.liters ? c.liters.toFixed(1) + ' л' + (c.estimated ? ' (по расходу)' : '') : 'без учёта топлива'}
        </div>
      </div>`;
  }).join('');

  // ── если этот render() случился сразу после добавления новой смены —
  //    проигрываем её появление: ставим стартовое ("вошедшее") состояние,
  //    затем на следующем кадре снимаем класс — именно смена класса между
  //    кадрами и запускает CSS-переход к обычному виду. Если сделать это
  //    в одном и том же кадре без паузы, браузер просто не заметит, что
  //    состояние вообще менялось, и анимация не проиграется.
  if (idToAnimate !== null && !prefersReducedMotion()) {
    const el = list.querySelector(`.entry[data-id="${idToAnimate}"]`);
    if (el) {
      el.classList.add('entry-entering');
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('entry-entering')));
    }
  }

  const calcs = filtered.map(calc);
  setDash(filtered, calcs);
  updateMonthExtras(calcs.reduce((a, c) => a + c.net, 0));
  updateRangeExtra(filtered, calcs);

  // ── данные для графиков: сначала группируем по дате, чтобы
  //    несколько смен в один день (например, два выхода днём)
  //    давали один столбик, а не два соседних.
  //    Персоналку сюда не берём вообще — эти графики про часы и
  //    ставку, а у неё часов нет, и она их только исказит ──
  const chrono = [...filtered].reverse().filter(s => s.period !== 'personal');
  const shortDate = dateStr => new Date(dateStr + 'T00:00')
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'numeric' });

  const daily = aggregateByDate(chrono);

  // Три бар-чарта ниже — один столбик на дату, а ширина контейнера не резиновая.
  // На вкладке «Все» (и вообще на длинных периодах) дат может набраться сотни за
  // месяцы использования — тогда столбики схлопываются в нечитаемую кашу.
  // Линия с накопительным итогом и разбивка по дням недели этой проблемы не
  // знают (первая — линия, вторая — всегда ровно 7 столбиков), поэтому режем
  // только эти три.
  const CHART_MAX_BARS = 14;
  const dailyForCharts = daily.length > CHART_MAX_BARS ? daily.slice(-CHART_MAX_BARS) : daily;

  const windowNote = document.getElementById('chartWindowNote');
  windowNote.textContent = daily.length > CHART_MAX_BARS
    ? `последние ${CHART_MAX_BARS} из ${daily.length} дат`
    : '';

  drawChart('chartRate', dailyForCharts.map(d => ({
    value: d.netRate, label: shortDate(d.date), period: d.period, display: Math.round(d.netRate)
  })));

  drawWeekdayChart(filtered.filter(s => s.period !== 'personal'));
  drawCumulativeChart('chartCumulative', filtered);
}

/* ── анимация числа: старое значение "докручивается" до нового ──
   Вместо мгновенной подмены цифры бежим по requestAnimationFrame и на
   каждом кадре считаем промежуточное значение — эффект счётчика на
   табло, а не резкий скачок. easeOutCubic (1 - (1-t)^3) даёт быстрый
   старт и плавное торможение к концу — так ощущается естественнее,
   чем равномерное движение. */
const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

let rateAnimFrame = null;
let displayedRate = null;   // текущее показанное (в т.ч. ещё анимируемое) значение

function animateRateTo(target) {
  const el = document.getElementById('netRate');
  if (rateAnimFrame) cancelAnimationFrame(rateAnimFrame);

  if (target === null) {
    el.innerHTML = '—<small> ₽/ч</small>';
    displayedRate = null;
    return;
  }

  // при выключенной анимации в системе (prefers-reduced-motion) — просто
  // ставим значение сразу, никакого "докручивания"
  if (prefersReducedMotion()) {
    el.innerHTML = target + '<small> ₽/ч</small>';
    displayedRate = target;
    return;
  }

  const from = displayedRate === null ? 0 : displayedRate;
  const duration = 500;
  const start = performance.now();

  function tick(now) {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 3);
    const value = Math.round(from + (target - from) * eased);
    el.innerHTML = value + '<small> ₽/ч</small>';
    if (t < 1) {
      rateAnimFrame = requestAnimationFrame(tick);
    } else {
      displayedRate = target;
      rateAnimFrame = null;
    }
  }
  rateAnimFrame = requestAnimationFrame(tick);
}

function setDash(shifts, calcs) {
  const el = id => document.getElementById(id);
  if (!calcs) {
    animateRateTo(null);
    drawGauge(null);
    el('totNet').textContent = el('totFuel').textContent = el('totHours').textContent = el('totKmRate').textContent = '—';
    el('dayRate').textContent = el('nightRate').textContent = '—';
    el('dayN').textContent = el('nightN').textContent = 'нет смен';
    updateIncomeSplit(null);
    return;
  }
  const totNet = calcs.reduce((a, c) => a + c.net, 0);
  const totFuel = calcs.reduce((a, c) => a + c.fuelCost, 0);
  const totExpenses = calcs.reduce((a, c) => a + (c.expenses || 0), 0);
  const totH = calcs.reduce((a, c) => a + c.hours, 0);
  const totKm = shifts.reduce((a, s) => a + (s.mileage || 0), 0);

  // часовая ставка — только по реально отработанным сменам (день/ночь).
  // у персоналки часы и так 0, поэтому totH это уже не портит, а вот
  // её деньги в числителе портили бы — их отдельно вычитаем
  const workedNet = shifts.reduce((a, s, i) => s.period === 'personal' ? a : a + calcs[i].net, 0);
  const rateVal = totH ? Math.round(workedNet / totH) : null;
  animateRateTo(rateVal);
  drawGauge(rateVal);
  el('totNet').textContent = rub(totNet);
  el('totFuel').textContent = rub(totFuel + totExpenses);
  el('totHours').textContent = totH.toFixed(1);
  // та же логика, что и с ₽/ч: км есть только у реальных смен, персоналка тут ни при чём
  el('totKmRate').textContent = totKm ? Math.round(workedNet / totKm) : '—';

  updateIncomeSplit(shifts, calcs);

  // shifts и calcs — одного размера и в одном порядке (см. вызов filtered / filtered.map(calc))
  const byPeriod = p => shifts
    .map((s, i) => ({ s, c: calcs[i] }))
    .filter(x => x.s.period === p);

  [['day', 'dayRate', 'dayN'], ['night', 'nightRate', 'nightN']].forEach(([p, rId, nId]) => {
    const arr = byPeriod(p);
    if (!arr.length) { el(rId).textContent = '—'; el(nId).textContent = 'нет смен'; return; }
    const h = arr.reduce((a, x) => a + x.c.hours, 0);
    const net = arr.reduce((a, x) => a + x.c.net, 0);
    el(rId).textContent = Math.round(net / h) + '₽/ч';
    el(nId).textContent = arr.length + ' ' + plural(arr.length, 'смена', 'смены', 'смен');
  });
}

/* ── разбивка дохода: смены vs персоналка ──
   Показываем, только когда персоналка реально есть в выборке —
   если её нет, полоска 100/0 не несёт никакой информации. */
function updateIncomeSplit(shifts, calcs) {
  const box = document.getElementById('incomeSplit');
  if (!shifts) { box.style.display = 'none'; return; }

  let shiftsNet = 0, personalNet = 0;
  shifts.forEach((s, i) => {
    if (s.period === 'personal') personalNet += calcs[i].net;
    else shiftsNet += calcs[i].net;
  });

  if (personalNet <= 0) { box.style.display = 'none'; return; }

  const total = shiftsNet + personalNet;
  const pctShifts = total > 0 ? Math.round(shiftsNet / total * 100) : 0;
  const pctPersonal = 100 - pctShifts;

  document.getElementById('splitSegShifts').style.width = pctShifts + '%';
  document.getElementById('splitSegPersonal').style.width = pctPersonal + '%';
  document.getElementById('splitShiftsVal').textContent = `${rub(shiftsNet)} · ${pctShifts}%`;
  document.getElementById('splitPersonalVal').textContent = `${rub(personalNet)} · ${pctPersonal}%`;
  box.style.display = 'block';
}

document.getElementById('date').value = localDateStr();
applyTheme();
updatePeriodFieldsVisibility();
load();
