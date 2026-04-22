const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createAutoScrollController,
  createAutoScrollPreference,
  resolveAutoScrollControllerFactory,
} = require('../../src/resources/js/logview.js');

const createElement = ({ scrollTop = 0, clientHeight = 120, scrollHeight = 400 } = {}) => ({
  scrollTop,
  clientHeight,
  scrollHeight,
});

test('autoscroll is disabled by default', () => {
  const element = createElement();
  const controller = createAutoScrollController(element);

  controller.onContentAppended();

  assert.equal(controller.isEnabled(), false);
  assert.equal(element.scrollTop, 0);
});

test('enabling autoscroll jumps to the bottom immediately', () => {
  const element = createElement({ scrollTop: 10, scrollHeight: 640 });
  const controller = createAutoScrollController(element);

  controller.setEnabled(true);

  assert.equal(controller.isEnabled(), true);
  assert.equal(element.scrollTop, 640);
});

test('new content keeps the log pinned to the bottom while enabled', () => {
  const element = createElement({ scrollTop: 0, scrollHeight: 400 });
  const controller = createAutoScrollController(element, { enabled: true });

  element.scrollHeight = 980;
  controller.onContentAppended();

  assert.equal(element.scrollTop, 980);
});

test('falls back to a safe controller when logview helper is unavailable', () => {
  const element = createElement({ scrollTop: 12, scrollHeight: 720 });
  const factory = resolveAutoScrollControllerFactory({});
  const controller = factory(element);

  assert.equal(controller.setEnabled(true), true);
  controller.onContentAppended();
  assert.equal(element.scrollTop, 720);
});

test('autoscroll can drive a separate page scroll target', () => {
  const element = createElement({ scrollTop: 0, scrollHeight: 640 });
  const scrollTarget = createElement({ scrollTop: 25, scrollHeight: 2048 });
  const controller = createAutoScrollController(element, {
    enabled: true,
    scrollTarget,
  });

  controller.onContentAppended();

  assert.equal(element.scrollTop, 0);
  assert.equal(scrollTarget.scrollTop, 2048);
});

test('autoscroll uses scrollTo when the target provides it', () => {
  const element = createElement({ scrollHeight: 640 });
  const calls = [];
  const scrollTarget = {
    scrollTop: 0,
    scrollHeight: 0,
    scrollTo: function(x, y) {
      calls.push([x, y]);
      this.scrollTop = y;
    },
  };
  const scrollHeightSource = createElement({ scrollHeight: 4096 });
  const controller = createAutoScrollController(element, {
    enabled: true,
    scrollTarget,
    scrollHeightSource,
  });

  controller.onContentAppended();

  assert.deepEqual(calls, [[0, 4096]]);
  assert.equal(scrollTarget.scrollTop, 4096);
});

test('autoscroll emits debug logging when it appends content', () => {
  const element = createElement({ scrollHeight: 320 });
  const events = [];
  const controller = createAutoScrollController(element, {
    enabled: true,
    logger: {
      debug: function(message, details) {
        events.push({ message, details });
      },
    },
  });

  controller.onContentAppended();

  assert.equal(events.length > 0, true);
  assert.equal(events[0].message, 'Laminar log autoscroll update');
});

test('autoscroll preference persists enabled state', () => {
  const store = {
    data: {},
    getItem: function(key) {
      return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : null;
    },
    setItem: function(key, value) {
      this.data[key] = String(value);
    },
  };

  const preference = createAutoScrollPreference(store, 'laminar.test.autoscroll');

  assert.equal(preference.load(false), false);
  preference.save(true);
  assert.equal(preference.load(false), true);
  preference.save(false);
  assert.equal(preference.load(true), false);
});
