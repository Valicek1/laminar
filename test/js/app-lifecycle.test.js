const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const appPath = path.join(__dirname, '../../src/resources/js/app.js');
const appSource = fs.readFileSync(appPath, 'utf8');
const progressMixinSource = appSource.slice(0, appSource.indexOf('// Utility methods'));

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
