const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { createChartLifecycle } = require('../../src/resources/js/app-state.js');

const appPath = path.join(__dirname, '../../src/resources/js/app.js');
const appSource = fs.readFileSync(appPath, 'utf8');
const progressMixinSource = appSource.slice(0, appSource.indexOf('// Utility methods'));
const chartComponentsSource = appSource.slice(
  appSource.indexOf('const Home ='),
  appSource.indexOf('// Component for the /job/:name/:number endpoint')
);
const runComponentSource = appSource.slice(
  appSource.indexOf('const Run ='),
  appSource.indexOf("Vue.component('RouterLink'")
);

function loadChartComponents(charts) {
  const context = {
    Charts: charts,
    window: {
      LaminarAppState: {
        createChartLifecycle: createChartLifecycle,
      },
    },
  };
  vm.runInNewContext(
    chartComponentsSource + '\n;globalThis.HomeComponent = Home; globalThis.JobComponent = Job;',
    context
  );
  return context;
}

function createComponentInstance(definition) {
  const nextTicks = [];
  const instance = {
    $forceUpdate: () => {},
    $nextTick: callback => nextTicks.push(callback),
  };
  if(definition.created)
    definition.created.call(instance);
  return { instance: instance, nextTicks: nextTicks };
}

function loadRunComponent(overrides = {}) {
  const codeElement = overrides.codeElement || {
    innerHTML: '',
    insertAdjacentHTML: () => {},
  };
  const context = {
    AbortController: AbortController,
    AnsiUp: class {
      ansi_to_html(text) {
        return text;
      }
    },
    Date: Date,
    TextDecoder: TextDecoder,
    clearTimeout: overrides.clearTimeout || (() => {}),
    console: overrides.console || { debug: () => {}, error: () => {} },
    document: {
      body: {},
      documentElement: { scrollHeight: 100 },
      getElementsByClassName: () => [],
      getElementsByTagName: () => [codeElement],
      scrollingElement: null,
    },
    fetch: overrides.fetch,
    setTimeout: overrides.setTimeout || setTimeout,
    window: {
      LaminarLogView: null,
      addEventListener: () => {},
      innerHeight: 100,
      localStorage: {},
      scrollTo: () => {},
      scrollY: 0,
    },
  };
  vm.runInNewContext(
    runComponentSource + '\n;globalThis.RunComponent = Run;',
    context
  );
  return {
    codeElement: codeElement,
    definition: context.RunComponent('#run'),
  };
}

function createRunInstance(definition) {
  return {
    $forceUpdate: () => {},
    _props: { route: { params: { name: 'build', number: '42' } } },
    ensureAutoScrollController: definition.methods.ensureAutoScrollController,
  };
}

function jobStatus() {
  return {
    averageRuntime: 30,
    description: '',
    lastFailed: null,
    lastSuccess: null,
    pages: 1,
    queued: [],
    recent: [],
    running: [],
    sort: { field: 'number', order: 'dsc', page: 0 },
  };
}

function homeStatus() {
  return {
    buildTimeChanges: [],
    buildsPerDay: [],
    buildsPerJob: {},
    completedCounts: {},
    executorsBusy: 0,
    executorsTotal: 1,
    lowPassRates: [],
    queued: [],
    recent: [],
    resultChanged: [],
    running: [],
    timePerJob: {},
    timePerJobCounts: {},
  };
}

test('destroying a component clears its own progress timer', () => {
  const mixins = [];
  const clearedTimers = [];
  const context = {
    clearInterval: timer => clearedTimers.push(timer),
    Vue: {
      filter: () => {},
      mixin: definition => mixins.push(definition),
    },
  };

  vm.runInNewContext(progressMixinSource, context);
  assert.equal(mixins.length, 1);

  mixins[0].beforeDestroy.call({ updateTimer: 1385 });

  assert.deepEqual(clearedTimers, [1385]);
});

test('leaving a job page destroys its runtime chart', () => {
  let destroyCount = 0;
  const context = loadChartComponents({
    createRunTimeChart: () => ({
      destroy: () => destroyCount++,
    }),
  });
  const definition = context.JobComponent('#job');
  const component = createComponentInstance(definition);

  definition.methods.status.call(component.instance, jobStatus());
  component.nextTicks.shift()();
  definition.beforeDestroy.call(component.instance);

  assert.equal(destroyCount, 1);
});

test('destroyed home page ignores deferred chart creation', () => {
  const createdCharts = [];
  const createChart = name => () => {
    createdCharts.push(name);
    return { destroy: () => {} };
  };
  const context = loadChartComponents({
    createExecutorUtilizationChart: createChart('utilization'),
    createRunsPerDayChart: createChart('buildsPerDay'),
    createRunsPerJobChart: createChart('buildsPerJob'),
    createTimePerJobChart: createChart('timePerJob'),
    createRunTimeChangesChart: createChart('buildTimeChanges'),
  });
  const definition = context.HomeComponent('#home');
  const component = createComponentInstance(definition);

  definition.methods.status.call(component.instance, homeStatus());
  definition.beforeDestroy.call(component.instance);
  component.nextTicks.shift()();

  assert.deepEqual(createdCharts, []);
});

test('destroyed job page ignores deferred chart creation', () => {
  let createCount = 0;
  const context = loadChartComponents({
    createRunTimeChart: () => {
      createCount++;
      return { destroy: () => {} };
    },
  });
  const definition = context.JobComponent('#job');
  const component = createComponentInstance(definition);

  definition.methods.status.call(component.instance, jobStatus());
  definition.beforeDestroy.call(component.instance);
  component.nextTicks.shift()();

  assert.equal(createCount, 0);
});

test('leaving a run page cancels its pending log render', async () => {
  const pendingTimers = new Map();
  const clearedTimers = [];
  const insertedHtml = [];
  let nextTimer = 1;
  let fetchSignal;
  let readCount = 0;
  const component = loadRunComponent({
    codeElement: {
      innerHTML: '',
      insertAdjacentHTML: (position, html) => insertedHtml.push([position, html]),
    },
    clearTimeout: timer => {
      clearedTimers.push(timer);
      pendingTimers.delete(timer);
    },
    fetch: (url, options) => {
      fetchSignal = options.signal;
      return Promise.resolve({
        body: {
          getReader: () => ({
            read: () => {
              readCount++;
              if(readCount === 1)
                return Promise.resolve({ done: false, value: new Uint8Array([108, 111, 103]) });
              return new Promise(() => {});
            },
          }),
        },
      });
    },
    setTimeout: callback => {
      const timer = nextTimer++;
      pendingTimers.set(timer, callback);
      return timer;
    },
  });
  const instance = createRunInstance(component.definition);

  component.definition.methods.status.call(instance, { latestNum: 42, started: 1 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(pendingTimers.size, 1);
  assert.equal(typeof component.definition.beforeDestroy, 'function');
  const staleRender = pendingTimers.values().next().value;
  component.definition.beforeDestroy.call(instance);

  assert.equal(fetchSignal.aborted, true);
  assert.deepEqual(clearedTimers, [1]);
  assert.equal(instance.logstream, null);
  staleRender();
  assert.deepEqual(insertedHtml, []);
});

test('leaving a run page cancels its pending final log render', async () => {
  const pendingTimers = new Map();
  const clearedTimers = [];
  let nextTimer = 1;
  const component = loadRunComponent({
    clearTimeout: timer => {
      clearedTimers.push(timer);
      pendingTimers.delete(timer);
    },
    fetch: () => Promise.resolve({
      body: {
        getReader: () => ({
          read: () => Promise.resolve({ done: true }),
        }),
      },
    }),
    setTimeout: callback => {
      const timer = nextTimer++;
      pendingTimers.set(timer, callback);
      return timer;
    },
  });
  const instance = createRunInstance(component.definition);

  component.definition.methods.status.call(instance, { latestNum: 42, started: 1 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(pendingTimers.size, 1);
  component.definition.beforeDestroy.call(instance);

  assert.deepEqual(clearedTimers, [1]);
  assert.equal(pendingTimers.size, 0);
});

test('leaving a run page does not report its expected fetch abort', async () => {
  const errors = [];
  const component = loadRunComponent({
    console: {
      debug: () => {},
      error: (...args) => errors.push(args),
    },
    fetch: (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => {
        const error = new Error('The operation was aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }),
  });
  const instance = createRunInstance(component.definition);

  component.definition.methods.status.call(instance, { latestNum: 42, started: 1 });
  component.definition.beforeDestroy.call(instance);
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(errors, []);
});

test('an unsolicited log fetch abort is still reported', async () => {
  const errors = [];
  const error = new Error('The response body was aborted');
  error.name = 'AbortError';
  const component = loadRunComponent({
    console: {
      debug: () => {},
      error: (...args) => errors.push(args),
    },
    fetch: () => Promise.reject(error),
  });
  const instance = createRunInstance(component.definition);

  component.definition.methods.status.call(instance, { latestNum: 42, started: 1 });
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(errors.length, 1);
  assert.equal(errors[0][0], '[Laminar][logstream] failed');
  assert.equal(errors[0][1], error);
});
