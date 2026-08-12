# Перенос движка песка на основную страницу — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Перевести `index.html` на движок C из лаборатории и привести страницу в
порядок: чёрно-белая графика по умолчанию, переключатель на свет, инструмент
снаружи, панель физики по клавише.

**Architecture:** Движок и рендер выносятся в `engine/sand.js` и
`engine/render.js` — обычные скрипты с UMD-обёрткой, работают и через `<script>`
из `file://`, и через `require` в node. Обе страницы, лаборатория и основная,
подключают одни и те же файлы, поэтому физика перестаёт существовать в двух
копиях. Движок не знает про DOM и canvas, поэтому тестируется в node напрямую.

**Tech Stack:** ES2020 без сборки и зависимостей, Canvas 2D через ImageData,
`node --test` (встроен в node 22) для тестов движка.

## Global Constraints

- Никаких зависимостей, сборки и npm-пакетов: проект открывается двойным кликом по файлу.
- Страницы должны работать по `file://` — поэтому обычные скрипты, не ES-модули.
- Масса песка сохраняется точно на всех переходах; это проверяется тестом, а не на глаз.
- Язык интерфейса и комментариев — русский, как в остальном проекте.
- Модель и значения параметров берутся из `docs/superpowers/specs/2026-08-11-sand-simulation-design.md`; расхождения с ней — ошибка.
- Значения по умолчанию: `talus 2.05`, `relax 0.24`, `settle 0.17`, `cohesion 3.5`, `blade 26`, `dust 0.35`, `spray 0.3`, `hold 26`, `pour 2600`, `cell 3`, `grain 2.4`, `freeMass 0.05`, `maxFree 9000`.
- Фон стола `#f4f4f1`, зерно чёрное; палитра не меняется без отдельного решения.

---

### Task 1: Движок в отдельном файле с тестами

**Files:**
- Create: `engine/sand.js`
- Create: `tests/sand.test.js`
- Reference: `lab/index.html:368-624` — секция «C · Гибрид», откуда переносится код

**Interfaces:**
- Produces: `createSandEngine(widthPx, heightPx, options) → engine` со свойствами
  `params, cols, rows, cell, field (Float32Array)`,
  `free` — `{ x, y, vx, vy, count }`, где `x/y/vx/vy` это Float32Array длиной `params.maxFree`, а `count` — число живых зёрен
  и методами:
  `blade(ax, ay, bx, by, angleDeg, lengthPx)`,
  `stampWall(x, y, prevX, prevY, angleDeg, lengthPx, down)`,
  `relax()`, `stepFree()`, `tick()`,
  `pour(x, y, dt)`, `pile(x, y, radiusPx, peak)`,
  `mass()`, `clear()`, `resize(widthPx, heightPx)`.
  В браузере доступен как `window.SandEngine.create`, в node — `require('../engine/sand.js').create`.

- [ ] **Step 1: Написать падающий тест на сохранение массы**

Создать `tests/sand.test.js`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { create } = require('../engine/sand.js');

// ── хелперы измерения ────────────────────────────────────────────────────
function setLine(e, xPx, height, widthCells) {
  const cx = Math.round(xPx / e.cell);
  const half = Math.floor(widthCells / 2);
  for (let y = Math.round(e.rows * 0.25); y < Math.round(e.rows * 0.75); y++)
    for (let x = cx - half; x <= cx + half; x++) e.field[y * e.cols + x] = height;
}

function probe(e, xPx, yPx, rPx) {
  const cx = xPx / e.cell, cy = yPx / e.cell, r = rPx / e.cell;
  let sum = 0;
  for (let y = Math.max(1, Math.floor(cy - r)); y <= Math.min(e.rows - 2, Math.ceil(cy + r)); y++)
    for (let x = Math.max(1, Math.floor(cx - r)); x <= Math.min(e.cols - 2, Math.ceil(cx + r)); x++)
      if (Math.hypot(x - cx, y - cy) <= r) sum += e.field[y * e.cols + x];
  return sum;
}

function stroke(e, x0, y0, x1, y1, steps, angle, len) {
  let px = x0, py = y0;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    e.blade(px, py, x, y, angle, len);
    e.stampWall(x, y, px, py, angle, len, true);
    e.tick();
    px = x; py = y;
  }
  e.stampWall(x1, y1, px, py, angle, len, false);
}

function settle(e, n) { for (let i = 0; i < n; i++) e.tick(); }

// ── тесты ────────────────────────────────────────────────────────────────
test('масса сохраняется после жеста и осыпания', () => {
  const e = create(600, 900);
  e.pile(300, 450, 90, 7);
  const before = e.mass();
  stroke(e, 300, 250, 300, 700, 120, 0, 300);
  settle(e, 200);
  assert.ok(Math.abs(e.mass() - before) < 0.01,
    `масса ушла: ${before} → ${e.mass()}`);
});
```

- [ ] **Step 2: Запустить тест, убедиться, что он падает**

```bash
node --test tests/*.test.js
```

Ожидается: `Cannot find module '../engine/sand.js'`.

- [ ] **Step 3: Создать движок**

Создать `engine/sand.js` с UMD-обёрткой:

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SandEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    cell: 3, talus: 2.05, relax: 0.24, settle: 0.17, cohesion: 3.5,
    blade: 26, dust: 0.35, spray: 0.3, hold: 26, pour: 2600,
    freeMass: 0.05, maxFree: 9000, yield: 'mc'
  };

  function create(widthPx, heightPx, options) {
    const params = Object.assign({}, DEFAULTS, options);
    // ... состояние и методы, см. шаги ниже
  }

  return { create, DEFAULTS };
});
```

Перенести из `lab/index.html:368-624` функции `hybridPile`, `stampWall`,
`deposit`, `hybridBlade`, `hybridRelax`, `collapseDust`, `hybridFree` внутрь
`create`, заменив:

- глобальные `hw, hh, hfield, loose, clearedAt, wall, frameNo, fx, fy, fvx, fvy, nFree` — на локальные переменные замыкания;
- обращения к `P.*` — на `params.*`;
- константы `HC`, `FREE_MASS`, `MAX_FREE` — на `params.cell`, `params.freeMass`, `params.maxFree`;
- чтение `tool.*` внутри `stampWall` — на аргументы функции;
- `hybridBlade(ax, ay, bx, by)` — на `blade(ax, ay, bx, by, angleDeg, lengthPx)`, угол и длина приходят аргументами вместо `P.angle` и `P.len`.

Логику не менять: шаги переноса, пороги, коэффициенты и порядок операций
остаются ровно те же.

- [ ] **Step 4: Добавить методы состояния и кадра**

```js
    function mass() {
      let s = 0;
      for (let i = 0; i < field.length; i++) s += field[i];
      return s + nFree * params.freeMass;
    }

    function clear() {
      field.fill(0); loose.fill(0); clearedAt.fill(-9999);
      wall.fill(0); wallDirty = false; nFree = 0;
    }

    // один кадр симуляции: осыпание и полёт зёрен
    function tick() {
      frameNo++;
      relax();
      stepFree();
    }
```

`mass()` обязана учитывать зёрна в полёте, иначе тест на сохранение массы
поймает ложное расхождение в момент, когда часть материала летит.

- [ ] **Step 5: Запустить тест, убедиться, что проходит**

```bash
node --test tests/*.test.js
```

Ожидается: `pass 1`.

- [ ] **Step 6: Добавить остальные тесты инвариантов**

Дописать в `tests/sand.test.js`:

```js
test('тонкий слой выгребается дочиста', () => {
  const e = create(600, 900);
  setLine(e, 300, 2, 100);
  const before = probe(e, 300, 405, 40);
  stroke(e, 300, 270, 300, 630, 120, 0, 300);
  settle(e, 200);
  const after = probe(e, 300, 405, 40);
  assert.ok(after < before * 0.05,
    `путь не выгребен: ${before.toFixed(0)} → ${after.toFixed(0)}`);
});

test('вал не обрушивается после жеста', () => {
  const e = create(600, 900);
  setLine(e, 300, 2, 100);
  stroke(e, 300, 270, 300, 630, 120, 0, 300);
  const peak = probe(e, 300, 638, 6);
  settle(e, 200);
  assert.ok(probe(e, 300, 638, 6) > peak * 0.7,
    'вал осыпался больше чем на треть');
});

test('движение вдоль лезвия не двигает песок', () => {
  const e = create(600, 900);
  setLine(e, 300, 3, 20);
  const before = e.field.slice();
  // лезвие вертикально (90°), ведём тоже вертикально — нормальная компонента нулевая
  stroke(e, 300, 300, 300, 600, 100, 90, 300);
  let moved = 0;
  for (let i = 0; i < e.field.length; i++) moved += Math.abs(e.field[i] - before[i]);
  assert.ok(moved < 1, `песок сдвинулся на ${moved.toFixed(1)} при скольжении вдоль кромки`);
});

test('слой толще лезвия почти не гребётся', () => {
  const e = create(600, 900, { blade: 26 });
  setLine(e, 300, 15, 100);
  const before = probe(e, 300, 405, 40);
  stroke(e, 300, 270, 300, 630, 120, 0, 300);
  settle(e, 100);
  assert.ok(probe(e, 300, 405, 40) > before * 0.8,
    'карточка в 2.6 см не должна сгребать слой в 15 см');
});

test('крошки не остаются пылью', () => {
  const e = create(600, 900, { dust: 0.35 });
  e.pile(300, 450, 90, 7);
  stroke(e, 300, 250, 300, 700, 120, 0, 300);
  settle(e, 200);
  let dusty = 0;
  for (let i = 0; i < e.field.length; i++)
    if (e.field[i] > 0 && e.field[i] < 0.05) dusty++;
  assert.ok(dusty < e.field.length * 0.01,
    `клеток с пылью: ${dusty}`);
});
```

- [ ] **Step 7: Запустить все тесты**

```bash
node --test tests/*.test.js
```

Ожидается: `pass 6`, `fail 0`. Если падает тест про скольжение вдоль лезвия —
проверить, что `blade()` считает `advance` от нормальной компоненты движения и
выходит при `advance < 0.02`.

- [ ] **Step 8: Коммит**

```bash
git add engine/sand.js tests/sand.test.js
git commit -m "Extract the sand engine into a testable module"
```

---

### Task 2: Лаборатория на общем движке

**Files:**
- Modify: `lab/index.html` — удалить секцию C, подключить `engine/sand.js`

**Interfaces:**
- Consumes: `window.SandEngine.create` из Task 1.
- Produces: рабочая лаборатория без собственной копии физики; отладочный мост `window.__lab` сохраняет прежние методы.

- [ ] **Step 1: Подключить движок**

В `lab/index.html` перед основным `<script>` добавить:

```html
<script src="../engine/sand.js"></script>
```

- [ ] **Step 2: Удалить перенесённый код и завести движок**

Удалить из `lab/index.html` строки секции «C · ГИБРИД» — функции
`hybridInit`, `hybridPile`, `stampWall`, `deposit`, `hybridBlade`,
`hybridRelax`, `collapseDust`, `hybridFree` и их переменные состояния.

Вместо `hybridInit` завести:

```js
let engine = null;

function hybridInit(fresh) {
  engine = SandEngine.create(W, H, {
    talus: P.talus, relax: P.relax, settle: P.settle, cohesion: P.cohesion,
    blade: P.blade, dust: P.dust, spray: P.spray, hold: P.hold,
    pour: P.pour, yield: P.yield
  });
  if (fresh) engine.pile(W * 0.5, H * 0.5, Math.min(W, H) * 0.12, 7);
}
```

Ползунки продолжают писать в `P`, поэтому перед каждым кадром параметры
переносятся в движок:

```js
function syncEngineParams() {
  Object.assign(engine.params, {
    talus: P.talus, relax: P.relax, settle: P.settle, cohesion: P.cohesion,
    blade: P.blade, dust: P.dust, spray: P.spray, hold: P.hold,
    pour: P.pour, yield: P.yield
  });
}
```

- [ ] **Step 3: Перевести кадр и мост на движок**

В ветке `mode === 'hybrid'` функции `frame`:

```js
    syncEngineParams();
    if (tool.down) engine.blade(tool.px, tool.py, tool.x, tool.y, P.angle, P.len);
    engine.stampWall(tool.x, tool.y, tool.px, tool.py, P.angle, P.len, tool.down);
    engine.tick();
    renderHybrid();
    hud.textContent = `${Math.round(fps)} fps · масса ${engine.mass().toFixed(0)}` +
      ` · в воздухе ${engine.free.count}`;
```

В `renderHybrid` заменить обращения к `hfield`, `hw`, `hh` на `engine.field`,
`engine.cols`, `engine.rows`, а `HC` на `engine.cell`.

Методы моста `probe`, `widthAt`, `crest`, `setLine`, `clear` переписать на
`engine.field` теми же формулами; `pour` и `pile` вызывать у движка.

- [ ] **Step 4: Проверить, что лаборатория ведёт себя как раньше**

Открыть `lab/index.html`, в консоли:

```js
const L = window.__lab; L.reset();
const m0 = L.probe(innerWidth/2, innerHeight/2, 900);
L.stroke(innerWidth*0.4, innerHeight*0.35, innerWidth*0.6, innerHeight*0.65, 60);
L.settle(120);
[m0.toFixed(2), L.probe(innerWidth/2, innerHeight/2, 900).toFixed(2)];
```

Ожидается: два одинаковых числа, вал собран, путь чист, ошибок в консоли нет.

- [ ] **Step 5: Коммит**

```bash
git add lab/index.html
git commit -m "Point the lab at the shared engine"
```

---

### Task 3: Рендер как реестр стилей

**Files:**
- Create: `engine/render.js`
- Modify: `lab/index.html` — использовать общий рендер для режима C

**Interfaces:**
- Consumes: `engine` из Task 1.
- Produces: `window.SandRender` с методами
  `createTarget(canvasCtx, widthPx, heightPx) → target`,
  `draw(target, engine, styleName)`,
  `styles` — объект-реестр `{ plain, light }`, куда позже добавляются артовые стили.

- [ ] **Step 1: Создать рендер с двумя стилями**

`engine/render.js`, та же UMD-обёртка. Реестр стилей — объект, где каждый стиль
это функция тона от высоты и уклона; всё остальное общее:

```js
  const GRAIN = 2.4;                       // px, одно зерно на экране
  const BG = 0xfff1f4f4 | 0;               // ABGR для #f4f4f1

  const styles = {
    plain: {
      name: 'плоский',
      tone(h) { return 0.22 + (1 - Math.exp(-0.45 * h)) * 0.72; }
    },
    light: {
      name: 'свет',
      tone(h, gx, gy) {
        const v = 0.46 - (gx + gy) * 0.55;
        return v < 0.04 ? 0.04 : v > 1 ? 1 : v;
      }
    }
  };
```

Функция `draw` переносится из `renderHybrid` (`lab/index.html:686`) с двумя
изменениями: обращения к полю идут через `engine`, а тон берётся из
`styles[styleName].tone(h, gx, gy)`. Режим «подъём» не переносится — на
основной странице он не используется, а в лаборатории остаётся своя копия.

- [ ] **Step 2: Проверить, что стили дают разную картинку**

Подключить `engine/render.js` в `lab/index.html`, переключить режим C на
общий рендер, открыть страницу и переключить «плотность» / «свет».
Ожидается: обе картинки рисуются, светлая версия показывает уклоны, решётки
поля не видно.

- [ ] **Step 3: Коммит**

```bash
git add engine/render.js lab/index.html
git commit -m "Extract rendering into a style registry"
```

---

### Task 4: Основная страница на новом движке

**Files:**
- Modify: `index.html` — заменить симуляцию и рендер, сохранить UI

**Interfaces:**
- Consumes: `SandEngine.create`, `SandRender.createTarget`, `SandRender.draw`.
- Produces: рабочая страница на движке C; функции `saveState`/`loadState` остаются с прежними именами.

- [ ] **Step 1: Подключить движок и рендер**

```html
<script src="engine/sand.js"></script>
<script src="engine/render.js"></script>
```

- [ ] **Step 2: Заменить состояние симуляции**

Удалить из `index.html` собственную симуляцию: `sand`, `simWidth`, `simHeight`,
`applyStroke`, `depositAcrossEdge`, `createMound`, `render`, `buildRenderNoise`,
`sampleHeight`, `sumMass`, `MAX_HEIGHT` и очередь `strokes`.

Завести:

```js
    let engine = null;
    let target = null;

    function initialize(forceFresh = false) {
      engine = SandEngine.create(innerWidth, innerHeight);
      target = SandRender.createTarget(context, canvas.width, canvas.height);
      const saved = forceFresh ? null : loadState();
      if (saved) engine.field.set(saved);
      else engine.pile(innerWidth * 0.5, innerHeight * 0.5,
                       Math.min(innerWidth, innerHeight) * 0.12, 7);
      initialMass = engine.mass();
    }
```

- [ ] **Step 3: Перевести жест и кадр**

Скребок ведётся указателем без очереди отложенных штрихов — движок считает
кадр целиком:

```js
    function tick(now) {
      if (tool.down) engine.blade(tool.px, tool.py, tool.x, tool.y, toolAngle, toolLength);
      engine.stampWall(tool.x, tool.y, tool.px, tool.py, toolAngle, toolLength, tool.down);
      engine.tick();
      SandRender.draw(target, engine, style);
      tool.px = tool.x; tool.py = tool.y;
      requestAnimationFrame(tick);
    }
```

`onPointerDown`, `onPointerMove`, `finishPointer` сохранить, заменив в них
запись в `strokes` на обновление `tool.x`, `tool.y`, `tool.down`.

- [ ] **Step 4: Обновить сохранение под новое поле**

Формат меняется, поэтому версия поднимается до 3, а старые записи
отбрасываются — прежнее поле принадлежало другой модели и в новую не
переводится:

```js
    const SAVE_KEY = 'sand.pustota.sculpt06';
    const MAX_HEIGHT = 64.0;          // потолок упаковки, вал доходит до 40

    function saveState() {
      try {
        const packed = new Uint16Array(engine.field.length);
        for (let i = 0; i < packed.length; i++)
          packed[i] = Math.round(clamp(engine.field[i] / MAX_HEIGHT, 0, 1) * 65535);
        localStorage.setItem(SAVE_KEY, JSON.stringify({
          version: 3, cols: engine.cols, rows: engine.rows,
          data: bytesToBase64(new Uint8Array(packed.buffer))
        }));
      } catch (error) {
        console.warn('Не удалось сохранить песок:', error);
      }
    }

    function loadState() {
      try {
        const raw = localStorage.getItem(SAVE_KEY);
        if (!raw) return null;
        const saved = JSON.parse(raw);
        if (saved.version !== 3) return null;
        if (saved.cols !== engine.cols || saved.rows !== engine.rows) return null;
        const packed = new Uint16Array(base64ToBytes(saved.data).buffer);
        const out = new Float32Array(packed.length);
        for (let i = 0; i < packed.length; i++) out[i] = packed[i] / 65535 * MAX_HEIGHT;
        return out;
      } catch (error) {
        return null;
      }
    }
```

- [ ] **Step 5: Проверить страницу вручную**

Открыть `index.html`. Проверить по пунктам:

1. видна одна горсть песка;
2. скребок сгребает материал, за кромкой остаётся чистый стол;
3. форма не расползается после отпускания;
4. «досыпать» подсыпает под курсор, «сбросить» возвращает горсть;
5. экспорт сохраняет PNG;
6. после перезагрузки страницы форма на месте.

- [ ] **Step 6: Коммит**

```bash
git add index.html
git commit -m "Port the main page onto the lab engine"
```

---

### Task 5: Переключатель графики и скрытая панель

**Files:**
- Modify: `index.html` — переключатель стиля в топбаре, панель физики по клавише

**Interfaces:**
- Consumes: `SandRender.styles` из Task 3.
- Produces: `style` — имя текущего стиля, сохраняется в `localStorage` под ключом `sand.pustota.style`.

- [ ] **Step 1: Добавить переключатель графики**

В топбар, рядом с ползунками:

```html
<button id="style" type="button" class="style-toggle" aria-pressed="false">свет</button>
```

```js
    const STYLE_KEY = 'sand.pustota.style';
    let style = localStorage.getItem(STYLE_KEY) === 'light' ? 'light' : 'plain';

    const styleButton = document.querySelector('#style');
    function applyStyle() {
      styleButton.setAttribute('aria-pressed', style === 'light' ? 'true' : 'false');
      localStorage.setItem(STYLE_KEY, style);
    }
    styleButton.addEventListener('click', () => {
      style = style === 'light' ? 'plain' : 'light';
      applyStyle();
    });
    applyStyle();
```

По умолчанию `plain` — плоская чёрно-белая графика; свет включается кнопкой.
Добавление артовых стилей позже сведётся к записи в `SandRender.styles` и
замене кнопки на список.

- [ ] **Step 2: Добавить скрытую панель физики**

Панель открывается клавишей `Backquote` (` — под Esc, не мешает вводу) и по
умолчанию скрыта:

```html
<aside id="physics" class="physics" hidden aria-label="Настройки материала">
  <label>откос <input type="range" id="p-talus" min="0" max="3" step="0.05" value="2.05"><output>2.05</output></label>
  <label>осыпание <input type="range" id="p-relax" min="0" max="0.25" step="0.01" value="0.24"><output>0.24</output></label>
  <label>слёживание <input type="range" id="p-settle" min="0" max="0.3" step="0.01" value="0.17"><output>0.17</output></label>
  <label>сцепление <input type="range" id="p-cohesion" min="0" max="8" step="0.1" value="3.5"><output>3.5</output></label>
  <label>высота лезвия <input type="range" id="p-blade" min="4" max="200" step="2" value="26"><output>26</output></label>
  <label>россыпь <input type="range" id="p-spray" min="0" max="3" step="0.1" value="0.3"><output>0.3</output></label>
</aside>
```

```js
    const physics = document.querySelector('#physics');
    addEventListener('keydown', event => {
      if (event.code !== 'Backquote') return;
      event.preventDefault();
      physics.hidden = !physics.hidden;
    });

    for (const input of physics.querySelectorAll('input')) {
      const key = input.id.slice(2);              // p-talus → talus
      const out = input.nextElementSibling;
      const sync = () => {
        engine.params[key] = Number(input.value);
        out.textContent = input.value;
      };
      input.addEventListener('input', sync);
      sync();
    }
```

Значения панели не сохраняются между сессиями: это инструмент отладки, а
рабочая калибровка живёт в значениях по умолчанию движка.

- [ ] **Step 3: Перенести клавиши инструмента**

Спецификация описывает управление под левой рукой; на основной странице оно
нужно так же, как в лаборатории. Обработчик по `event.code`, чтобы работал в
любой раскладке:

```js
    const keys = new Set();
    const HOTKEYS = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyA', 'KeyS', 'KeyD'];

    addEventListener('keydown', event => {
      if (!HOTKEYS.includes(event.code)) return;
      event.preventDefault();
      if (event.repeat) return;
      keys.add(event.code);
      if (event.code === 'KeyE') snapAngle(-45);
      else if (event.code === 'KeyR') snapAngle(45);
    });
    addEventListener('keyup', event => keys.delete(event.code));
    addEventListener('blur', () => keys.clear());

    function snapAngle(delta) {
      const snapped = Math.round(toolAngle / 45) * 45 + delta;
      setToolAngle((snapped % 180 + 180) % 180);
    }

    // вызывается из tick, dt в секундах
    function applyKeys(dt) {
      const rot = 75 * dt, grow = 260 * dt;
      if (keys.has('KeyA')) engine.pour(tool.x, tool.y, dt);
      if (keys.has('KeyQ')) setToolAngle(((toolAngle - rot) % 180 + 180) % 180);
      if (keys.has('KeyW')) setToolAngle((toolAngle + rot) % 180);
      if (keys.has('KeyS')) setToolLength(toolLength - grow);
      if (keys.has('KeyD')) setToolLength(toolLength + grow);
    }
```

В `tick` добавить `applyKeys(Math.min(dt, 50) / 1000)` перед работой движка.
`setToolAngle` и `setToolLength` уже существуют и сами обновляют ползунки и
`localStorage`, поэтому подписи синхронизируются сами.

Легенду клавиш вынести в правый нижний угол так же, как в лаборатории —
блок `#legend` с `kbd`, подсветка нажатой клавиши необязательна.

- [ ] **Step 4: Проверить**

Открыть страницу. Ожидается: кнопка переключает графику и переживает
перезагрузку; клавиша ` открывает и закрывает панель; `Q`/`W` плавно
поворачивают скребок, `E`/`R` щёлкают по 45°, `S`/`D` меняют длину, `A` сыплет
струёй под курсором; ползунки в панели меняют поведение песка сразу.

- [ ] **Step 5: Коммит**

```bash
git add index.html
git commit -m "Add graphics toggle, hotkeys and a hidden physics panel"
```

---

### Task 6: Приведение страницы в порядок

**Files:**
- Modify: `index.html` — топбар, подсказка, состояние, скребок

**Interfaces:**
- Consumes: всё предыдущее. Ничего нового не производит.

- [ ] **Step 1: Разобрать топбар**

Сейчас бренд, два ползунка с подписями и три кнопки лежат в одном ряду без
группировки. Развести на инструмент и действия:

```html
<header class="topbar">
  <div class="brand">
    <strong>sand.pustota.link</strong>
    <span>конечная горсть · скребок 01</span>
  </div>

  <div class="tool-group" role="group" aria-label="Скребок">
    <label for="angle">угол<input id="angle" type="range" min="0" max="180" step="1" value="45"><output id="angle-value">45°</output></label>
    <label for="length">длина<input id="length" type="range" min="70" max="240" step="5" value="150"><output id="length-value">150</output></label>
  </div>

  <nav class="actions" aria-label="Действия">
    <button id="style" type="button" aria-pressed="false">свет</button>
    <button id="add-sand" type="button">досыпать</button>
    <button id="reset" type="button">сбросить</button>
    <button id="export" type="button">экспорт</button>
  </nav>
</header>
```

```css
  .topbar { display: flex; align-items: center; gap: 24px; }
  .brand { margin-right: auto; }
  .tool-group { display: flex; gap: 16px; }
  .tool-group label { display: flex; align-items: center; gap: 8px; font-size: 12px; }
  .tool-group input { width: 96px; }
  .actions { display: flex; gap: 6px; }
```

Скребок как DOM-элемент (`#card`) оставить: он даёт живую тень и поворот
средствами CSS, чего на канвасе пришлось бы добиваться руками.

- [ ] **Step 2: Убрать шум из интерфейса**

- подсказка `#hint` показывается только до первого жеста, затем исчезает навсегда (флаг в `localStorage`);
- `#status` не обновляется каждые 800 мс, а меняется только при смене массы больше чем на процент — иначе цифры дёргаются на пустом месте;
- сообщить клавишу ` в подписи к кнопке действий через `title`, чтобы панель не была секретом только для автора.

- [ ] **Step 3: Проверить на узком экране**

Открыть страницу шириной 375 px. Ожидается: топбар не наезжает на канвас,
ползунки доступны, скребок ведётся пальцем, панель физики скроллится.

- [ ] **Step 4: Обновить README и CONCEPT**

В `README.md` заменить раздел «Текущая модель» на ссылку на спецификацию и
короткое описание: движок общий с лабораторией, физика описана в
`docs/superpowers/specs/2026-08-11-sand-simulation-design.md`.

В `CONCEPT.md` поправить раздел «Физическая модель»: он описывает перенос
объёма карточкой и локальную релаксацию, но не упоминает ни сцепления, ни
высоты лезвия, ни того, что кромка работает препятствием для осыпания.

- [ ] **Step 5: Коммит**

```bash
git add index.html README.md CONCEPT.md
git commit -m "Tidy the main page and refresh the docs"
```

---

## Порядок и проверки

Задачи выполняются по порядку: 2 зависит от 1, 3 от 1, 4 от 1 и 3, 5 от 4,
6 от 5. После каждой задачи `node --test tests/*.test.js` должен проходить целиком —
это защита от того, что правка ради страницы незаметно испортит физику.

Открытые вопросы из спецификации (двухслойная модель вместо слёживания,
уплотнение от скребка, гистерезис, артовые стили отрисовки) в этот план не
входят и делаются отдельными шагами.
