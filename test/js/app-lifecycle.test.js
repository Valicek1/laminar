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
