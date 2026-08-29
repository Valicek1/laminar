(function(global) {
  const RECENT_RUN_LIMIT = 30;

  function prependRecentRun(recentRuns, run) {
    recentRuns.unshift(run);
    recentRuns.splice(RECENT_RUN_LIMIT);
  }

  const api = {
    prependRecentRun: prependRecentRun,
  };

  global.LaminarAppState = api;

  if(typeof module !== 'undefined' && module.exports)
    module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
