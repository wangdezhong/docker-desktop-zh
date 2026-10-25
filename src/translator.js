/* Docker Desktop 中文汉化运行时 (dd-zh)
 * 以内联 <script> 注入到 desktop-ui index.html，在 React 渲染前启动。
 * 通过 MutationObserver 持续把界面上的英文文案替换为词典中的中文。
 * 不修改任何业务 JS 字符串常量，避免破坏程序逻辑。
 */
(function () {
  'use strict';
  try {
    if (window.__DD_ZH__) return;
    window.__DD_ZH__ = '1';
    var DICT = /*__DICT__*/ {};

    console.info('[dd-zh] translator script executing, dict entries: ' + Object.keys(DICT).length);

    /* ---------- 词典索引 ---------- */
    var LOWER = {};
    for (var k in DICT) {
      if (!Object.prototype.hasOwnProperty.call(DICT, k)) continue;
      var lk = k.toLowerCase();
      if (!Object.prototype.hasOwnProperty.call(LOWER, lk)) LOWER[lk] = DICT[k];
    }

  var UNITS = { second: '秒', minute: '分钟', hour: '小时', day: '天', week: '周', month: '个月', year: '年' };
  var PREFIX = { about: '约', almost: '将近', over: '超过' };
  var UNIT_RE = '(?:second|minute|hour|day|week|month|year)';
  var PATTERNS = [
    [new RegExp('^(\\d+) ' + UNIT_RE + 's? ago$'), function (m) { return m[1] + ' ' + UNITS[m[2]] + '前'; }],
    [new RegExp('^(about|almost|over) (\\d+) ' + UNIT_RE + 's? ago$'), function (m) { return PREFIX[m[1]] + ' ' + m[2] + ' ' + UNITS[m[3]] + '前'; }],
    [new RegExp('^a ' + UNIT_RE + ' ago$'), function (m) { return '1 ' + UNITS[m[1]] + '前'; }],
    [new RegExp('^(\\d+) ' + UNIT_RE + 's? from now$'), function (m) { return m[1] + ' ' + UNITS[m[2]] + '后'; }],
    [new RegExp('^in (\\d+) ' + UNIT_RE + 's?$'), function (m) { return m[1] + ' ' + UNITS[m[2]] + '后'; }],
    [/^less than a minute( ago)?$/, '不到 1 分钟'],
    [/^a few seconds ago$/, '几秒前'],
    [/^In use \((\d+)\)$/, '使用中 ($1)'],
  ];

  function lookup(s) {
    var hit = Object.prototype.hasOwnProperty.call(DICT, s) ? DICT[s] : undefined;
    if (hit === undefined) hit = Object.prototype.hasOwnProperty.call(LOWER, s.toLowerCase()) ? LOWER[s.toLowerCase()] : undefined;
    if (hit !== undefined) return hit;
    if (s.length <= 24) {
      for (var i = 0; i < PATTERNS.length; i++) {
        var m = PATTERNS[i][0].exec(s);
        if (m) return PATTERNS[i][1](m);
      }
    }
    return undefined;
  }

  /* ---------- 跳过区域 ---------- */
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, CODE: 1, PRE: 1, KBD: 1, SAMP: 1, TEXTAREA: 1 };
  function inSkip(el) {
    while (el) {
      if (SKIP_TAGS[el.tagName]) return true;
      if (el.isContentEditable) return true;
      el = el.parentElement;
    }
    return false;
  }

  /* ---------- 文本翻译 ---------- */
  function translateTextNode(node) {
    var text = node.nodeValue;
    if (!text) return;
    var t = text.trim();
    if (t.length < 2 || t.length > 120) return;
    var rep = lookup(t);
    if (rep === undefined || rep === t) return;
    var lead = text.slice(0, text.length - text.replace(/^\s+/, '').length);
    var trailStart = text.replace(/\s+$/, '').length;
    node.nodeValue = lead + rep + text.slice(trailStart);
  }

  var ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  function translateElement(el) {
    if (el.tagName === 'INPUT') {
      var ph = el.getAttribute('placeholder');
      if (ph) {
        var rep = lookup(ph.trim());
        if (rep !== undefined) el.setAttribute('placeholder', rep);
      }
      return;
    }
    for (var i = 0; i < ATTRS.length; i++) {
      var v = el.getAttribute && el.getAttribute(ATTRS[i]);
      if (!v) continue;
      var r = lookup(v.trim());
      if (r !== undefined && r !== v) el.setAttribute(ATTRS[i], r);
    }
  }

  function translateTree(root) {
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: function (n) {
        if (n.nodeType === 3) return inSkip(n.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        if (SKIP_TAGS[n.tagName]) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var cur;
    while ((cur = walker.nextNode())) {
      if (cur.nodeType === 3) translateTextNode(cur);
      else translateElement(cur);
    }
  }

  /* ---------- 批量调度 ---------- */
  var pending = new Set();
  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (window.requestAnimationFrame || setTimeout)(flush, 40);
  }
  function flush() {
    scheduled = false;
    var items = Array.from(pending);
    pending.clear();
    try {
      for (var i = 0; i < items.length; i++) {
        var n = items[i];
        if (!n || !n.isConnected) continue;
        if (n.nodeType === 3) {
          if (!inSkip(n.parentElement)) translateTextNode(n);
        } else if (n.nodeType === 1) {
          if (!SKIP_TAGS[n.tagName]) translateTree(n);
        }
      }
    } catch (e) { /* 永不影响宿主应用 */ }
  }

  var observer = new MutationObserver(function (muts) {
    for (var i = 0; i < muts.length; i++) {
      var m = muts[i];
      if (m.type === 'characterData') {
        if (m.target) pending.add(m.target);
      } else if (m.type === 'childList') {
        for (var j = 0; j < m.addedNodes.length; j++) pending.add(m.addedNodes[j]);
        if (m.addedNodes.length === 0 && m.target && m.target.nodeType === 1) pending.add(m.target);
      }
    }
    if (pending.size) schedule();
  });

  observer.observe(document, { childList: true, subtree: true, characterData: true });

  function init() {
    try { translateTree(document.body || document.documentElement); } catch (e) { }
    try { translateTree(document.head); } catch (e) { }
    setTimeout(function () {
      console.info('[dd-zh] running, window.__DD_ZH__=' + window.__DD_ZH__ + ', location=' + location.href);
    }, 3000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
  } catch (e) {
    try { console.error('[dd-zh] translator init failed: ' + (e && e.stack || e)); } catch (_) { }
  }
})();
