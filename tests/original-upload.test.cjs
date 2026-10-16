const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');

// Exercise the actual import handler with a fake SDK. This does not prove Miro's server limit.
function setup(files, rejectUpload = false, options = {}) {
  const elements = new Map();
  const el = id => {
    if (!elements.has(id)) elements.set(id, { style: {}, textContent: '', value: '', hidden: true });
    return elements.get(id);
  };
  el('stitch-form').stitchImagesPerRow = { value: '2' };
  el('stitch-form').stitchStartCorner = { value: 'top-left' };
  el('stitch-form').stitchSkipMissing = { checked: false };
  el('stitchFolderInput').files = files;
  const calls = [];
  const encodes = [];
  let sourceCloses = 0;
  const board = {
    viewport: { get: async () => ({ x: 0, y: 0, width: 1000, height: 1000 }), zoomTo: async () => {} },
    notifications: { showError: async () => {}, showWarning: async () => {}, showInfo: async () => {} },
    createImage: async params => {
      calls.push(params);
      if (rejectUpload === true || rejectUpload === calls.length) throw Object.assign(new Error('Maximum upload size exceeded'), { code: 'invalidParameters', status: 400 });
      return { setMetadata: async () => {} };
    },
  };
  const context = vm.createContext({
    window: { miro: { board }, addEventListener() {} },
    document: {
      getElementById: el,
      createElement: type => {
        assert.equal(type, 'canvas');
        return {
          getContext: () => ({
            drawImage() {}, getContextAttributes: () => ({ colorSpace: 'srgb' }),
            getImageData: () => ({ data: new Uint8ClampedArray(50 * 50 * 4) }),
          }),
          toDataURL() { throw new Error('Original must never be re-encoded'); },
        };
      },
    },
    Image: class {
      set src(value) {
        if (!value) return;
        this.naturalWidth = value.width;
        this.naturalHeight = value.height;
        queueMicrotask(() => this.onload());
      }
    },
    URL: { createObjectURL: file => file, revokeObjectURL() {} },
    FileReader: class {
      readAsDataURL(file) {
        queueMicrotask(() => {
          if (file.readError) { this.error = new Error('Read failed'); this.onerror(); return; }
          this.result = `data:${file.type};base64,${file.bytes.toString('base64')}`;
          this.onload();
        });
      }
    },
    Uint8Array, DataView, Blob, Response, CompressionStream, DecompressionStream,
    performance, setTimeout: fn => setTimeout(fn, 0),
    console: { log() {}, warn() {}, error() {}, groupCollapsed() {}, groupEnd() {}, table() {} },
  });
  vm.runInContext(fs.readFileSync(require('node:path').join(__dirname, '../lossless-upload.js'), 'utf8'), context);
  const helpers = context.window.LosslessUpload;
  helpers.openSource = async file => ({
    image: { width: file.width, height: file.height },
    colors: { description: 'test RGB profile', chunks: [] },
    close: () => sourceCloses++,
  });
  helpers.encodeRegion = async (source, rect) => {
    encodes.push({ ...rect });
    const size = options.pngSize ? options.pngSize(rect) : 100;
    return { size, type: 'image/png', bytes: Buffer.alloc(Math.min(size, 100), 0x7f) };
  };
  vm.runInContext(source, context);
  return { calls, el, encodes, get sourceCloses() { return sourceCloses; }, run: () => context.handleStitchSubmit({ preventDefault() {} }) };
}

function fixture(size = 20_000_000, name = 'Tile_1.jpg') {
  const bytes = Buffer.alloc(size, 0xa5);
  return { name, type: 'image/jpeg', width: 4096, height: 4096, size, bytes };
}

test('20 MB original is sent once, unchanged, at full size; grid spacing is preserved', async () => {
  const file = fixture();
  const second = fixture(100, 'Tile_2.jpg');
  const app = setup([file, second]);
  await app.run();
  assert.equal(app.calls.length, 2);
  assert.equal(app.calls[0].width, 4096);
  assert.equal(app.calls[1].x - app.calls[0].x, 4096);
  assert.equal(app.calls[0].y, app.calls[1].y);
  assert.deepEqual(Buffer.from(app.calls[0].url.split(',')[1], 'base64'), file.bytes);
  const report = JSON.parse(app.el('originalUploadReport').value);
  assert.equal(report.uploads[0].fileBytes, 20_000_000);
  assert.ok(report.uploads[0].payloadCharacters > 11_000_000);
  assert.equal(report.uploads[0].status, 'created');
  assert.equal(app.el('stitchButton').disabled, false);
});

test('SDK rejection stays visible with no retry, slicing, or recompression', async () => {
  const app = setup([fixture()], true);
  await app.run();
  assert.equal(app.calls.length, 1);
  const report = JSON.parse(app.el('originalUploadReport').value);
  assert.equal(report.uploads[0].status, 'failed');
  assert.equal(report.uploads[0].error.code, 'invalidParameters');
  assert.equal(report.uploads[0].error.status, 400);
  assert.equal(app.el('originalUploadReportBox').hidden, false);
  assert.equal(app.el('stitchButton').disabled, false);
});

test('file read failure is reported and the next file can still upload', async () => {
  const bad = { ...fixture(100), readError: true };
  const app = setup([bad, fixture(100, 'Tile_2.jpg')]);
  await app.run();
  assert.equal(app.calls.length, 1);
  const report = JSON.parse(app.el('originalUploadReport').value);
  assert.deepEqual(report.uploads.map(x => x.status), ['failed', 'created']);
});

for (const targetParts of [2, 3, 4]) {
  test(`oversized JPG chooses ${targetParts} PNG strips before uploading; positions preserve the original slot`, async () => {
    const app = setup([fixture(28_000_000), fixture(100, 'Tile_2.jpg')], false, {
      pngSize: rect => rect.width > Math.ceil(4096 / targetParts) ? 23_000_000 : 100,
    });
    await app.run();
    assert.equal(app.calls.length, targetParts + 1);
    const report = JSON.parse(app.el('originalUploadReport').value).uploads[0];
    assert.equal(report.mode, 'lossless-png');
    assert.deepEqual(report.attempts, Array.from({ length: targetParts - 1 }, (_, i) => i + 2));
    assert.equal(report.partCount, targetParts);
    assert.equal(report.status, 'created');
    const parts = app.calls.slice(0, -1);
    assert.equal(parts.reduce((sum, p) => sum + p.width, 0), 4096);
    for (let i = 0; i < parts.length; i++) {
      assert.ok(parts[i].url.startsWith('data:image/png;base64,'));
      assert.equal(parts[i].y, app.calls.at(-1).y);
      if (i) assert.equal(parts[i].x - parts[i].width / 2, parts[i-1].x + parts[i-1].width / 2);
    }
    assert.equal(parts.at(-1).x + parts.at(-1).width / 2, app.calls.at(-1).x - 2048);
    assert.equal(app.sourceCloses, 1);
    assert.equal(app.el('stitchProgressMain').textContent, `Uploading to board… ${targetParts + 1} / ${targetParts + 1}`);
  });
}

test('split failure is partial, stops the remaining pieces, continues the next file without retries', async () => {
  const app = setup([fixture(28_000_000), fixture(100, 'Tile_2.jpg')], 2, {
    pngSize: rect => rect.width > 1366 ? 23_000_000 : 100,
  });
  await app.run();
  assert.equal(app.calls.length, 3);
  const report = JSON.parse(app.el('originalUploadReport').value).uploads;
  assert.equal(report[0].status, 'partial');
  assert.equal(report[0].createdParts, 1);
  assert.deepEqual(report[0].parts.map(p => p.status), ['created', 'failed']);
  assert.equal(report[1].status, 'created');
  assert.equal(app.el('stitchButton').disabled, false);
  assert.equal(app.sourceCloses, 1);
});

test('bottom-right corner reverses source slots, never reverses pixels within a tile', async () => {
  const app = setup([fixture(28_000_000), fixture(100, 'Tile_2.jpg')]);
  app.el('stitch-form').stitchStartCorner.value = 'bottom-right';
  await app.run();
  assert.ok(app.calls[0].x < app.calls[1].x);
  assert.equal(app.calls[0].x - 1024, app.calls[2].x + 2048);
});

test('missing numbered tiles retain a whole slot even when the next tile splits', async () => {
  const app = setup([fixture(100), fixture(28_000_000, 'Tile_3.jpg')]);
  app.el('stitch-form').stitchSkipMissing.checked = true;
  app.el('stitch-form').stitchImagesPerRow.value = '4';
  await app.run();
  assert.equal(app.calls[1].x - 1024 - (app.calls[0].x - 2048), 8192);
});

test('large-image base tiles use PNG without JPEG recompression or board scaling', async () => {
  const file = { ...fixture(100), width: 9000, height: 4096 };
  const app = setup([file]);
  await app.run();
  assert.equal(app.calls.length, 3);
  assert.deepEqual(app.calls.map(p => p.width), [4096, 4096, 808]);
  assert.ok(app.calls.every(p => p.url.startsWith('data:image/png;base64,')));
  assert.deepEqual(app.encodes.map(p => p.x), [0, 4096, 8192]);
  assert.equal(app.sourceCloses, 1);
});
