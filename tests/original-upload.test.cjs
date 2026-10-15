const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { test } = require('node:test');
const source = fs.readFileSync(require('node:path').join(__dirname, '../app.js'), 'utf8');

// Exercise the actual import handler with a fake SDK. This does not prove Miro's server limit.
function setup(files, rejectUpload = false) {
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
  const board = {
    viewport: { get: async () => ({ x: 0, y: 0, width: 1000, height: 1000 }), zoomTo: async () => {} },
    notifications: { showError: async () => {}, showWarning: async () => {}, showInfo: async () => {} },
    createImage: async params => {
      calls.push(params);
      if (rejectUpload) throw Object.assign(new Error('Maximum upload size exceeded'), { code: 'invalidParameters', status: 400 });
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
    performance, setTimeout: fn => setTimeout(fn, 0),
    console: { log() {}, warn() {}, error() {}, groupCollapsed() {}, groupEnd() {}, table() {} },
  });
  vm.runInContext(source, context);
  return { calls, el, run: () => context.handleStitchSubmit({ preventDefault() {} }) };
}

function fixture(size = 28_000_000, name = 'Tile_1.jpg') {
  const bytes = Buffer.alloc(size, 0xa5);
  return { name, type: 'image/jpeg', width: 4096, height: 4096, size, bytes };
}

test('28 MB original is sent once, unchanged, at full size; grid spacing is preserved', async () => {
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
  assert.equal(report.uploads[0].fileBytes, 28_000_000);
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
