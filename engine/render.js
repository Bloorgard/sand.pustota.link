// Отрисовка песка зерном по полю высот.
//
// Стили лежат в реестре: у каждого своя функция тона, всё остальное общее.
// Добавить артовый вариант — значит дописать запись в styles, не трогая обход.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SandRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const GRAIN = 2.4;              // px — одно зерно на экране
  const BG = 0xfff1f4f4 | 0;      // ABGR для #f4f4f1
  const SOLID = 0.9;              // выше этой высоты зерно стоит всегда

  // стабильный шум по координате: зерно не дрожит между кадрами
  function hash(x, y) {
    let h = (x | 0) * 374761393 + (y | 0) * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    return ((h ^ (h >> 16)) >>> 0) / 4294967296;
  }

  const styles = {
    plain: {
      title: 'плоский',
      tone(h) { return 0.22 + (1 - Math.exp(-0.45 * h)) * 0.72; }
    },
    light: {
      title: 'свет',
      // боковой свет с северо-запада по уклону поля: геометрия не трогается,
      // поэтому курсор и материал не расходятся
      tone(h, gx, gy) {
        const v = 0.46 - (gx + gy) * 0.55;
        return v < 0.04 ? 0.04 : v > 1 ? 1 : v;
      }
    }
  };

  function shade(v) {
    const g = Math.round(190 - 175 * Math.min(1, v));
    return (0xff000000 | (g << 16) | (g << 8) | g) >>> 0;
  }

  function createTarget(ctx, widthPx, heightPx) {
    const image = ctx.createImageData(widthPx, heightPx);
    return {
      ctx, image,
      pixels: new Uint32Array(image.data.buffer),
      width: widthPx, height: heightPx
    };
  }

  function put(target, x, y, color) {
    const xi = x | 0, yi = y | 0;
    const w = target.width;
    if (xi < 0 || yi < 0 || xi >= w - 1 || yi >= target.height - 1) return;
    const i = yi * w + xi;
    const px = target.pixels;
    px[i] = color; px[i + 1] = color;
    px[i + w] = color; px[i + w + 1] = color;
  }

  // Зерно ставится на собственной сетке, а не на клетке симуляции: иначе
  // сквозь картинку проступает решётка поля.
  function draw(target, engine, styleName) {
    const style = styles[styleName] || styles.plain;
    const px = target.pixels;
    px.fill(BG);

    const field = engine.field, cols = engine.cols, rows = engine.rows;
    const nx = Math.ceil(target.width / GRAIN);
    const ny = Math.ceil(target.height / GRAIN);
    const k = GRAIN / engine.cell;
    const needsSlope = styleName === 'light';

    for (let y = 0; y < ny; y++) {
      const fy = y * k;
      const y0 = fy | 0, ty = fy - y0;
      if (y0 < 1 || y0 >= rows - 2) continue;
      for (let x = 0; x < nx; x++) {
        const fx = x * k;
        const x0 = fx | 0, tx = fx - x0;
        if (x0 < 1 || x0 >= cols - 2) continue;
        const i = y0 * cols + x0;
        const h = field[i] * (1 - tx) * (1 - ty) + field[i + 1] * tx * (1 - ty)
                + field[i + cols] * (1 - tx) * ty + field[i + cols + 1] * tx * ty;
        if (h < 0.015) continue;
        // край получается рваным, тело сплошным
        if (h < SOLID && hash(x, y) > h / SOLID) continue;

        let tone;
        if (needsSlope) {
          const gx = field[i + 1] - field[i - 1];
          const gy = field[i + cols] - field[i - cols];
          tone = style.tone(h, gx, gy);
        } else {
          tone = style.tone(h, 0, 0);
        }

        const jx = (hash(x + 7919, y) - 0.5) * GRAIN * 1.15;
        const jy = (hash(x, y + 104729) - 0.5) * GRAIN * 1.15;
        put(target, x * GRAIN + jx, y * GRAIN + jy, shade(tone));
      }
    }

    const free = engine.free;
    for (let i = 0; i < free.count; i++) put(target, free.x[i], free.y[i], GRAIN_DARK);

    target.ctx.putImageData(target.image, 0, 0);
  }

  const GRAIN_DARK = (0xff000000 | (26 << 16) | (26 << 8) | 26) >>> 0;

  return { createTarget, draw, styles, GRAIN, BG, shade, hash };
});
