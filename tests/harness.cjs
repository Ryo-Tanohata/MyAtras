'use strict';
// Minimal DOM and network stand-ins so the browser modules can be exercised in node.
// Nothing here fakes observation content: tests supply the bytes they expect back.

class FakeElement {
  constructor(id) {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
    this.checked = false;
    this.attributes = {};
    this.listeners = {};
  }
  addEventListener(type, handler) {
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  }
  removeEventListener(type, handler) {
    this.listeners[type] = (this.listeners[type] || []).filter(h => h !== handler);
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  removeAttribute(name) { delete this.attributes[name]; }
  dispatch(type) { for (const h of this.listeners[type] || []) h({ target: this }); }
}

function makeDocument(ids) {
  const elements = new Map(ids.map(id => [id, new FakeElement(id)]));
  return {
    hidden: false,
    elements,
    getElementById(id) { return elements.get(id); },
    addEventListener() {},
    removeEventListener() {}
  };
}

// A 1x1 PNG. Used only so image decoding has real bytes to accept.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

function install(ids) {
  const document = makeDocument(ids);
  const loads = [];
  global.document = document;
  global.window = global;
  // The cloud model asks whether motion is reduced before it starts playing.
  global.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  global.Image = class {
    constructor() { this.width = 512; this.height = 512; }
    set src(value) {
      this._src = value;
      setTimeout(() => (this.onload ? this.onload() : null), 0);
    }
    get src() { return this._src; }
  };
  global.URL.createObjectURL = () => 'blob:observation';
  global.URL.revokeObjectURL = () => {};
  const responses = new Map();
  global.fetch = async (url) => {
    loads.push(String(url));
    const reply = [...responses.entries()].find(([pattern]) => String(url).includes(pattern));
    if (!reply) throw Error('no stubbed response for ' + url);
    const body = reply[1];
    if (body instanceof Error) throw body;
    if (typeof body === 'string') {
      const blob = { type: 'application/json', async text() { return body; } };
      return { ok: true, status: 200, async text() { return body; }, async blob() { return blob; } };
    }
    return { ok: true, status: 200, async blob() { return { type: 'image/png', size: PNG.length }; } };
  };
  return { document, loads, responses, reset() { loads.length = 0; } };
}

// Tiny runner: every check prints, the process exits non-zero on the first failure.
function suite(name) {
  const tests = [];
  return {
    test(label, fn) { tests.push([label, fn]); },
    async run() {
      console.log(name);
      let failed = 0;
      for (const [label, fn] of tests) {
        try {
          await fn();
          console.log('  ok   ' + label);
        } catch (error) {
          failed++;
          console.log('  FAIL ' + label);
          console.log('       ' + (error && error.message));
          if (process.env.STACK) console.log(error.stack);
        }
      }
      console.log(failed ? failed + ' failed' : String(tests.length) + ' passed');
      if (failed) process.exitCode = 1;
    }
  };
}

module.exports = { FakeElement, install, suite, PNG };
