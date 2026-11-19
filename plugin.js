// Compact Time Tracker – background part.
//
// Records the from–to entries and stores them with persistDataSynced.
// Storage: one key per entry, "seg-<YYYY-MM-DD>-<entryId>" (logical day),
// content {"v":2,"seg":{id,taskId,start,end,seen,base,dev}}.
//   - end:  null while the entry is running
//   - seen: time of the last checkpoint of a running entry
//   - base: the task's timeSpentOnDay for that day at start (used to reconcile idle time)
//   - dev:  id of the device that recorded the entry (kept with setSecret, which is local-only)
// One key per entry means every key has a single writer at a time: this part writes
// only the running entry, the page only finished ones. No read-modify-write races,
// and devices never overwrite each other's entries when syncing (last write wins per key).
// Keys of version 1.0.x ("seg-<day>-<session>" with {"v":1,"segs":[...]}) are migrated on start.
//
// timeSpentOnDay is the source of truth. This part never changes it; it only
// persists the running time once a minute (see checkpoint).
(function () {
  'use strict';
  var MIN = 60000;
  var CHECKPOINT_MS = 60000;
  // An open entry without a checkpoint for this long is finished at its last checkpoint.
  // Generous on purpose: another device's checkpoints arrive only with sync.
  var CLOSE_STALE_MS = 15 * MIN;

  var state = { day: null, offset: 0, running: null, device: null }; // running: {key, day, seg}

  function pad(n) { return String(n).padStart(2, '0'); }
  function localDay(ts) { var d = new Date(ts); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function dayOf(ts) { return localDay(ts - (state.offset || 0)); }
  function keyFor(day, id) { return 'seg-' + day + '-' + id; }
  function newId() { return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function plain(s) { return { id: s.id, taskId: s.taskId, start: s.start, end: s.end, seen: s.seen, base: s.base, dev: s.dev }; }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Device id: stored with setSecret, which is local to this device and never synced.
  // Without it (older hosts) a random id per app session is used.
  function initDevice() {
    var fallback = 'd' + Math.random().toString(36).slice(2, 10);
    if (typeof PluginAPI.getSecret !== 'function') { state.device = fallback; return Promise.resolve(); }
    return PluginAPI.getSecret('device-id').then(function (id) {
      if (id) { state.device = id; return; }
      state.device = fallback;
      return PluginAPI.setSecret('device-id', fallback);
    }).catch(function () { state.device = state.device || fallback; });
  }

  // ---- Storage ----
  function parse(str) {
    try {
      var o = JSON.parse(str || '');
      if (o && o.seg) return [o.seg];
      if (o && Array.isArray(o.segs)) return o.segs;
    } catch (e) { /* ignore broken entries */ }
    return [];
  }
  var queue = Promise.resolve();
  function enqueue(fn) {
    // run this part's writes one after another
    queue = queue.then(fn).catch(function (e) { console.warn('[compact-time-tracker] saving failed', e); });
    return queue;
  }
  function writeSeg(key, seg) {
    var data = JSON.stringify({ v: 2, seg: plain(seg) });
    return enqueue(function () { return PluginAPI.persistDataSynced(data, key); });
  }

  // ---- Entries under one minute are discarded, together with their tracked time ----
  // (e.g. an accidental start or a quick switch). Not applied to the split at midnight.
  function removeTracked(taskId, day, amount) {
    if (!(amount > 0)) return Promise.resolve();
    return enqueue(function () {
      return PluginAPI.getTasks().then(function (tasks) {
        var t = tasks.find(function (x) { return x.id === taskId; });
        if (!t) return;
        var map = {};
        Object.keys(t.timeSpentOnDay || {}).forEach(function (k) { map[k] = t.timeSpentOnDay[k]; });
        var v = Math.max(0, (map[day] || 0) - amount);
        if (v > 0) map[day] = v; else delete map[day];
        return PluginAPI.updateTask(taskId, { timeSpentOnDay: map });
      });
    });
  }
  function discard(key, seg, day, amount) {
    enqueue(function () { return PluginAPI.persistDataSynced('', key); });
    return removeTracked(seg.taskId, day, amount);
  }

  // ---- Recording ----
  function closeRunning(now, snapshotTask, keepShort) {
    var r = state.running;
    state.running = null;
    if (!r) return Promise.resolve();
    var seg = r.seg;
    seg.end = now; seg.seen = now;
    // Stopped because of inactivity: the entry ends where the inactivity began
    if (idle && idle.start > seg.start && idle.start < now) seg.end = idle.start;
    // Reconcile: if Super Productivity tracked less than the wall-clock duration (idle time
    // discarded), move the end earlier. timeSpentOnDay is left untouched.
    var tracked = null; // time Super Productivity booked for this run
    function reconcile(t) {
      if (!t || seg.base == null) return;
      var actual = ((t.timeSpentOnDay || {})[r.day] || 0) - seg.base;
      if (actual >= 0) tracked = actual;
      if (actual >= 0 && actual < (seg.end - seg.start) - MIN) seg.end = seg.start + actual;
    }
    // Write the end right away, then again if reconciling moves it
    var endBefore = seg.end;
    writeSeg(r.key, seg);
    var p = snapshotTask && snapshotTask.id === seg.taskId
      ? Promise.resolve(reconcile(snapshotTask))
      : PluginAPI.getTasks().then(function (ts) { reconcile(ts.find(function (x) { return x.id === seg.taskId; })); }, function () {});
    return p.then(function () {
      var dur = seg.end - seg.start;
      if (!keepShort && dur < MIN) return discard(r.key, seg, r.day, tracked != null ? Math.min(tracked, MIN) : dur);
      if (seg.end !== endBefore) return writeSeg(r.key, seg);
    });
  }

  function openSeg(task, now) {
    var day = state.day || dayOf(now);
    var seg = { id: newId(), taskId: task.id, start: now, end: null, seen: now,
      base: ((task.timeSpentOnDay || {})[day]) || 0, dev: state.device };
    state.running = { key: keyFor(day, seg.id), day: day, seg: seg };
    return writeSeg(state.running.key, seg);
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
    closeRunning(now, null, true);
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
    return PluginAPI.getTasks().then(function (tasks) {
      var t = tasks.find(function (x) { return x.id === r.seg.taskId; });
      if (!t || !t.timeSpentOnDay) return;
      var map = {};
      Object.keys(t.timeSpentOnDay).forEach(function (k) { map[k] = t.timeSpentOnDay[k]; });
      return PluginAPI.updateTask(t.id, { timeSpentOnDay: map });
    }).catch(function () {}).then(function () {
      if (state.running === r) { r.seg.seen = Date.now(); r.seg.dev = r.seg.dev || state.device; return writeSeg(r.key, r.seg); }
    }).then(function () { busy = false; }, function () { busy = false; });
  }

  // ---- Housekeeping: migrate 1.0.x keys, finish open entries without checkpoints ----
  // An open entry that is not this device's running entry and has had no checkpoint for
  // CLOSE_STALE_MS ends at its last checkpoint; up to then its time is persisted in timeSpentOnDay.
  // On start all keys are checked (migration); afterwards only the last three days.
  function housekeeping(all) {
    var now = Date.now();
    var runningId = state.running && state.running.seg.id;
    function isStale(s) { return s.end == null && s.id !== runningId && now - (s.seen || s.start) > CLOSE_STALE_MS; }
    var listing = all === true
      ? PluginAPI.listSyncedDataKeys('seg-')
      : Promise.all([0, 1, 2].map(function (n) {
          return PluginAPI.listSyncedDataKeys('seg-' + dayOf(now - n * 86400000) + '-');
        })).then(function (lists) { return [].concat.apply([], lists); });
    return listing.then(function (keys) {
      return keys.reduce(function (p, key) {
        return p.then(function () {
          return PluginAPI.loadSyncedData(key).then(function (str) {
            var o; try { o = JSON.parse(str || ''); } catch (e) { o = null; }
            var day = key.slice(4, 14);
            if (o && Array.isArray(o.segs)) {
              // 1.0.x: several entries per key → one key per entry, then clear the old key
              return o.segs.reduce(function (q, s) {
                if (isStale(s)) s.end = Math.max(s.start, s.seen || s.start);
                return q.then(function () { return writeSeg(keyFor(day, s.id), s); });
              }, Promise.resolve()).then(function () {
                return enqueue(function () { return PluginAPI.persistDataSynced('', key); });
              });
            }
            var s = o && o.seg;
            if (s && isStale(s)) {
              s.end = Math.max(s.start, s.seen || s.start);
              return writeSeg(key, s);
            }
          });
        });
      }, Promise.resolve());
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

  // ---- Inactivity ----
  // After a period of inactivity Super Productivity stops the timer, removes the idle time and
  // asks in a dialog how to book it. The booked time arrives in one block, so on its own it would
  // show as "no time of day". The ACTION hook reports the steps (same action types in 19.3 and 20):
  //   [Idle] Trigger Idle {idleTime}      inactivity began idleTime ms ago
  //   [Idle] Dialog result                the user confirmed the dialog
  //   [TimeTracking] Sync time spent      time booked on an existing task {taskId, date, duration}
  //   [Task Shared] addTask               a new task created in the dialog, with its time
  //   [Idle] Reset                        done
  // Between "Dialog result" and "Reset" every booking becomes an entry, one after another,
  // starting where the inactivity began. timeSpentOnDay is not touched; the entries only add the
  // time of day to what Super Productivity booked.
  var idle = null; // {start, booking, cursor}
  function addIdleEntry(taskId, day, duration) {
    if (!idle || !idle.booking || !taskId || !(duration > 0)) return;
    var seg = { id: newId(), taskId: taskId, start: idle.cursor, end: idle.cursor + duration,
      seen: idle.cursor + duration, base: null, dev: state.device };
    idle.cursor = seg.end;
    var d = day || dayOf(seg.start);
    // under one minute: no entry, and the booking is taken back
    if (duration < MIN) { removeTracked(taskId, d, duration); return; }
    writeSeg(keyFor(d, seg.id), seg);
  }
  function onAction(payload) {
    var a = payload && payload.action;
    if (!a || typeof a.type !== 'string') return;
    switch (a.type) {
      case '[Idle] Trigger Idle':
        idle = { start: Date.now() - (+a.idleTime || 0), booking: false, cursor: 0 };
        break;
      case '[Idle] Dialog result':
        if (idle) { idle.booking = true; idle.cursor = idle.start; }
        break;
      case '[TimeTracking] Sync time spent':
        addIdleEntry(a.taskId, a.date, +a.duration);
        break;
      case '[Task Shared] addTask':
        if (a.task && a.task.timeSpentOnDay) {
          Object.keys(a.task.timeSpentOnDay).forEach(function (d) {
            addIdleEntry(a.task.id, d, +a.task.timeSpentOnDay[d]);
          });
        }
        break;
      case '[Idle] Reset':
        idle = null;
        break;
    }
  }
  if (PluginAPI.Hooks.ACTION) PluginAPI.registerHook(PluginAPI.Hooks.ACTION, onAction);

  PluginAPI.registerHook(PluginAPI.Hooks.CURRENT_TASK_CHANGE, onCurrentTaskChange);
  if (PluginAPI.Hooks.DAY_CHANGE) {
    PluginAPI.registerHook(PluginAPI.Hooks.DAY_CHANGE, function (p) { onDayChange(p && p.todayStr); });
  }

  // ---- On start: no timer survives an app restart ----
  // Super Productivity resets the current task when it loads, so after a restart nothing is
  // tracking. Open entries recorded on this device are finished at their last checkpoint.
  // Exception: the plugin itself was reloaded while a timer kept running (update, disable/enable).
  // A running timer is detected by its task's timeSpentOnDay growing; its open entry is
  // continued (or a new one started).
  function todayMap(tasks, day) {
    var m = {};
    tasks.forEach(function (t) { m[t.id] = ((t.timeSpentOnDay || {})[day]) || 0; });
    return m;
  }
  async function recoverOwnEntries() {
    var day = state.day || dayOf(Date.now());
    var before = todayMap(await PluginAPI.getTasks(), day);
    await sleep(1600);
    var tasks = await PluginAPI.getTasks();
    var after = todayMap(tasks, day);
    var growing = Object.keys(after).find(function (id) { return after[id] - (before[id] || 0) >= 900; }) || null;

    var now = Date.now();
    var lists = await Promise.all([0, 1, 2].map(function (n) {
      return PluginAPI.listSyncedDataKeys('seg-' + dayOf(now - n * 86400000) + '-');
    }));
    var keys = [].concat.apply([], lists);
    var open = [];
    for (var i = 0; i < keys.length; i++) {
      parse(await PluginAPI.loadSyncedData(keys[i])).forEach(function (s) {
        // own entries, and entries from builds before the device id existed
        if (s.end == null && (!s.dev || s.dev === state.device)) open.push({ key: keys[i], day: keys[i].slice(4, 14), seg: s });
      });
    }
    open.sort(function (a, b) { return b.seg.start - a.seg.start; });

    if (growing && !state.running) {
      var mine = open.find(function (o) { return o.seg.taskId === growing; });
      if (mine) { mine.seg.dev = state.device; state.running = mine; }
      else openSeg(tasks.find(function (t) { return t.id === growing; }), Date.now());
    }
    var runningId = state.running && state.running.seg.id;
    open.forEach(function (o) {
      if (o.seg.id === runningId) return;
      o.seg.end = Math.max(o.seg.start, o.seg.seen || o.seg.start);
      if (o.seg.end - o.seg.start < MIN) discard(o.key, o.seg, o.day, o.seg.end - o.seg.start);
      else writeSeg(o.key, o.seg);
    });
  }

  async function start() {
    try { await initDay(); } catch (e) { state.day = dayOf(Date.now()); }
    await initDevice();
    await housekeeping(true);
    try { await recoverOwnEntries(); } catch (e) { console.warn('[compact-time-tracker] recovery failed', e); }
    setInterval(checkpoint, CHECKPOINT_MS);
    setInterval(housekeeping, CLOSE_STALE_MS);
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
