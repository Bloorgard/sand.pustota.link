// Движок песка: карта высот плюс свободные зёрна, срывающиеся с кромки.
// Модель описана в docs/superpowers/specs/2026-08-11-sand-simulation-design.md —
// там же причины, по которым каждая константа именно такая.
//
// Не знает про DOM и canvas: страница отдаёт жест, движок считает поле.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SandEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
    cell: 3,          // px на клетку, ≈1.2 мм
    talus: 2.05,      // угол естественного откоса
    relax: 0.24,      // скорость осыпания
    settle: 0.17,     // как быстро песок слёживается и перестаёт течь
    cohesion: 3.5,    // высота, которую слой держит вертикально
    blade: 60,        // высота лезвия, ≈6 см: выше вал пересыпается назад
    dust: 0.35,       // ниже этого клетка не удерживает материал
    spray: 0.3,       // сколько зерна срывается с кромки
    hold: 26,         // кадров, пока свежая борозда не принимает материал
    pour: 2600,       // масса в секунду из струи
    freeMass: 0.05,   // высота, уносимая одним свободным зерном
    maxFree: 9000,
    yield: 'mc'       // mc | floor — модель порога сдвига
  };

  // стабильный шум по координате
  function hash(x, y) {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  // порядок: 4 прямых соседа, затем 4 диагональных
  const NEIGHBOUR = [[-1, 0], [1, 0], [0, -1], [0, 1], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  const DIAGONAL = [1, 1, 1, 1, 1.41, 1.41, 1.41, 1.41];

  function create(widthPx, heightPx, options) {
    const params = Object.assign({}, DEFAULTS, options);
    const cell = params.cell;

    let cols = 0, rows = 0;
    let field = null;      // высота песка
    let loose = null;      // 0..1, насколько песок ещё подвижен
    let clearedAt = null;  // номер кадра, когда клетку выскребли
    let wall = null;       // клетки, занятые лезвием прямо сейчас
    let wallDirty = false;
    let frameNo = 0;

    const free = {
      x: new Float32Array(params.maxFree),
      y: new Float32Array(params.maxFree),
      vx: new Float32Array(params.maxFree),
      vy: new Float32Array(params.maxFree),
      count: 0
    };

    // Размер стола идёт от окна, но рисунок при этом терять нельзя: перенос
    // идёт от левого верхнего угла, поэтому песок остаётся на месте, а стол
    // прирастает или убывает справа и снизу. Что не поместилось — теряется,
    // иначе некуда деть.
    function resize(nextWidthPx, nextHeightPx) {
      const prevField = field, prevCols = cols, prevRows = rows;
      cols = Math.ceil(nextWidthPx / cell);
      rows = Math.ceil(nextHeightPx / cell);
      field = new Float32Array(cols * rows);
      loose = new Float32Array(cols * rows);
      clearedAt = new Int32Array(cols * rows).fill(-9999);
      wall = new Uint8Array(cols * rows);
      wallDirty = false;
      free.count = 0;

      liveX0 = 0; liveY0 = 0; liveX1 = -1; liveY1 = -1;
      if (prevField) {
        const w = Math.min(prevCols, cols), h = Math.min(prevRows, rows);
        for (let y = 0; y < h; y++)
          field.set(prevField.subarray(y * prevCols, y * prevCols + w), y * cols);
        for (let i = 0; i < field.length; i++) if (field[i] > 0) loose[i] = 1;
        touchArea(1, 1, w - 1, h - 1);
      }

      engine.cols = cols;
      engine.rows = rows;
      engine.field = field;
    }

    // Перенос поля произвольного размера — для сохранений, снятых в окне
    // другого размера: иначе рисунок пропадает при возврате на другом экране.
    function adopt(source, sourceCols, sourceRows) {
      const w = Math.min(sourceCols, cols), h = Math.min(sourceRows, rows);
      for (let y = 0; y < h; y++)
        field.set(source.subarray(y * sourceCols, y * sourceCols + w), y * cols);
      for (let i = 0; i < field.length; i++) if (field[i] > 0) loose[i] = 1;
      touchArea(1, 1, w - 1, h - 1);
    }

    function clear() {
      field.fill(0); loose.fill(0); clearedAt.fill(-9999);
      wall.fill(0); wallDirty = false; free.count = 0;
      liveX0 = 0; liveY0 = 0; liveX1 = -1; liveY1 = -1;
    }

    function mass() {
      let s = 0;
      for (let i = 0; i < field.length; i++) s += field[i];
      return s + free.count * params.freeMass;
    }

    // горсть песка в точке экрана
    function pile(xPx, yPx, radiusPx, peak) {
      const cx = xPx / cell, cy = yPx / cell, r = radiusPx / cell;
      const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(cols - 1, Math.ceil(cx + r));
      const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(rows - 1, Math.ceil(cy + r));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot(x - cx, y - cy) / r;
          if (d >= 1) continue;
          field[y * cols + x] += peak * (1 - d * d) * (0.85 + hash(x, y) * 0.3);
          loose[y * cols + x] = 1;
        }
      touchArea(x0, y0, x1, y1);
    }

    // струя: масса ложится неровно по случайным точкам, как живая
    function pour(xPx, yPx, dt) {
      const amount = params.pour * dt;
      const cx = xPx / cell, cy = yPx / cell, spread = 9 / cell;
      const drops = 14;
      for (let i = 0; i < drops; i++) {
        const a = Math.random() * Math.PI * 2;
        const d = Math.sqrt(Math.random()) * spread;
        const x = Math.round(cx + Math.cos(a) * d), y = Math.round(cy + Math.sin(a) * d);
        if (x < 1 || y < 1 || x >= cols - 1 || y >= rows - 1) continue;
        field[y * cols + x] += amount / drops;
        loose[y * cols + x] = 1;
        touch(x, y);
      }
    }

    // Лезвие — физическое препятствие: пока оно стоит в песке, вал не может
    // осыпаться сквозь него назад, в только что расчищенный путь. Маска идёт
    // строго позади кромки, иначе замораживает сам вал.
    function stampWall(xPx, yPx, prevXPx, prevYPx, angleDeg, lengthPx, down) {
      if (wallDirty) { wall.fill(0); wallDirty = false; }
      if (!down) return;
      const a = angleDeg * Math.PI / 180;
      const ux = Math.cos(a), uy = Math.sin(a);
      let nx = -uy, ny = ux;
      const mvx = xPx - prevXPx, mvy = yPx - prevYPx;
      if (mvx * nx + mvy * ny < 0) { nx = -nx; ny = -ny; }
      const half = lengthPx * 0.5 / cell;
      const cx = xPx / cell, cy = yPx / cell;
      for (let l = -half; l <= half; l += 0.4) {
        for (let d = -1.2; d <= -0.2; d += 0.5) {
          const x = Math.round(cx + ux * l + nx * d), y = Math.round(cy + uy * l + ny * d);
          if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
          wall[y * cols + x] = 1;
          wallDirty = true;
        }
      }
    }

    // Укладка с округлением в одну клетку рвёт вал на комки: соседние точки
    // кромки попадают то в одну клетку, то в другую. Раскладываем по четырём.
    function deposit(fx, fy, amount) {
      const x0 = Math.floor(fx), y0 = Math.floor(fy);
      if (x0 < 1 || y0 < 1 || x0 >= cols - 2 || y0 >= rows - 2) return;
      const tx = fx - x0, ty = fy - y0;
      const i = y0 * cols + x0;
      const w0 = (1 - tx) * (1 - ty), w1 = tx * (1 - ty);
      const w2 = (1 - tx) * ty, w3 = tx * ty;
      field[i] += amount * w0;            loose[i] = 1;
      field[i + 1] += amount * w1;        loose[i + 1] = 1;
      field[i + cols] += amount * w2;     loose[i + cols] = 1;
      field[i + cols + 1] += amount * w3; loose[i + cols + 1] = 1;
      touchArea(x0, y0, x0 + 1, y0 + 1);
    }

    function blade(ax, ay, bx, by, angleDeg, lengthPx) {
      const mvx = bx - ax, mvy = by - ay;
      const dist = Math.hypot(mvx, mvy);
      if (dist < 0.3) return;

      const a = angleDeg * Math.PI / 180;
      const ux = Math.cos(a), uy = Math.sin(a);
      let nx = -uy, ny = ux;
      const front = (mvx * nx + mvy * ny) >= 0 ? 1 : -1;
      nx *= front; ny *= front;

      const half = lengthPx * 0.5 / cell;
      const steps = Math.max(1, Math.ceil(dist / cell * 2));   // подшаг ≤ полклетки
      const speed = dist / steps;

      // Материал сдвигается ровно настолько, насколько кромка продвинулась по
      // своей нормали. Движение вдоль лезвия ничего не толкает — нож скользит
      // по поверхности, как в жизни.
      const bladeHeight = params.blade;
      const advance = (mvx * nx + mvy * ny) / cell / steps;
      if (advance < 0.02) return;
      const reach = advance + 1.0;   // глубина захвата позади кромки

      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const cx = (ax + mvx * t) / cell, cy = (ay + mvy * t) / cell;
        // Материал не бежит вдоль лезвия — он остаётся напротив того места,
        // где его подобрали, и копится перед кромкой. Форму вала держит
        // сцепление, а от осыпания назад его удерживает само лезвие.
        for (let l = -half; l <= half; l += 0.34) {
          const bxp = cx + ux * l, byp = cy + uy * l;
          let carried = 0;

          // только то, что осталось позади кромки: уже вытолкнутый материал
          // лежит впереди и второй раз не подхватывается
          for (let d = -reach; d <= -0.1; d += 0.34) {
            const sx = Math.round(bxp + nx * d), sy = Math.round(byp + ny * d);
            if (sx < 1 || sy < 1 || sx >= cols - 1 || sy >= rows - 1) continue;
            const si = sy * cols + sx;
            const have = field[si];
            if (have < 1e-5) continue;
            field[si] = 0;
            clearedAt[si] = frameNo;
            carried += have;
            touch(sx, sy);

            // часть материала срывается с кромки настоящими зёрнами
            if (free.count < params.maxFree - 1 && carried > params.freeMass &&
                Math.random() < 0.16 * params.spray) {
              carried -= params.freeMass;
              const n = free.count;
              free.x[n] = sx * cell; free.y[n] = sy * cell;
              const sp = 0.5 + Math.random() * speed * 0.8;
              const sc = (Math.random() - 0.5) * 1.6;
              free.vx[n] = nx * sp + ux * sc;
              free.vy[n] = ny * sp + uy * sc;
              free.count++;
            }
          }

          if (carried <= 0) continue;

          // Насыпь перед лезвием растёт вперёд, а не в одну линию: заполняем
          // клетки по ходу движения до высоты кромки, пока материал не
          // кончится. Одна клетка с потолком упиралась бы в предел мгновенно,
          // и весь песок уходил бы назад, хотя вал ещё и не начал расти.
          let left = carried;
          for (let f = 1.3; f <= 12 && left > 1e-5; f += 1) {
            const tx = bxp + nx * f, ty = byp + ny * f;
            const ix = Math.round(tx), iy = Math.round(ty);
            if (ix < 1 || iy < 1 || ix >= cols - 2 || iy >= rows - 2) break;
            const room = bladeHeight - field[iy * cols + ix];
            if (room <= 0) continue;
            const push = Math.min(left, room);
            deposit(tx, ty, push);
            left -= push;
          }
          // не поместилось даже в насыпь — пересыпается через кромку назад
          if (left > 1e-5) deposit(bxp - nx * 1.4, byp - ny * 1.4, left);
        }
      }
    }

    // осыпание, затухающее по мере слёживания
    const share = new Float64Array(8);

    // Осыпание обходило всё поле каждый кадр, даже пустое. Занято песком
    // около двух процентов, поэтому держим прямоугольник активности: он
    // растёт от каждого касания и сжимается, когда песок улёгся. Без этого
    // стол крупнее окна упрётся не в отрисовку, а в физику.
    let liveX0 = 0, liveY0 = 0, liveX1 = -1, liveY1 = -1;

    function touch(x, y) {
      if (liveX1 < liveX0) { liveX0 = liveX1 = x; liveY0 = liveY1 = y; return; }
      if (x < liveX0) liveX0 = x; else if (x > liveX1) liveX1 = x;
      if (y < liveY0) liveY0 = y; else if (y > liveY1) liveY1 = y;
    }

    function touchArea(x0, y0, x1, y1) {
      touch(Math.max(1, x0 | 0), Math.max(1, y0 | 0));
      touch(Math.min(cols - 2, Math.ceil(x1)), Math.min(rows - 2, Math.ceil(y1)));
    }

    function relax() {
      const talus = params.talus, k = params.relax, hold = params.hold;
      const coh = params.cohesion;
      const mohr = params.yield === 'mc';
      const decay = 1 - params.settle;
      if (liveX1 < liveX0) return;                 // всё улеглось, считать нечего
      // запас в клетку: осыпание может выйти за прежнюю границу
      const x0 = Math.max(1, liveX0 - 1), x1 = Math.min(cols - 2, liveX1 + 1);
      const y0 = Math.max(1, liveY0 - 1), y1 = Math.min(rows - 2, liveY1 + 1);
      let nx0 = cols, ny0 = rows, nx1 = -1, ny1 = -1;

      for (let pass = 0; pass < 2; pass++) {
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const i = y * cols + x;
            if (wall[i]) continue;
            const h = field[i];
            if (h < 1e-3) continue;
            const live = loose[i];
            if (live < 0.02) continue;
            if (x < nx0) nx0 = x; if (x > nx1) nx1 = x;
            if (y < ny0) ny0 = y; if (y > ny1) ny1 = y;
            // Порог сдвига. «Порог» замораживает весь слой тоньше сцепления.
            // «Мор-Кулон» — вклад сцепления обратно пропорционален высоте:
            // тонкий слой держит крутую стенку, толстый оплывает до откоса.
            let crit, mobile;
            if (mohr) {
              crit = talus + coh / (h + 0.5);
              mobile = h;
            } else {
              crit = talus;
              mobile = h - coh;
              if (mobile <= 0) continue;
            }
            const kk = k * live;

            // Восемь соседей, а не четыре. По четырём материал растекается по
            // манхэттенской метрике, и любая насыпь выходит ромбом. У диагонали
            // порог круче во столько, во сколько она длиннее.
            let total = 0;
            for (let n = 0; n < 8; n++) {
              const idx = i + NEIGHBOUR[n][0] + NEIGHBOUR[n][1] * cols;
              if (wall[idx] || frameNo - clearedAt[idx] <= hold) { share[n] = 0; continue; }
              const d = (h - field[idx]) - crit * DIAGONAL[n];
              share[n] = d > 0 ? d : 0;
              total += share[n];
            }
            if (total <= 0) continue;
            const give = Math.min(mobile, total * kk) / total;
            for (let n = 0; n < 8; n++) {
              if (share[n] <= 0) continue;
              const idx = i + NEIGHBOUR[n][0] + NEIGHBOUR[n][1] * cols;
              const m = share[n] * give;
              field[i] -= m;
              field[idx] += m;
              loose[idx] = 1;
            }
          }
        }
      }
      // зона сжимается до того, что реально шевелилось в этом кадре
      liveX0 = nx0; liveY0 = ny0; liveX1 = nx1; liveY1 = ny1;

      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) loose[y * cols + x] *= decay;
      collapseDust(x0, y0, x1, y1);
    }

    // Континуум оставляет в клетках бесконечно малые остатки, и рендер честно
    // рисует каждый как отдельное зерно — поле покрывается пылью. Настоящий
    // песок дискретен: меньше зерна не бывает. Крошки уходят к полному соседу.
    function collapseDust(x0, y0, x1, y1) {
      const dust = params.dust;
      if (dust <= 0) return;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = y * cols + x;
          const h = field[i];
          if (h <= 0 || h >= dust) continue;
          let best = -1, bestH = 0;
          const n0 = field[i - 1], n1 = field[i + 1];
          const n2 = field[i - cols], n3 = field[i + cols];
          if (n0 > bestH) { bestH = n0; best = i - 1; }
          if (n1 > bestH) { bestH = n1; best = i + 1; }
          if (n2 > bestH) { bestH = n2; best = i - cols; }
          if (n3 > bestH) { bestH = n3; best = i + cols; }
          if (best < 0 || bestH < dust) continue;  // одинокое зерно лежит
          field[best] += h;
          field[i] = 0;
        }
      }
    }

    // свободные зёрна тормозятся и оседают обратно в поле. Вылетевшее за край
    // садится у границы: терять массу нельзя даже на краю стола
    function stepFree() {
      let alive = 0;
      for (let i = 0; i < free.count; i++) {
        const x = free.x[i] + free.vx[i], y = free.y[i] + free.vy[i];
        const vx = free.vx[i] * 0.82, vy = free.vy[i] * 0.82;
        let cx = (x / cell) | 0, cy = (y / cell) | 0;
        const out = cx < 1 || cy < 1 || cx >= cols - 1 || cy >= rows - 1;
        if (out || Math.hypot(vx, vy) < 0.22) {
          if (cx < 1) cx = 1; else if (cx > cols - 2) cx = cols - 2;
          if (cy < 1) cy = 1; else if (cy > rows - 2) cy = rows - 2;
          field[cy * cols + cx] += params.freeMass;
          loose[cy * cols + cx] = 1;
          touch(cx, cy);
          continue;
        }
        free.x[alive] = x; free.y[alive] = y;
        free.vx[alive] = vx; free.vy[alive] = vy;
        alive++;
      }
      free.count = alive;
    }

    // один кадр симуляции: осыпание и полёт зёрен
    function tick() {
      frameNo++;
      relax();
      stepFree();
    }

    const engine = {
      params, cell, free,
      cols: 0, rows: 0, field: null,
      resize, adopt, clear, mass, pile, pour,
      stampWall, blade, relax, stepFree, tick
    };

    resize(widthPx, heightPx);
    return engine;
  }

  return { create, DEFAULTS };
});
