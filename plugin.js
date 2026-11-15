// Compact Time Tracker – background part.
//
// Records the from–to entries and stores them with persistDataSynced.
// Storage: one key per logical day and app session, "seg-<YYYY-MM-DD>-<session>",
// content {"v":1,"segs":[{id,taskId,start,end,seen,base}]}.
//   - end:  null while the entry is running
//   - seen: time of the last checkpoint of a running entry
//   - base: the task's timeSpentOnDay for that day at start (used to reconcile idle time)
// Separate keys per session keep devices from overwriting each other's entries
// when syncing (last write wins per key).
//
// timeSpentOnDay is the source of truth. This part never changes it; it only
// persists the running time once a minute (see checkpoint).
(function () {
  'use strict';
  var MIN = 60000;
  var CHECKPOINT_MS = 60000;
  var STALE_MS = 150000; // no checkpoint for longer than this: the entry is considered finished
  var SESSION = Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 6);

  var state = { day: null, offset: 0, running: null }; // running: {key, seg}

  function pad(n) { return String(n).padStart(2, '0'); }
  function localDay(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dayOf(ts) { return localDay(ts - (state.offset || 0)); }
  function keyFor(day) { return 'seg-' + day + '-' + SESSION; }
  function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  // ---- Storage: always read fresh, modify, write ----
  function parse(str) {
    try { var o = JSON.parse(str || ''); return o && Array.isArray(o.segs) ? o : { v: 1, segs: [] }; }
    catch (e) { return { v: 1, segs: [] }; }
  }
  var queue = Promise.resolve();
  function modify(key, fn) {
    // run this part's writes one after another
    queue = queue.then(function () {
      return PluginAPI.loadSyncedData(key).then(function (str) {
        var data = parse(str);
        fn(data);
        return PluginAPI.persistDataSynced(data.segs.length ? JSON.stringify(data) : '', key);
      });
    }).catch(function (e) { console.warn('[compact-time-tracker] saving failed', e); });
    return queue;
  }
  function upsert(key, seg) {
    return modify(key, function (data) {
      var i = data.segs.findIndex(function (x) { return x.id === seg.id; });
      var copy = { id: seg.id, taskId: seg.taskId, start: seg.start, end: seg.end, seen: seg.seen, base: seg.base };
      if (i >= 0) data.segs[i] = copy; else data.segs.push(copy);
    });
  }

  // ---- Recording ----
  function closeRunning(now, snapshotTask) {
    var r = state.running;
    state.running = null;
    if (!r) return Promise.resolve();
    var seg = r.seg;
    seg.end = now; seg.seen = now;
    // Reconcile: if Super Productivity tracked less than the wall-clock duration (idle time
    // discarded), move the end earlier. timeSpentOnDay is left untouched.
    function reconcile(t) {
      if (!t || seg.base == null) return;
      var actual = ((t.timeSpentOnDay || {})[r.day] || 0) - seg.base;
      if (actual >= 0 && actual < (seg.end - seg.start) - MIN) seg.end = seg.start + actual;
    }
    var p = snapshotTask && snapshotTask.id === seg.taskId
      ? Promise.resolve(reconcile(snapshotTask))
      : PluginAPI.getTasks().then(function (ts) { reconcile(ts.find(function (x) { return x.id === seg.taskId; })); }, function () {});
    return p.then(function () { return upsert(r.key, seg); });
  }

  function openSeg(task, now) {
    var day = state.day || dayOf(now);
    var seg = { id: newId(), taskId: task.id, start: now, end: null, seen: now,
      base: ((task.timeSpentOnDay || {})[day]) || 0 };
    state.running = { key: keyFor(day), day: day, seg: seg };
    return upsert(state.running.key, seg);
  }

  function onCurrentTaskChange(payload) {
    var now = Date.now();
    var current = payload && payload.current;
    var r = state.running;
    if (r && current && r.seg.taskId === current.id) return;
    closeRunning(now, payload && payload.previous);
    if (current && current.id) openSeg(current, now);
  }

  function onDayChange(newDay) {
    if (!newDay || newDay === state.day) return;
    state.day = newDay;
    var r = state.running;
    if (!r) return;
    var now = Date.now();
    closeRunning(now, null);
    openSeg({ id: r.seg.taskId, timeSpentOnDay: {} }, now);
  }

  // ---- Checkpoint ----
  // 1. timeSpentOnDay: Super Productivity persists running time only every 5 minutes or on stop.
  //    updateTask with timeSpentOnDay first persists this task's pending time
  //    (TaskService.update → flushOne). Read and write back to back, value unchanged.
  // 2. Running entry: update "seen" so that it ends cleanly after a crash.
  var busy = false;
  function checkpoint() {
    var r = state.running;
    if (!r || busy) return Promise.resolve();
    busy = true;
    var now = Date.now();
    r.seg.seen = now;
    return PluginAPI.getTasks().then(function (tasks) {
      var t = tasks.find(function (x) { return x.id === r.seg.taskId; });
      if (!t || !t.timeSpentOnDay) return;
      var map = {};
      Object.keys(t.timeSpentOnDay).forEach(function (k) { map[k] = t.timeSpentOnDay[k]; });
      return PluginAPI.updateTask(t.id, { timeSpentOnDay: map });
    }).catch(function () {}).then(function () {
      if (state.running === r) return upsert(r.key, r.seg);
    }).then(function () { busy = false; }, function () { busy = false; });
  }

  // ---- After a restart: finish open entries without a recent checkpoint ----
  // End = last checkpoint; up to that point the time is also persisted in timeSpentOnDay.
  function closeStale() {
    var now = Date.now();
    var days = [0, 1, 2].map(function (n) { return dayOf(now - n * 86400000); });
    return Promise.all(days.map(function (d) { return PluginAPI.listSyncedDataKeys('seg-' + d + '-'); }))
      .then(function (lists) {
        var keys = [].concat.apply([], lists);
        return Promise.all(keys.map(function (key) {
          return PluginAPI.loadSyncedData(key).then(function (str) {
            var stale = parse(str).segs.some(function (s) {
              return s.end == null && now - (s.seen || s.start) > STALE_MS;
            });
            if (!stale) return;
            return modify(key, function (data) {
              data.segs.forEach(function (s) {
                if (s.end == null && now - (s.seen || s.start) > STALE_MS) s.end = Math.max(s.start, s.seen || s.start);
              });
            });
          });
        }));
      }).catch(function () {});
  }

  // Start of the logical day: via getDayContext from version 20, from the config before that
  function offsetFromConfig(gc) {
    var misc = (gc && gc.misc) || {};
    if (typeof misc.startOfNextDayTime === 'string' && /^\d{1,2}:\d{2}$/.test(misc.startOfNextDayTime)) {
      var p = misc.startOfNextDayTime.split(':');
      return (+p[0]) * 3600000 + (+p[1]) * 60000;
    }
    return (+misc.startOfNextDay || 0) * 3600000;
  }
  function initDay() {
    if (typeof PluginAPI.getDayContext === 'function') {
      return PluginAPI.getDayContext().then(function (ctx) {
        state.offset = (ctx && ctx.startOfNextDayDiffMs) || 0;
        state.day = (ctx && ctx.todayStr) || dayOf(Date.now());
      });
    }
    return PluginAPI.getAppState().then(function (st) {
      state.offset = offsetFromConfig(st && st.globalConfig);
      state.day = dayOf(Date.now());
    });
  }

  PluginAPI.registerHook(PluginAPI.Hooks.CURRENT_TASK_CHANGE, onCurrentTaskChange);
  if (PluginAPI.Hooks.DAY_CHANGE) {
    PluginAPI.registerHook(PluginAPI.Hooks.DAY_CHANGE, function (p) { onDayChange(p && p.todayStr); });
  }

  async function start() {
    try { await initDay(); } catch (e) { state.day = dayOf(Date.now()); }
    await closeStale();
    setInterval(checkpoint, CHECKPOINT_MS);
    // Without the DAY_CHANGE hook (before version 20), check for a day change every minute
    setInterval(function () { var d = dayOf(Date.now()); if (state.day && d !== state.day) onDayChange(d); }, MIN);
  }

  // onReady is optional in the PluginAPI types (onReady?): feature-detect it and
  // start right away on hosts that do not provide it.
  if (typeof PluginAPI.onReady === 'function') {
    PluginAPI.onReady(start);
  } else {
    Promise.resolve().then(start).catch(function (e) {
      console.warn('[compact-time-tracker] start failed', e);
    });
  }
})();
