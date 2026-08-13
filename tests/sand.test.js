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

// Вал вровень с кромкой держится намертво; чем выше лезвие, тем выше вал и
// тем больше он оседает — но всё равно остаётся выше низкого.
test('вал вровень с кромкой не обрушивается', () => {
  const e = create(600, 900, { blade: 26 });
  setLine(e, 300, 2, 100);
  stroke(e, 300, 270, 300, 630, 120, 0, 300);
  const peak = probe(e, 300, 638, 6);
  settle(e, 200);
  const after = probe(e, 300, 638, 6);
  assert.ok(after > peak * 0.95,
    `вал осыпался: ${peak.toFixed(0)} → ${after.toFixed(0)}`);
});

test('высокое лезвие несёт больше песка, не пачкая путь', () => {
  function run(blade) {
    const e = create(600, 900, { blade });
    setLine(e, 300, 2, 100);
    stroke(e, 300, 270, 300, 630, 120, 0, 300);
    settle(e, 200);
    return { ridge: probe(e, 300, 638, 6), track: probe(e, 300, 405, 40) };
  }
  const low = run(26), high = run(60);
  assert.ok(high.ridge > low.ridge,
    `высокое лезвие принесло не больше: ${low.ridge.toFixed(0)} → ${high.ridge.toFixed(0)}`);
  assert.ok(high.track < 5, `путь за высоким лезвием грязный: ${high.track.toFixed(1)}`);
});

test('движение вдоль лезвия не двигает песок', () => {
  const e = create(600, 900);
  setLine(e, 300, 3, 20);
  const before = e.field.slice();
  // лезвие вертикально, ведём тоже вертикально — нормальная компонента нулевая
  stroke(e, 300, 300, 300, 600, 100, 90, 300);
  let moved = 0;
  for (let i = 0; i < e.field.length; i++) moved += Math.abs(e.field[i] - before[i]);
  assert.ok(moved < 1,
    `песок сдвинулся на ${moved.toFixed(1)} при скольжении вдоль кромки`);
});

test('слой толще лезвия почти не гребётся', () => {
  const e = create(600, 900, { blade: 26 });
  setLine(e, 300, 15, 100);
  const before = probe(e, 300, 405, 40);
  stroke(e, 300, 270, 300, 630, 120, 0, 300);
  settle(e, 100);
  const after = probe(e, 300, 405, 40);
  assert.ok(after > before * 0.8,
    `карточка в 2.6 см сгребла слой в 15 см: ${before.toFixed(0)} → ${after.toFixed(0)}`);
});

test('крошки не остаются пылью', () => {
  const e = create(600, 900, { dust: 0.35 });
  e.pile(300, 450, 90, 7);
  stroke(e, 300, 250, 300, 700, 120, 0, 300);
  settle(e, 200);
  let dusty = 0;
  for (let i = 0; i < e.field.length; i++)
    if (e.field[i] > 0 && e.field[i] < 0.05) dusty++;
  assert.ok(dusty < e.field.length * 0.01, `клеток с пылью: ${dusty}`);
});

test('рисунок переживает изменение размера окна', () => {
  const e = create(600, 900);
  e.pile(200, 300, 60, 6);
  const before = e.mass();
  const probeBefore = probe(e, 200, 300, 70);

  e.resize(900, 1200);            // окно растянули
  assert.ok(Math.abs(e.mass() - before) < 0.01,
    `масса потерялась при расширении: ${before} → ${e.mass()}`);
  assert.ok(Math.abs(probe(e, 200, 300, 70) - probeBefore) < 0.01,
    'песок сместился относительно левого верхнего угла');

  e.resize(600, 900);             // и вернули обратно
  assert.ok(Math.abs(probe(e, 200, 300, 70) - probeBefore) < 0.01,
    'песок не пережил возврат к прежнему размеру');
});

test('поле чужого размера переносится с обрезкой по краю', () => {
  const e = create(600, 900);
  const source = new Float32Array(100 * 100).fill(2);
  e.adopt(source, 100, 100);      // источник уже поля по ширине
  assert.ok(e.mass() > 0, 'ничего не перенеслось');
  assert.strictEqual(e.field[0], 2, 'левый верхний угол не совпал');
  assert.strictEqual(e.field[99 * e.cols + 99], 2, 'дальний угол источника потерян');
  assert.strictEqual(e.field[100 * e.cols + 100], 0, 'перенос вышел за размер источника');
});
