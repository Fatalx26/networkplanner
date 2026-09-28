'use strict';
/**
 * Network Planner — browser application
 * ============================================================================
 * Everything the user sees and does runs here; the server only stores JSON.
 *
 * HOW IT WORKS
 *   state  ─ one plain object holding the whole layout (see DATA MODEL).
 *   render ─ racks/devices/ports are rebuilt as HTML from `state`; cables are
 *            drawn as SVG curves on a layer above the racks, using the on-screen
 *            positions of the two port elements they join.
 *   commit ─ every change goes through commit(): snapshot for undo → mutate
 *            state → re-index → re-render → save (debounced PUT /api/layout,
 *            with a localStorage copy as an offline fallback).
 *
 * DATA MODEL (what is saved in layout.json)
 *   racks[]       { id, name, units }                 units = rack height in U
 *   devices[]     { id, rackId, u, height, name, skin, template, notes, groups[], portInfo }
 *                   portInfo = { "<groupIndex>:<portIndex>": { vlan, ip, subnet, details, rearNote } }
 *                   u      = lowest rack unit the device occupies (U1 = bottom)
 *                   skin   = visual style (switch, patch, server, …)
 *                   groups = port groups, each { kind, count, rows, label, numbering }
 *                            kind: rj45 | sfp | lc | power
 *                            numbering: 'seq' (left→right) | 'oddeven' (1 top, 2 below)
 *   connections[] { id, a, b, color, label }           a/b are port keys
 *   rearLinks[]   { a, b }  permanent cabling behind two patch/fiber panel ports
 *                           (e.g. a trunk to a panel in another rack). A panel
 *                           port can have one front cable and one rear link.
 *   custom[]      user-defined palette templates (same shape as TEMPLATES)
 *
 *   A PORT KEY is "<deviceId>:<groupIndex>:<portIndex>" (0-based), e.g.
 *   "dev_ab12:1:3" = 4th port of the device's 2nd group. Because keys don't
 *   depend on position, moving a device or changing its rows keeps its cables.
 *
 * INTERACTION
 *   • Drag a palette item or a placed device over a rack → a green/red ghost
 *     shows whether it fits → drop to place/move.
 *   • Click a free port → it becomes "pending"; click another free port → a
 *     connection is created. Click a connected port → the connection is
 *     selected, its far end pulses and is scrolled into view.
 *   • Keyboard: Esc clear, Delete remove selection, Ctrl+Z undo.
 */
(() => {
  // ------------------------------------------------------------------
  // Constants & device catalogue
  // ------------------------------------------------------------------
  const UPX = 44; // pixels per rack unit (must match --u in CSS)
  const COLORS = ['#3b82f6', '#facc15', '#22c55e', '#ef4444', '#f97316', '#a855f7', '#ec4899', '#14b8a6', '#e5e7eb', '#6b7280'];
  const SKINS = ['server', 'switch', 'patch', 'fiber', 'router', 'firewall', 'storage', 'power', 'kvm', 'generic', 'blank'];

  // Port-group builders used by the catalogue below.
  const rj = (count, rows = 1, label = '', numbering = 'seq') => ({ kind: 'rj45', count, rows, label, numbering });
  const sfp = (count, rows = 1, label = 'SFP', numbering = 'seq') => ({ kind: 'sfp', count, rows, label, numbering });
  const pwr = (count, label = 'PSU', rows = 1) => ({ kind: 'power', count, rows, label, numbering: 'seq' });

  // Built-in palette. `cat` = palette section, `base` = default name prefix for
  // new devices ("Switch 1", "Switch 2", …), `height` in rack units.
  // To add a built-in device type, add an entry here.
  const TEMPLATES = [
    { type: 'patch24', cat: 'Patching', name: 'Patch Panel 24', base: 'Patch Panel', height: 1, skin: 'patch', groups: [rj(24, 1)] },
    { type: 'patch48', cat: 'Patching', name: 'Patch Panel 48', base: 'Patch Panel', height: 2, skin: 'patch', groups: [rj(48, 2)] },
    { type: 'fiber24', cat: 'Patching', name: 'Fiber Panel 24 LC', base: 'Fiber Panel', height: 1, skin: 'fiber', groups: [{ kind: 'lc', count: 24, rows: 1, label: 'LC', numbering: 'seq' }] },
    { type: 'sw24', cat: 'Network', name: 'Switch 24 + 4 SFP', base: 'Switch', height: 1, skin: 'switch', groups: [rj(24, 2, '', 'oddeven'), sfp(4, 2, 'SFP', 'oddeven')] },
    { type: 'sw48', cat: 'Network', name: 'Switch 48 + 4 SFP', base: 'Switch', height: 1, skin: 'switch', groups: [rj(48, 2, '', 'oddeven'), sfp(4, 2, 'SFP', 'oddeven')] },
    { type: 'swagg', cat: 'Network', name: 'Aggregation 24 SFP+', base: 'Agg Switch', height: 1, skin: 'switch', groups: [sfp(24, 2, 'SFP', 'oddeven')] },
    { type: 'router', cat: 'Network', name: 'Router', base: 'Router', height: 1, skin: 'router', groups: [rj(8, 1, 'GE'), sfp(2, 1), rj(1, 1, 'CON')] },
    { type: 'firewall', cat: 'Network', name: 'Firewall', base: 'Firewall', height: 1, skin: 'firewall', groups: [rj(2, 1, 'WAN'), rj(8, 1, 'LAN'), rj(1, 1, 'MGMT')] },
    { type: 'server1', cat: 'Compute', name: 'Server 1U', base: 'Server', height: 1, skin: 'server', groups: [rj(4, 1, 'NIC'), rj(1, 1, 'MGMT'), pwr(2)] },
    { type: 'server2', cat: 'Compute', name: 'Server 2U', base: 'Server', height: 2, skin: 'server', groups: [rj(4, 1, 'NIC'), sfp(2), rj(1, 1, 'MGMT'), pwr(2)] },
    { type: 'server4', cat: 'Compute', name: 'Server 4U', base: 'Server', height: 4, skin: 'server', groups: [rj(4, 1, 'NIC'), sfp(4), rj(1, 1, 'MGMT'), pwr(2)] },
    { type: 'kvm', cat: 'Compute', name: 'KVM 8-port', base: 'KVM', height: 1, skin: 'kvm', groups: [rj(8, 1, 'KVM'), rj(1, 1, 'LAN')] },
    { type: 'storage', cat: 'Storage & Power', name: 'Storage Array 2U', base: 'Storage', height: 2, skin: 'storage', groups: [sfp(4, 1, 'SAN'), rj(2, 1, 'MGMT'), pwr(2)] },
    { type: 'pdu', cat: 'Storage & Power', name: 'PDU 12 outlet', base: 'PDU', height: 1, skin: 'power', groups: [pwr(12, 'OUT')] },
    { type: 'ups', cat: 'Storage & Power', name: 'UPS 2U', base: 'UPS', height: 2, skin: 'power', groups: [pwr(6, 'OUT'), rj(1, 1, 'NET')] },
    { type: 'cm1', cat: 'Accessories', name: 'Cable Manager 1U', base: 'Cable Manager', height: 1, skin: 'cablemgmt', groups: [] },
    { type: 'cm2', cat: 'Accessories', name: 'Cable Manager 2U', base: 'Cable Manager', height: 2, skin: 'cablemgmt', groups: [] },
    { type: 'shelf', cat: 'Accessories', name: 'Shelf 2U', base: 'Shelf', height: 2, skin: 'shelf', groups: [] },
    { type: 'blank1', cat: 'Accessories', name: 'Blanking Panel 1U', base: 'Blank', height: 1, skin: 'blank', groups: [] },
    { type: 'blank2', cat: 'Accessories', name: 'Blanking Panel 2U', base: 'Blank', height: 2, skin: 'blank', groups: [] },
  ];

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------
  // `state` is the saved document. `idx` holds lookup maps rebuilt after every
  // change (device/rack/connection by id, connection by port key, port key →
  // DOM element). `ui` is transient selection/view state that is not saved.
  let state = null;
  const idx = { dev: new Map(), rack: new Map(), conn: new Map(), byPort: new Map(), rear: new Map(), portEl: new Map() };
  // multi = port keys picked with Ctrl+click, shown together with their cables.
  const ui = { pending: null, conn: null, origin: null, device: null, multi: [], peek: null, mode: 'all', color: COLORS[0], zoom: 1 };
  const undoStack = [];
  let drag = null;
  let editing = false;

  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = (p) => `${p}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`;
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const allTemplates = () => TEMPLATES.concat(state.custom || []);
  const findTpl = (type) => allTemplates().find((t) => t.type === type);
  const portKey = (devId, gi, pi) => `${devId}:${gi}:${pi}`;
  const parseKey = (k) => { const [d, g, p] = k.split(':'); return { devId: d, gi: +g, pi: +p }; };
  const otherEnd = (c, key) => (c.a === key ? c.b : c.a);
  const portCount = (d) => d.groups.reduce((n, g) => n + g.count, 0);

  function portLabel(dev, gi, pi) {
    const g = dev.groups[gi];
    return `${g && g.label ? g.label : 'Port'} ${pi + 1}`;
  }
  function describePort(key) {
    const { devId, gi, pi } = parseKey(key);
    const dev = idx.dev.get(devId);
    if (!dev) return { dev: null, text: '(missing)', port: '', loc: '' };
    const rack = idx.rack.get(dev.rackId);
    return {
      dev,
      port: portLabel(dev, gi, pi),
      text: `${dev.name} · ${portLabel(dev, gi, pi)}`,
      loc: `${rack ? rack.name : '?'} · U${dev.u}`,
    };
  }

  // Per-port network settings (VLAN / IP / subnet), stored on the device as
  // dev.portInfo["<groupIndex>:<portIndex>"] = { vlan, ip, subnet }. They belong
  // to the port, not the cable, so they survive re-cabling. Patch/fiber panels
  // are passive and don't get these fields.
  const NET_FIELDS = [
    { f: 'vlan', label: 'VLAN', ph: '10  or  10,20,30-40' },
    { f: 'ip', label: 'IP address', ph: '10.0.10.21  or  10.0.10.21/24' },
    { f: 'subnet', label: 'Subnet', ph: '10.0.10.0/24  or  255.255.255.0', wide: true },
  ];
  const isPassive = (dev) => !!dev && (dev.skin === 'patch' || dev.skin === 'fiber');
  function portInfo(key) {
    const { devId, gi, pi } = parseKey(key);
    return idx.dev.get(devId)?.portInfo?.[`${gi}:${pi}`] || {};
  }
  function netSummary(key) {
    const i = portInfo(key);
    return [i.vlan && `VLAN ${i.vlan}`, i.ip, i.subnet].filter(Boolean).join(' · ');
  }
  function setPortInfo(key, field, value) {
    const { devId, gi, pi } = parseKey(key);
    const dev = idx.dev.get(devId);
    if (!dev) return;
    const k = `${gi}:${pi}`;
    const info = { ...(dev.portInfo?.[k] || {}), [field]: value.trim() };
    if (!info[field]) delete info[field];
    dev.portInfo = { ...(dev.portInfo || {}) };
    if (Object.keys(info).length) dev.portInfo[k] = info; else delete dev.portInfo[k];
  }

  // Soft validation: bad values get an orange outline but are still saved.
  // IPv6 values (containing ":") are accepted as typed.
  const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
  function netValid(field, raw) {
    const v = String(raw || '').trim();
    if (!v) return true;
    if (field === 'vlan') {
      if (/^(trunk|all|native)$/i.test(v)) return true;
      return /^\d+(-\d+)?(,\d+(-\d+)?)*$/.test(v.replace(/\s+/g, '')) && v.match(/\d+/g).every((n) => +n >= 1 && +n <= 4094);
    }
    if (v.includes(':')) return true;
    const [addr, prefix, extra] = v.split('/');
    if (extra !== undefined || !IPV4.test(addr)) return false;
    return prefix === undefined || (/^\d+$/.test(prefix) && +prefix <= 32);
  }

  // All port keys of a device in display order (group by group), and a port's
  // position in that list. Used for 1:1 rear trunks between panels.
  const allKeys = (dev) => dev.groups.flatMap((g, gi) => Array.from({ length: g.count }, (_, pi) => portKey(dev.id, gi, pi)));
  function flatIndex(key) {
    const { devId, gi, pi } = parseKey(key);
    const dev = idx.dev.get(devId);
    return dev ? dev.groups.slice(0, gi).reduce((n, g) => n + g.count, 0) + pi : -1;
  }
  const passiveDevices = (exceptId) => state.devices.filter((d) => isPassive(d) && d.id !== exceptId)
    .sort((a, b) => (idx.rack.get(a.rackId)?.name || '').localeCompare(idx.rack.get(b.rackId)?.name || '') || b.u - a.u);
  const shorten = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  // Rear links: link `key` to `other` (or unlink it when other is null). Any
  // older rear link on either port is replaced. Call inside commit().
  function setRear(key, other) {
    state.rearLinks = state.rearLinks.filter((l) => l.a !== key && l.b !== key && (!other || (l.a !== other && l.b !== other)));
    if (!other) return;
    state.rearLinks.push({ a: key, b: other });
    setPortInfo(key, 'rearNote', '');
    setPortInfo(other, 'rearNote', '');
  }
  function removeDeviceRear(devId) {
    state.rearLinks = state.rearLinks.filter((l) => parseKey(l.a).devId !== devId && parseKey(l.b).devId !== devId);
  }
  function rearText(key) {
    const r = idx.rear.get(key);
    if (r) { const p = describePort(r); return `${p.text} (${p.loc})`; }
    return portInfo(key).rearNote || '';
  }

  // Follow a cable outward through patch panels: from each end, hop across the
  // panel's rear link, then along whatever front cable is on the far panel, and
  // so on. Returns the ordered path; seq[i].via is the link between seq[i-1]
  // and seq[i] ('cable' or 'rear'). A rear note ends the path off-plan.
  function tracePath(c, origin = ui.origin) {
    const seen = new Set([c.a, c.b]);
    const walk = (start) => {
      const out = [];
      let p = start;
      for (;;) {
        const r = idx.rear.get(p);
        if (!r) { const note = portInfo(p).rearNote; if (note && isPassive(idx.dev.get(parseKey(p).devId))) out.push({ via: 'rear', note }); break; }
        if (seen.has(r)) break;
        seen.add(r); out.push({ via: 'rear', key: r });
        const cc = idx.byPort.get(r);
        if (!cc) break;
        const nxt = otherEnd(cc, r);
        if (seen.has(nxt)) break;
        seen.add(nxt); out.push({ via: 'cable', key: nxt, conn: cc });
        p = nxt;
      }
      return out;
    };
    const near = origin === c.b ? c.b : c.a;
    const far = otherEnd(c, near);
    const L = walk(near);
    const R = walk(far);
    const seq = [];
    for (let j = L.length - 1; j >= 0; j--) {
      const next = L[j + 1];
      seq.push({ key: L[j].key, note: L[j].note, via: next ? next.via : null, conn: next?.conn });
    }
    seq.push({ key: near, via: L[0]?.via || null, conn: L[0]?.conn });
    seq.push({ key: far, via: 'cable', conn: c });
    seq.push(...R);
    const conns = new Set(seq.filter((s) => s.via === 'cable').map((s) => s.conn.id));
    const rears = [];
    seq.forEach((s, i) => { if (s.via === 'rear' && s.key && seq[i - 1]?.key) rears.push([seq[i - 1].key, s.key]); });
    return { seq, conns, rears, extended: L.length + R.length > 0 };
  }

  // Network loop detection. Each cable is followed through any patch panel
  // rear links to its real end-points; only switch-to-switch links count.
  //   self   – a switch is cabled back into itself
  //   double – two or more separate links join the same two switches
  // Everything on a looping link (cables, ports, rear links) glows red.
  let loops = { conns: new Set(), ports: new Set(), rears: [], issues: [] };
  const isSwitch = (key) => idx.dev.get(parseKey(key).devId)?.skin === 'switch';
  function findLoops() {
    const links = new Map();
    for (const c of state.connections) {
      const path = tracePath(c, c.a);
      const first = path.seq[0];
      const last = path.seq[path.seq.length - 1];
      if (!first.key || !last.key || !isSwitch(first.key) || !isSwitch(last.key)) continue;
      const [a, b] = [first.key, last.key].sort();
      const id = `${a}|${b}`;
      if (!links.has(id)) links.set(id, { a, b, conns: path.conns, ports: path.seq.map((s) => s.key).filter(Boolean), rears: path.rears });
    }
    const out = { conns: new Set(), ports: new Set(), rears: [], issues: [] };
    const flag = (l) => { l.conns.forEach((id) => out.conns.add(id)); l.ports.forEach((k) => out.ports.add(k)); out.rears.push(...l.rears); };
    const pairs = new Map();
    for (const l of links.values()) {
      const da = parseKey(l.a).devId;
      const db = parseKey(l.b).devId;
      if (da === db) { flag(l); out.issues.push({ type: 'self', devs: [da], links: [l] }); continue; }
      const pid = [da, db].sort().join('|');
      if (!pairs.has(pid)) pairs.set(pid, []);
      pairs.get(pid).push(l);
    }
    for (const [pid, ls] of pairs) {
      if (ls.length < 2) continue;
      ls.forEach(flag);
      const devs = pid.split('|').sort((x, y) => (idx.dev.get(x)?.name || '').localeCompare(idx.dev.get(y)?.name || '', undefined, { numeric: true }));
      out.issues.push({ type: 'double', devs, links: ls });
    }
    return out;
  }
  // One-line summary of a loop, e.g. "Switch 1 is cabled into itself".
  function loopTitle(issue) {
    const [a, b] = issue.devs.map((id) => idx.dev.get(id)?.name);
    return issue.type === 'self' ? `${a} is cabled into itself` : `${a} and ${b} are joined by ${issue.links.length} links`;
  }
  function loopForPort(key) { return loops.issues.find((i) => i.links.some((l) => l.ports.includes(key))); }

  function newDevice(tpl, rackId, u) {
    const n = state.devices.filter((d) => d.template === tpl.type).length + 1;
    const base = tpl.base || tpl.name;
    return { id: uid('dev'), rackId, u, height: tpl.height, name: `${base} ${n}`, skin: tpl.skin, template: tpl.type, groups: clone(tpl.groups), notes: '' };
  }

  function defaultState() {
    const rackId = uid('rack');
    state = { version: 1, racks: [{ id: rackId, name: 'Rack A', units: 42 }], devices: [], connections: [], rearLinks: [], custom: [] };
    const place = (type, u, name) => { const d = newDevice(findTpl(type), rackId, u); d.name = name; state.devices.push(d); };
    place('patch24', 42, 'Patch Panel A');
    place('cm1', 41, 'Cable Manager');
    place('sw48', 40, 'Switch 1');
    place('patch24', 38, 'Patch Panel B');
    place('cm1', 37, 'Cable Manager');
    place('sw24', 36, 'Switch 2');
    place('firewall', 34, 'Firewall');
    place('server1', 30, 'Server 1');
    place('server2', 28, 'Server 2');
    place('pdu', 2, 'PDU A');
    return state;
  }

  // Validate a layout loaded from the server, localStorage or an imported file:
  // drops devices in missing racks and cables pointing at ports that don't
  // exist or are already used, and clamps sizes to sane ranges.
  function sanitize(s) {
    if (!s || typeof s !== 'object') throw new Error('Not a layout file');
    const out = { version: 1, racks: [], devices: [], connections: [], custom: Array.isArray(s.custom) ? s.custom : [] };
    const rackIds = new Set();
    for (const r of Array.isArray(s.racks) ? s.racks : []) {
      if (!r || !r.id) continue;
      out.racks.push({ id: String(r.id), name: String(r.name || 'Rack'), units: clamp(parseInt(r.units, 10) || 42, 1, 100) });
      rackIds.add(String(r.id));
    }
    const devs = new Map();
    for (const d of Array.isArray(s.devices) ? s.devices : []) {
      if (!d || !d.id || !rackIds.has(d.rackId) || !Array.isArray(d.groups)) continue;
      const dev = { ...d, height: clamp(parseInt(d.height, 10) || 1, 1, 100), u: Math.max(1, parseInt(d.u, 10) || 1) };
      dev.portInfo = d.portInfo && typeof d.portInfo === 'object' && !Array.isArray(d.portInfo) ? d.portInfo : {};
      out.devices.push(dev);
      devs.set(dev.id, dev);
    }
    const used = new Set();
    const valid = (k) => {
      if (typeof k !== 'string' || used.has(k)) return false;
      const { devId, gi, pi } = parseKey(k);
      const d = devs.get(devId);
      return d && d.groups[gi] && pi >= 0 && pi < d.groups[gi].count;
    };
    for (const c of Array.isArray(s.connections) ? s.connections : []) {
      if (!c || !valid(c.a) || !valid(c.b) || c.a === c.b) continue;
      used.add(c.a); used.add(c.b);
      out.connections.push({ id: c.id || uid('c'), a: c.a, b: c.b, color: c.color || COLORS[0], label: c.label || '' });
    }
    // Rear links: only between ports of two different patch/fiber panels, one per port.
    const rearUsed = new Set();
    const panelPort = (k) => {
      if (typeof k !== 'string' || rearUsed.has(k)) return false;
      const { devId, gi, pi } = parseKey(k);
      const d = devs.get(devId);
      return isPassive(d) && d.groups[gi] && pi >= 0 && pi < d.groups[gi].count;
    };
    out.rearLinks = [];
    for (const l of Array.isArray(s.rearLinks) ? s.rearLinks : []) {
      if (!l || !panelPort(l.a) || !panelPort(l.b) || parseKey(l.a).devId === parseKey(l.b).devId) continue;
      rearUsed.add(l.a); rearUsed.add(l.b);
      out.rearLinks.push({ a: l.a, b: l.b });
    }
    return out;
  }

  function rebuildIndex() {
    idx.dev = new Map(state.devices.map((d) => [d.id, d]));
    idx.rack = new Map(state.racks.map((r) => [r.id, r]));
    idx.conn = new Map(state.connections.map((c) => [c.id, c]));
    idx.byPort = new Map();
    for (const c of state.connections) { idx.byPort.set(c.a, c); idx.byPort.set(c.b, c); }
    state.rearLinks = state.rearLinks || [];
    idx.rear = new Map();
    for (const l of state.rearLinks) { idx.rear.set(l.a, l.b); idx.rear.set(l.b, l.a); }
    if (ui.conn && !idx.conn.has(ui.conn)) { ui.conn = null; ui.origin = null; }
    if (ui.device && !idx.dev.has(ui.device)) ui.device = null;
    if (ui.pending && !idx.dev.has(parseKey(ui.pending).devId)) ui.pending = null;
    ui.multi = ui.multi.filter((k) => idx.dev.has(parseKey(k).devId));
  }

  // True if a device `h` units tall can sit with its bottom at `u` in `rack`
  // without leaving the rack or overlapping another device (except ignoreId,
  // the device being moved).
  function fits(rack, u, h, ignoreId) {
    if (u < 1 || u + h - 1 > rack.units) return false;
    return !state.devices.some((d) => d.rackId === rack.id && d.id !== ignoreId && u <= d.u + d.height - 1 && d.u <= u + h - 1);
  }
  function findFreeSlot(h, preferRackId) {
    const racks = [...state.racks].sort((a, b) => (b.id === preferRackId) - (a.id === preferRackId));
    for (const rack of racks) {
      for (let u = rack.units - h + 1; u >= 1; u--) if (fits(rack, u, h)) return { rack, u };
    }
    return null;
  }

  // ------------------------------------------------------------------
  // Mutation, undo, persistence
  // ------------------------------------------------------------------
  function pushUndo() {
    undoStack.push(JSON.stringify(state));
    if (undoStack.length > 150) undoStack.shift();
  }
  // The single path for changing the layout: undo snapshot, apply, re-render, save.
  function commit(mutator) {
    pushUndo();
    mutator();
    rebuildIndex();
    renderRacks();
    scheduleSave();
  }
  function undo() {
    const snap = undoStack.pop();
    if (!snap) return;
    state = JSON.parse(snap);
    ui.pending = null;
    rebuildIndex();
    renderPalette();
    renderRacks();
    scheduleSave();
  }

  let saveTimer = null;
  function setStatus(text, cls = '') {
    const el = $('#save-status');
    el.textContent = text;
    el.className = `save-status ${cls}`;
  }
  // Saves are debounced (400 ms) so rapid edits become one request. A copy is
  // always kept in localStorage in case the server is unreachable.
  function scheduleSave() {
    setStatus('Saving…');
    try { localStorage.setItem('rackplanner.layout', JSON.stringify(state)); } catch { /* storage unavailable */ }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  async function save() {
    try {
      const r = await fetch('api/layout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) });
      if (!r.ok) throw new Error(r.statusText);
      setStatus('Saved', 'ok');
    } catch {
      setStatus('Server unreachable — saved in browser', 'warn');
    }
  }
  async function load() {
    try {
      const r = await fetch('api/layout', { cache: 'no-store' });
      if (r.status === 200) return { data: sanitize(await r.json()), fromServer: true };
    } catch { /* fall through to local copy */ }
    try {
      const s = localStorage.getItem('rackplanner.layout');
      if (s) return { data: sanitize(JSON.parse(s)), fromServer: false };
    } catch { /* ignore */ }
    return { data: null, fromServer: false };
  }

  // ------------------------------------------------------------------
  // Rendering: palette
  // ------------------------------------------------------------------
  function renderPalette() {
    const cats = new Map();
    for (const t of allTemplates()) {
      const c = t.cat || 'Custom';
      if (!cats.has(c)) cats.set(c, []);
      cats.get(c).push(t);
    }
    if (!cats.has('Custom')) cats.set('Custom', []);
    let html = '<p class="pal-hint">Drag onto a rack, or click to drop into the first free slot.</p>';
    for (const [cat, items] of cats) {
      html += `<div class="pal-cat"><h4>${esc(cat)}</h4>`;
      for (const t of items) {
        const ports = t.groups.reduce((n, g) => n + g.count, 0);
        html += `<div class="pal-item" draggable="true" data-tpl="${esc(t.type)}" title="Drag into a rack">
          <div class="pal-thumb skin-${esc(t.skin)}" style="height:${Math.min(t.height, 4) * 9 + 4}px"></div>
          <div><div class="pal-name">${esc(t.name)}</div><div class="pal-meta">${t.height}U${ports ? ` · ${ports} ports` : ''}</div></div>
          ${cat === 'Custom' ? `<button class="pal-del" data-del-tpl="${esc(t.type)}" title="Remove from palette">×</button>` : ''}
        </div>`;
      }
      if (cat === 'Custom') html += '<button class="btn small" id="btn-custom" style="width:100%">+ Custom device…</button>';
      html += '</div>';
    }
    $('#palette').innerHTML = html;
  }

  // ------------------------------------------------------------------
  // Rendering: racks, devices, ports
  // ------------------------------------------------------------------
  // Lay out one port group as a CSS grid. Rows are capped at 2 per rack unit so
  // ports always fit on the faceplate; a 5px gap is added every 6 columns like
  // real switches. `numbering` decides whether port 2 sits right of or below 1.
  function groupHTML(dev, g, gi) {
    const rows = clamp(g.rows || 1, 1, dev.height * 2);
    const cols = Math.ceil(g.count / rows);
    const spacer = cols > 6 && g.count >= 12;
    const tpl = [];
    for (let c = 0; c < cols; c++) { if (spacer && c > 0 && c % 6 === 0) tpl.push('5px'); tpl.push('18px'); }
    let cells = '';
    for (let i = 0; i < g.count; i++) {
      const oddEven = g.numbering === 'oddeven';
      const col = oddEven ? Math.floor(i / rows) : i % cols;
      const row = oddEven ? i % rows : Math.floor(i / cols);
      const key = portKey(dev.id, gi, i);
      const conn = idx.byPort.get(key);
      let cls = `port k-${g.kind}`;
      let style = `grid-row:${row + 1};grid-column:${col + 1 + (spacer ? Math.floor(col / 6) : 0)}`;
      let title = `${dev.name} — ${portLabel(dev, gi, i)}`;
      if (conn) {
        cls += ' connected';
        style += `;--c:${conn.color}`;
        title += `\n⇄ ${describePort(otherEnd(conn, key)).text}${conn.label ? `\n“${conn.label}”` : ''}`;
      } else {
        title += '\nClick to select it or start a cable';
      }
      const net = netSummary(key);
      if (net) title += `\n${net}`;
      const rear = rearText(key);
      if (rear) { title += `\nRear → ${rear}`; cls += ' has-rear'; }
      const details = portInfo(key).details;
      if (details) { title += `\n${shorten(details, 200)}`; cls += ' has-note'; }
      if (loops.ports.has(key)) { title += `\n⚠ Network loop: ${loopTitle(loopForPort(key))}`; cls += ' loop'; }
      cells += `<div class="${cls}" data-p="${key}" style="${style}" title="${esc(title)}">${i + 1}</div>`;
    }
    const showLabel = g.label && (rows === 1 || dev.height > 1);
    return `<div class="pgroup">${showLabel ? `<div class="pgroup-label">${esc(g.label)}</div>` : ''}<div class="pgrid" style="grid-template-columns:${tpl.join(' ')}">${cells}</div></div>`;
  }

  // A device is absolutely positioned inside its rack: rack units count up from
  // the bottom, so its top edge is (rack height − its top unit) × UPX.
  function deviceHTML(d, rack) {
    const top = (rack.units - (d.u + d.height - 1)) * UPX;
    const range = d.height > 1 ? `U${d.u}–${d.u + d.height - 1}` : `U${d.u}`;
    const bays = d.skin === 'server' || d.skin === 'storage' ? '<div class="bays"></div>' : '';
    return `<div class="device skin-${esc(d.skin)}" data-dev="${d.id}" draggable="true" style="top:${top + 1}px;height:${d.height * UPX - 2}px">
      <div class="dev-label"><div class="dev-name" title="${esc(d.name)}">${esc(d.name)}</div><div class="dev-meta">${range} · ${d.height}U</div></div>
      ${bays}<div class="dev-ports">${d.groups.map((g, gi) => groupHTML(d, g, gi)).join('')}</div>
    </div>`;
  }

  function rackHTML(rack) {
    const devs = state.devices.filter((d) => d.rackId === rack.id);
    const used = devs.reduce((n, d) => n + d.height, 0);
    let nums = '';
    for (let u = rack.units; u >= 1; u--) nums += `<span>${u}</span>`;
    return `<div class="rack" data-rack="${rack.id}">
      <div class="rack-head" draggable="true" title="Drag to reorder racks">
        <span class="rack-grip" aria-hidden="true">⠿</span>
        <span class="rack-name">${esc(rack.name)}</span>
        <span class="rack-u">${rack.units}U · ${used}U used · ${rack.units - used}U free</span>
        <span class="rack-actions">
          <button class="btn small" data-act="edit-rack" data-rack="${rack.id}">Edit</button>
          <button class="btn small danger" data-act="del-rack" data-rack="${rack.id}">Delete</button>
        </span>
      </div>
      <div class="rack-frame">
        <div class="rail">${nums}</div>
        <div class="rack-body" data-rack="${rack.id}" style="height:${rack.units * UPX}px">
          ${devs.length ? '' : '<div class="rack-empty-hint">Drag equipment here</div>'}
          ${devs.map((d) => deviceHTML(d, rack)).join('')}
          <div class="ghost" hidden></div>
        </div>
        <div class="rail">${nums}</div>
      </div>
    </div>`;
  }

  function renderRacks(opts = {}) {
    const root = $('#racks');
    loops = findLoops();
    const alertBtn = $('#loop-alert');
    alertBtn.hidden = !loops.issues.length;
    alertBtn.textContent = `⚠ ${loops.issues.length} network loop${loops.issues.length === 1 ? '' : 's'}`;
    root.innerHTML =state.racks.map(rackHTML).join('') + '<button class="add-rack-tile" data-act="add-rack">+ Add rack</button>';
    idx.portEl.clear();
    root.querySelectorAll('.port').forEach((el) => idx.portEl.set(el.dataset.p, el));
    ui.peek = null;
    marked = [];
    sizeCanvas();
    updateHighlights(opts);
  }

  function sizeCanvas() {
    const canvas = $('#canvas');
    canvas.style.transform = `scale(${ui.zoom})`;
    const wrap = $('#canvas-wrap');
    wrap.style.width = `${canvas.offsetWidth * ui.zoom}px`;
    wrap.style.height = `${canvas.offsetHeight * ui.zoom}px`;
    $('#zoom-label').textContent = `${Math.round(ui.zoom * 100)}%`;
  }

  // Apply selection classes (pending port, highlighted cable ends, selected
  // device) without rebuilding the racks, then redraw cables and the inspector.
  // hlConns / hlRears: cables and rear links on the highlighted path, used by drawCables().
  let marked = [];
  let hlConns = new Set();
  let hlRears = [];
  function updateHighlights(opts = {}) {
    for (const [el, cls] of marked) el.classList.remove(...cls);
    marked = [];
    hlConns = new Set();
    hlRears = [];
    const mark = (el, ...cls) => { if (el) { el.classList.add(...cls); marked.push([el, cls]); } };
    const devEl = (id) => document.querySelector(`.device[data-dev="${id}"]`);

    if (ui.pending) {
      mark(idx.portEl.get(ui.pending), 'pending');
      const r = idx.rear.get(ui.pending);
      if (r) { mark(idx.portEl.get(r), 'hl-rear'); mark(devEl(parseKey(r).devId), 'hl-dev'); hlRears.push([ui.pending, r]); }
    }
    const c = ui.conn && idx.conn.get(ui.conn);
    if (c) {
      // Highlight the whole path, including hops through patch panel rear links.
      const path = tracePath(c);
      hlConns = path.conns;
      hlRears = path.rears;
      for (const s of path.seq) {
        if (!s.key) continue;
        mark(idx.portEl.get(s.key), 'hl');
        mark(devEl(parseKey(s.key).devId), 'hl-dev');
      }
      mark(idx.portEl.get(ui.origin === c.a ? c.b : c.a), 'hl-far');
    }
    // Ctrl+click multi-selection: every picked port plus its whole path.
    for (const key of ui.multi) {
      mark(idx.portEl.get(key), 'multi');
      mark(devEl(parseKey(key).devId), 'hl-dev');
      const mc = idx.byPort.get(key);
      if (mc) {
        const path = tracePath(mc, key);
        path.conns.forEach((id) => hlConns.add(id));
        hlRears.push(...path.rears);
        for (const s of path.seq) {
          if (!s.key || s.key === key) continue;
          mark(idx.portEl.get(s.key), 'hl');
          mark(devEl(parseKey(s.key).devId), 'hl-dev');
        }
        mark(idx.portEl.get(otherEnd(mc, key)), 'hl-far');
      } else if (idx.rear.has(key)) {
        mark(idx.portEl.get(idx.rear.get(key)), 'hl-rear');
        hlRears.push([key, idx.rear.get(key)]);
      }
    }
    if (ui.device) {
      mark(devEl(ui.device), 'selected');
      // A selected panel shows where its rear links go.
      const dev = idx.dev.get(ui.device);
      if (isPassive(dev)) hlRears = state.rearLinks.filter((l) => parseKey(l.a).devId === dev.id || parseKey(l.b).devId === dev.id).map((l) => [l.a, l.b]);
    }
    requestAnimationFrame(drawCables);
    if (opts.inspector !== false) renderInspector();
  }

  // Draw every cable as a drooping Bézier curve between the centres of its two
  // port elements. Positions are divided by the zoom factor because the SVG
  // layer is scaled together with the racks. The selected cable is drawn last
  // (on top) and the others are dimmed.
  function drawCables() {
    const svg = $('#cables');
    const canvas = $('#canvas');
    svg.setAttribute('width', canvas.offsetWidth);
    svg.setAttribute('height', canvas.offsetHeight);
    if (ui.mode === 'none') { svg.innerHTML = ''; return; }
    const cr = canvas.getBoundingClientRect();
    const z = ui.zoom;
    const center = (el) => { const r = el.getBoundingClientRect(); return { x: (r.left + r.width / 2 - cr.left) / z, y: (r.top + r.height / 2 - cr.top) / z }; };
    let normal = '';
    let top = '';
    for (const c of state.connections) {
      const hl = hlConns.has(c.id);
      if (ui.mode === 'selected' && !hl) continue;
      const ea = idx.portEl.get(c.a);
      const eb = idx.portEl.get(c.b);
      if (!ea || !eb) continue;
      const p = center(ea);
      const q = center(eb);
      const sag = 22 + Math.min(200, (Math.abs(q.x - p.x) + Math.abs(q.y - p.y)) * 0.22);
      const d = `M${p.x.toFixed(1)},${p.y.toFixed(1)} C${p.x.toFixed(1)},${(p.y + sag).toFixed(1)} ${q.x.toFixed(1)},${(q.y + sag).toFixed(1)} ${q.x.toFixed(1)},${q.y.toFixed(1)}`;
      const cls = `cable-g${hl ? ' hl' : ''}${(ui.conn || ui.multi.length) && !hl ? ' dim' : ''}${loops.conns.has(c.id) ? ' loop' : ''}`;
      const g = `<g class="${cls}"><path class="cable-shadow" d="${d}"/><path class="cable" d="${d}" stroke="${esc(c.color)}"/>` +
        `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${esc(c.color)}"/><circle cx="${q.x}" cy="${q.y}" r="3" fill="${esc(c.color)}"/></g>`;
      if (hl) top += g; else normal += g;
    }
    // Rear links are only drawn for the current selection, as dashed lines that
    // arch upward so they don't read as front patch cables.
    // Rear links that are part of a loop are always drawn, in red.
    const loopRear = new Set(loops.rears.map(([a, b]) => [a, b].sort().join('|')));
    const rearsToDraw = [...hlRears.filter(([a, b]) => !loopRear.has([a, b].sort().join('|'))), ...loops.rears];
    for (const [a, b] of rearsToDraw) {
      const ea = idx.portEl.get(a);
      const eb = idx.portEl.get(b);
      if (!ea || !eb) continue;
      const p = center(ea);
      const q = center(eb);
      const lift = 26 + Math.min(160, (Math.abs(q.x - p.x) + Math.abs(q.y - p.y)) * 0.18);
      const up = (y) => Math.max(6, y - lift).toFixed(1); // keep the arch inside the canvas
      const d = `M${p.x.toFixed(1)},${p.y.toFixed(1)} C${p.x.toFixed(1)},${up(p.y)} ${q.x.toFixed(1)},${up(q.y)} ${q.x.toFixed(1)},${q.y.toFixed(1)}`;
      const lp = loopRear.has([a, b].sort().join('|'));
      top += `<g class="rear-g${lp ? ' loop' : ''}"><path class="cable-shadow" d="${d}"/><path class="rear-link" d="${d}"/></g>`;
    }
    svg.innerHTML = normal + top;
  }

  function setPeek(key) {
    if (ui.peek === key) return;
    if (ui.peek) idx.portEl.get(ui.peek)?.classList.remove('peek');
    ui.peek = key;
    if (key) idx.portEl.get(key)?.classList.add('peek');
  }

  function scrollToPort(key) {
    const el = idx.portEl.get(key);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }

  // ------------------------------------------------------------------
  // Rendering: inspector
  // ------------------------------------------------------------------
  function swatchesHTML(current, attr) {
    return COLORS.map((c) => `<button class="swatch${c === current ? ' on' : ''}" style="background:${c}" ${attr}="${c}" title="${c}"></button>`).join('');
  }

  function connRow(c, fromKey) {
    const here = describePort(fromKey);
    const there = describePort(otherEnd(c, fromKey));
    const extra = [netSummary(fromKey), portInfo(fromKey).details && shorten(portInfo(fromKey).details.replace(/\s+/g, ' '), 60)].filter(Boolean).join(' · ');
    return `<li data-conn="${c.id}" data-origin="${fromKey}" style="--c:${esc(c.color)}"><span class="dot"></span>
      <span><b>${esc(here.port)}</b> <span class="arrow">→</span> ${esc(there.text)}${c.label ? ` <span class="muted">“${esc(c.label)}”</span>` : ''}${extra ? `<br><span class="muted">${esc(extra)}</span>` : ''}</span></li>`;
  }

  // Red warning box listing loops; each link is a row that selects its cable.
  function loopListHTML(issues) {
    if (!issues.length) return '';
    const via = (l) => {
      const panels = [...new Set(l.ports.slice(1, -1).map((k) => idx.dev.get(parseKey(k).devId)?.name))];
      return panels.length ? ` <span class="muted">via ${esc(panels.join(', '))}</span>` : '';
    };
    const body = issues.map((i) => `<div class="loop-issue"><b>${esc(loopTitle(i))}</b><ul class="conn-list">${i.links.map((l) => {
      // Show the end on the first-named switch first.
      const firstEnd = i.type === 'self' ? flatIndex(l.a) <= flatIndex(l.b) : parseKey(l.a).devId === i.devs[0];
      const [x, y] = firstEnd ? [l.a, l.b] : [l.b, l.a];
      const text = i.type === 'self' ? `${describePort(x).port} ↔ ${describePort(y).port}` : `${describePort(x).text} ↔ ${describePort(y).text}`;
      return `<li data-conn="${idx.byPort.get(x).id}" data-origin="${x}" style="--c:var(--danger)"><span class="dot"></span><span>${esc(text)}${via(l)}</span></li>`;
    }).join('')}</ul></div>`).join('');
    return `<div class="loop-box"><div class="loop-head">⚠ Network loop${issues.length === 1 ? '' : 's'} detected</div>${body}
      <p class="hint">Traffic caught in a loop circulates endlessly and can bring the network down (a broadcast storm).
      If the links are a deliberate LACP / port-channel bundle, or spanning tree blocks one of them, this is expected.</p></div>`;
  }

  // Editable settings for one port: network fields (active devices), rear
  // connection (patch/fiber panels) and free-text details (every port).
  function portFieldsHTML(key) {
    const p = describePort(key);
    const info = portInfo(key);
    const passive = isPassive(p.dev);
    const net = passive ? '' : `<div class="netinfo">${NET_FIELDS.map((n) => `<label class="field${n.wide ? ' wide' : ''}">${n.label}
      <input data-pf="${n.f}" data-port="${key}" value="${esc(info[n.f])}" placeholder="${esc(n.ph)}" spellcheck="false" autocomplete="off"
        class="${netValid(n.f, info[n.f]) ? '' : 'warn'}"></label>`).join('')}</div>`;
    return `<div class="portfields">${net}${passive ? rearHTML(key) : ''}
      <label class="field">Details<textarea data-pf="details" data-port="${key}" rows="2"
        placeholder="Anything worth noting: what it serves, room / desk, PoE, ticket…">${esc(info.details)}</textarea></label></div>`;
  }

  function rearHTML(key) {
    const cur = idx.rear.get(key);
    const curDev = cur && idx.dev.get(parseKey(cur).devId);
    const panels = passiveDevices(parseKey(key).devId);
    const devOpts = panels.length
      ? `<option value="">Not linked to a panel</option>${panels.map((d) => `<option value="${d.id}"${curDev?.id === d.id ? ' selected' : ''}>${esc(d.name)} · ${esc(idx.rack.get(d.rackId)?.name)} U${d.u}</option>`).join('')}`
      : '<option value="">No other patch panels yet</option>';
    const portSel = curDev ? `<select data-rear-port data-port="${key}">${allKeys(curDev).map((k) => {
      const busy = idx.rear.has(k) && k !== cur;
      const { gi, pi } = parseKey(k);
      return `<option value="${k}"${k === cur ? ' selected' : ''}${busy ? ' disabled' : ''}>${esc(portLabel(curDev, gi, pi))}${busy ? ' (used)' : ''}</option>`;
    }).join('')}</select>` : '';
    let dest = '';
    if (cur) {
      const d = describePort(cur);
      const front = idx.byPort.get(cur);
      dest = `<div class="rear-dest" data-goto-any="${cur}" title="Click to show it">→ <b>${esc(d.text)}</b>
        <span>${esc(d.loc)} · front: ${front ? esc(describePort(otherEnd(front, cur)).text) : 'nothing plugged in'}</span></div>`;
    }
    return `<div class="rear"><div class="sub">Rear connection</div>
      <div class="rear-pick"><select data-rear-dev data-port="${key}"${panels.length ? '' : ' disabled'}>${devOpts}</select>${portSel}</div>${dest}
      ${cur ? '' : `<label class="field">Or goes to (not in this plan)<input data-pf="rearNote" data-port="${key}" value="${esc(portInfo(key).rearNote)}"
        placeholder="e.g. Office 2.14 wall jack" autocomplete="off"></label>`}</div>`;
  }

  // The full end-to-end path of a cable when it passes through panel rear links.
  function pathHTML(seq) {
    return `<h4>Full path</h4><ol class="path">${seq.map((s) => {
      const link = s.via === 'rear' ? '<li class="hop rear"><i></i>rear (structured cabling)</li>'
        : s.via === 'cable' ? `<li class="hop" style="--c:${esc(s.conn.color)}"><i></i>${esc(s.conn.label || 'patch cable')}</li>` : '';
      if (!s.key) return `${link}<li class="node off"><b>${esc(s.note)}</b><span>not in this plan</span></li>`;
      const p = describePort(s.key);
      return `${link}<li class="node" data-goto-any="${s.key}" title="Click to show it"><b>${esc(p.dev?.name)}</b> · ${esc(p.port)}<span>${esc(p.loc)}</span></li>`;
    }).join('')}</ol>`;
  }

  function rearSummaryHTML(dev) {
    const keys = allKeys(dev);
    const linked = keys.filter((k) => idx.rear.has(k));
    const targets = new Map();
    for (const k of linked) {
      const t = idx.dev.get(parseKey(idx.rear.get(k)).devId);
      const label = `${t.name} (${idx.rack.get(t.rackId)?.name})`;
      targets.set(label, (targets.get(label) || 0) + 1);
    }
    const panels = passiveDevices(dev.id);
    return `<h4>Rear connections</h4>
      <p>${linked.length} of ${keys.length} ports linked at the rear${targets.size ? `: ${[...targets].map(([t, n]) => `${esc(t)} ×${n}`).join(', ')}` : ''}.</p>
      ${panels.length ? `<div class="trunk"><select data-trunk-dev>${panels.map((d) => `<option value="${d.id}">${esc(d.name)} · ${esc(idx.rack.get(d.rackId)?.name)} U${d.u}</option>`).join('')}</select>
        <button class="btn small" data-act="trunk">Link ports 1:1</button></div>
        <p class="hint">Links port 1 to port 1, 2 to 2 and so on, replacing existing rear links on those ports. Set single ports by clicking them.</p>`
        : '<p class="hint">Add another patch panel (in any rack) to link this one to it.</p>'}
      ${linked.length ? '<div class="row"><button class="btn small" data-act="rear-clear">Clear rear links</button></div>' : ''}`;
  }

  // Right-hand panel. Shows, in priority order: the pending port while a cable
  // is being made, the selected connection, the selected device, or the overview.
  function renderInspector() {
    const el = $('#inspector');
    const c = ui.conn && idx.conn.get(ui.conn);
    const dev = ui.device && idx.dev.get(ui.device);

    if (ui.pending) {
      const p = describePort(ui.pending);
      el.innerHTML = `<div class="insp"><h3>Port</h3>
        <div class="endpoint"><div class="ep-tag">Selected · no cable</div><div class="ep-dev">${esc(p.dev?.name)}</div><div class="ep-port">${esc(p.port)}</div><div class="ep-loc">${esc(p.loc)}</div></div>
        ${portFieldsHTML(ui.pending)}
        <h4>Add a cable</h4>
        <p>Click the port at the other end of the cable. It can be in any rack.</p>
        <p>Press <kbd>Esc</kbd> or click the same port again to cancel.</p>
        <div class="field">Cable color<div class="swatches">${swatchesHTML(ui.color, 'data-newcolor')}</div></div></div>`;
      return;
    }

    if (ui.multi.length) {
      const rows = ui.multi.map((key) => {
        const p = describePort(key);
        const mc = idx.byPort.get(key);
        let where = '<span class="muted">No cable</span>';
        if (mc) {
          where = `→ ${esc(describePort(otherEnd(mc, key)).text)}${mc.label ? ` <span class="muted">“${esc(mc.label)}”</span>` : ''}`;
          const path = tracePath(mc, key);
          const last = path.seq[path.seq.length - 1];
          if (path.extended) where += `<br><span class="muted">ends at ${esc(last.key ? `${describePort(last.key).text} (${describePort(last.key).loc})` : last.note)}</span>`;
        } else if (rearText(key)) {
          where += `<br><span class="muted">rear → ${esc(rearText(key))}</span>`;
        }
        const extra = [netSummary(key), portInfo(key).details && shorten(portInfo(key).details.replace(/\s+/g, ' '), 60)].filter(Boolean).join(' · ');
        return `<li data-mkey="${key}" style="--c:${esc(mc ? mc.color : '#4b5563')}" title="Click to show the other end"><span class="dot"></span>
          <span class="m-body"><b>${esc(p.text)}</b> <span class="muted">${esc(p.loc)}</span><br>${where}${extra ? `<br><span class="muted">${esc(extra)}</span>` : ''}</span>
          <button class="m-x" data-unmulti="${key}" title="Remove from selection">×</button></li>`;
      }).join('');
      el.innerHTML = `<div class="insp"><h3>${ui.multi.length} port${ui.multi.length === 1 ? '' : 's'} selected</h3>
        <p class="hint">Ctrl+click ports to add or remove them. Click a row to jump to its other end. <kbd>Esc</kbd> clears.</p>
        <ul class="conn-list multi-list">${rows}</ul>
        <div class="row"><button class="btn small" data-act="multi-clear">Clear selection</button></div></div>`;
      return;
    }

    if (c) {
      const farKey = ui.origin === c.a ? c.b : c.a;
      const nearKey = otherEnd(c, farKey);
      const ep = (key, far) => {
        const p = describePort(key);
        return `<div class="endpoint${far ? ' far' : ''}" data-goto="${key}" title="Click to jump to this end">
          <div class="ep-tag">${far ? 'Other end' : 'You clicked'}</div>
          <div class="ep-dev">${esc(p.dev?.name)}</div><div class="ep-port">${esc(p.port)}</div><div class="ep-loc">${esc(p.loc)}</div></div>`;
      };
      const path = tracePath(c);
      el.innerHTML = `<div class="insp" data-scope="conn"><h3>Connection</h3>
        ${loops.conns.has(c.id) ? loopListHTML(loops.issues.filter((i) => i.links.some((l) => l.conns.has(c.id)))) : ''}
        ${path.extended ? pathHTML(path.seq) : ''}
        ${ep(nearKey, false)}${portFieldsHTML(nearKey)}
        <div class="link-line" style="--c:${esc(c.color)}"><i></i>${c.label ? esc(c.label) : 'cable'}</div>
        ${ep(farKey, true)}${portFieldsHTML(farKey)}
        <div style="height:14px"></div>
        <label class="field">Cable label / ID<input data-f="label" value="${esc(c.label)}" placeholder="e.g. CAB-0142"></label>
        <div class="field">Color<div class="swatches">${swatchesHTML(c.color, 'data-conncolor')}</div></div>
        <div class="row"><button class="btn danger" data-act="del-conn">Disconnect</button></div></div>`;
      return;
    }

    if (dev) {
      const rack = idx.rack.get(dev.rackId);
      const conns = [];
      dev.groups.forEach((g, gi) => { for (let pi = 0; pi < g.count; pi++) { const k = portKey(dev.id, gi, pi); const cc = idx.byPort.get(k); if (cc) conns.push(connRow(cc, k)); } });
      const range = dev.height > 1 ? `U${dev.u}–${dev.u + dev.height - 1}` : `U${dev.u}`;
      el.innerHTML = `<div class="insp" data-scope="dev"><h3>Device</h3>
        ${loopListHTML(loops.issues.filter((i) => i.devs.includes(dev.id) || i.links.some((l) => l.ports.some((k) => parseKey(k).devId === dev.id))))}
        <label class="field">Name<input data-f="name" value="${esc(dev.name)}"></label>
        <div class="kv"><span>Rack</span><b>${esc(rack?.name)}</b><span>Position</span><b>${range}</b><span>Height</span><b>${dev.height}U</b>
          <span>Ports</span><b>${portCount(dev)} (${conns.length} connected)</b></div>
        <label class="field">Notes<textarea data-f="notes" placeholder="Serial, asset tag, IP, owner…">${esc(dev.notes)}</textarea></label>
        ${dev.groups.length ? `<h4>Port layout</h4>
        <div class="glayout">
          <span class="gl-head">Ports</span><span class="gl-head">Rows</span><span class="gl-head">Numbering</span>
          ${dev.groups.map((g, gi) => `
            <span class="gl-name">${esc(g.label || g.kind.toUpperCase())} <span class="muted">×${g.count}</span></span>
            <input type="number" min="1" max="${Math.min(dev.height * 2, g.count)}" value="${clamp(g.rows || 1, 1, dev.height * 2)}" data-grows="${gi}" title="Max ${dev.height * 2} rows for a ${dev.height}U device">
            <select data-gnum="${gi}"><option value="seq"${g.numbering !== 'oddeven' ? ' selected' : ''}>Left → right</option><option value="oddeven"${g.numbering === 'oddeven' ? ' selected' : ''}>Odd top / even bottom</option></select>`).join('')}
        </div>` : ''}
        ${isPassive(dev) ? rearSummaryHTML(dev) : ''}
        <h4>Connections</h4>
        ${conns.length ? `<ul class="conn-list">${conns.join('')}</ul>` : '<p>No ports connected yet.</p>'}
        <div class="row">
          <button class="btn" data-act="dup-dev">Duplicate</button>
          ${conns.length ? '<button class="btn" data-act="disc-all">Disconnect all</button>' : ''}
          <button class="btn danger" data-act="del-dev">Delete</button>
        </div></div>`;
      return;
    }

    const conns = state.connections.map((cc) => connRow(cc, cc.a)).join('');
    el.innerHTML = `<div class="insp"><h3>Overview</h3>
      <div class="stats">
        <div class="stat"><b>${state.racks.length}</b><span>racks</span></div>
        <div class="stat"><b>${state.devices.length}</b><span>devices</span></div>
        <div class="stat"><b>${state.connections.length}</b><span>cables</span></div>
      </div>
      ${loopListHTML(loops.issues)}
      <h4>How to use</h4>
      <ol>
        <li>Drag equipment from the left into a rack. Drag a device to move it, even to another rack.</li>
        <li>Click a port, then click another port to connect them with a cable.</li>
        <li>Click any connected port to highlight the other end.</li>
        <li>Click any port to add details. On a patch panel you can also set where its rear goes, even to another rack.</li>
        <li>Hold <kbd>Ctrl</kbd> and click ports to see several cables at once.</li>
        <li>Cables that form a network loop pulse red, and a warning appears at the top.</li>
        <li>Click a device body to rename it, add notes or delete it.</li>
      </ol>
      <p><kbd>Esc</kbd> clear selection · <kbd>Del</kbd> delete selected · <kbd>Ctrl</kbd>+<kbd>Z</kbd> undo · <kbd>Ctrl</kbd>+scroll zoom</p>
      <h4>All connections</h4>
      ${conns ? `<ul class="conn-list">${conns}</ul><div class="row"><button class="btn small" data-act="csv">Download CSV</button></div>` : '<p>No cables yet.</p>'}
    </div>`;
  }

  // ------------------------------------------------------------------
  // Actions
  // ------------------------------------------------------------------
  function clearSelection() {
    if (!ui.pending && !ui.conn && !ui.device && !ui.multi.length) return;
    ui.pending = null; ui.conn = null; ui.origin = null; ui.device = null; ui.multi = [];
    updateHighlights();
  }

  // The port-click state machine:
  //   connected port        → select its cable, pulse + scroll to the far end
  //   free port, none held  → hold it as the pending first end
  //   same pending port     → cancel
  //   another free port     → create the cable between the two
  //   Ctrl+click            → add/remove the port in the multi-selection
  //                           (a port already selected the normal way joins it)
  function onPortClick(key, multi = false) {
    if (multi) {
      const seed = ui.conn ? ui.origin : ui.pending;
      if (!ui.multi.length && seed && seed !== key) ui.multi = [seed];
      ui.multi = ui.multi.includes(key) ? ui.multi.filter((k) => k !== key) : [...ui.multi, key];
      ui.pending = null; ui.conn = null; ui.origin = null; ui.device = null;
      updateHighlights();
      return;
    }
    ui.multi = [];
    const existing = idx.byPort.get(key);
    if (existing) {
      ui.pending = null; ui.device = null; ui.conn = existing.id; ui.origin = key;
      updateHighlights();
      scrollToPort(otherEnd(existing, key));
      return;
    }
    if (!ui.pending) { ui.pending = key; ui.conn = null; ui.device = null; updateHighlights(); return; }
    if (ui.pending === key) { ui.pending = null; updateHighlights(); return; }
    const conn = { id: uid('c'), a: ui.pending, b: key, color: ui.color, label: '' };
    ui.pending = null; ui.conn = conn.id; ui.origin = key;
    commit(() => state.connections.push(conn));
  }

  function removeDeviceConns(devId) {
    state.connections = state.connections.filter((c) => parseKey(c.a).devId !== devId && parseKey(c.b).devId !== devId);
  }

  function deleteDevice(id) {
    commit(() => { removeDeviceConns(id); removeDeviceRear(id); state.devices = state.devices.filter((d) => d.id !== id); });
  }

  function addFromTemplate(tpl, rackId, u) {
    const d = newDevice(tpl, rackId, u);
    ui.device = d.id; ui.conn = null; ui.pending = null;
    commit(() => state.devices.push(d));
  }

  function autoPlace(tpl) {
    const preferRack = ui.device && idx.dev.get(ui.device)?.rackId;
    const slot = findFreeSlot(tpl.height, preferRack || state.racks[0]?.id);
    if (!slot) { alert(state.racks.length ? `No free ${tpl.height}U space in any rack.` : 'Add a rack first.'); return; }
    addFromTemplate(tpl, slot.rack.id, slot.u);
  }

  async function addRack() {
    const letter = String.fromCharCode(65 + (state.racks.length % 26));
    const v = await formDialog({
      title: 'Add rack', ok: 'Add rack',
      fields: [
        { name: 'name', label: 'Name', value: `Rack ${letter}`, required: true, wide: true },
        { name: 'units', label: 'Height (U)', type: 'number', value: 42, min: 1, max: 100, required: true },
      ],
    });
    if (!v) return;
    commit(() => state.racks.push({ id: uid('rack'), name: v.name.trim() || `Rack ${letter}`, units: clamp(v.units | 0, 1, 100) }));
    requestAnimationFrame(() => $('#workspace').scrollTo({ left: $('#workspace').scrollWidth, behavior: 'smooth' }));
  }

  async function editRack(id) {
    const rack = idx.rack.get(id);
    const v = await formDialog({
      title: 'Edit rack',
      fields: [
        { name: 'name', label: 'Name', value: rack.name, required: true, wide: true },
        { name: 'units', label: 'Height (U)', type: 'number', value: rack.units, min: 1, max: 100, required: true },
      ],
    });
    if (!v) return;
    const units = clamp(v.units | 0, 1, 100);
    const needed = Math.max(0, ...state.devices.filter((d) => d.rackId === id).map((d) => d.u + d.height - 1));
    if (units < needed) { alert(`Can't shrink to ${units}U: equipment is installed up to U${needed}. Move it down first.`); return; }
    commit(() => { rack.name = v.name.trim() || rack.name; rack.units = units; });
  }

  function deleteRack(id) {
    const rack = idx.rack.get(id);
    const n = state.devices.filter((d) => d.rackId === id).length;
    if (!confirm(`Delete "${rack.name}"${n ? ` and its ${n} device(s) and their cables` : ''}?`)) return;
    commit(() => {
      state.devices.filter((d) => d.rackId === id).forEach((d) => { removeDeviceConns(d.id); removeDeviceRear(d.id); });
      state.devices = state.devices.filter((d) => d.rackId !== id);
      state.racks = state.racks.filter((r) => r.id !== id);
    });
  }

  async function addCustomDevice() {
    const v = await formDialog({
      title: 'Custom device', ok: 'Add to palette',
      fields: [
        { name: 'name', label: 'Name', value: 'My Device', required: true, wide: true },
        { name: 'height', label: 'Height (U)', type: 'number', value: 1, min: 1, max: 20 },
        { name: 'skin', label: 'Look', type: 'select', value: 'generic', options: SKINS.map((s) => ({ value: s, label: s[0].toUpperCase() + s.slice(1) })) },
        { name: 'rj45', label: 'RJ45 ports', type: 'number', value: 8, min: 0, max: 96 },
        { name: 'rows', label: 'RJ45 rows', type: 'number', value: 1, min: 1, max: 40 },
        { name: 'sfp', label: 'SFP ports', type: 'number', value: 0, min: 0, max: 96 },
        { name: 'sfpRows', label: 'SFP rows', type: 'number', value: 1, min: 1, max: 40 },
        { name: 'lc', label: 'Fiber LC ports', type: 'number', value: 0, min: 0, max: 96 },
        { name: 'lcRows', label: 'LC rows', type: 'number', value: 1, min: 1, max: 40 },
        { name: 'power', label: 'Power ports', type: 'number', value: 0, min: 0, max: 48 },
        { name: 'powerRows', label: 'Power rows', type: 'number', value: 1, min: 1, max: 40 },
        { name: 'numbering', label: 'Numbering', type: 'select', value: 'seq', wide: true, options: [{ value: 'seq', label: 'Left → right' }, { value: 'oddeven', label: 'Odd top / even bottom' }] },
      ],
    });
    if (!v) return;
    const height = clamp(v.height | 0, 1, 20);
    const rowsFor = (n) => clamp(n | 0, 1, height * 2);
    const groups = [];
    if (v.rj45 > 0) groups.push(rj(v.rj45 | 0, rowsFor(v.rows), '', v.numbering));
    if (v.sfp > 0) groups.push(sfp(v.sfp | 0, rowsFor(v.sfpRows), 'SFP', v.numbering));
    if (v.lc > 0) groups.push({ kind: 'lc', count: v.lc | 0, rows: rowsFor(v.lcRows), label: 'LC', numbering: v.numbering });
    if (v.power > 0) groups.push(pwr(v.power | 0, 'PWR', rowsFor(v.powerRows)));
    const name = v.name.trim() || 'Custom';
    const tpl = { type: uid('custom'), cat: 'Custom', name, base: name, height, skin: v.skin, groups };
    commit(() => { state.custom = state.custom || []; state.custom.push(tpl); });
    renderPalette();
  }

  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  function exportCSV() {
    const q = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const side = (s) => [`${s} Rack`, `${s} U`, `${s} Device`, `${s} Port`, `${s} VLAN`, `${s} IP`, `${s} Subnet`, `${s} Rear`, `${s} Details`];
    const rows = [['Cable', 'Color', ...side('A'), ...side('B')]];
    const cells = (key) => {
      const p = describePort(key);
      const i = portInfo(key);
      return [idx.rack.get(p.dev?.rackId)?.name, p.dev?.u, p.dev?.name, p.port, i.vlan, i.ip, i.subnet, rearText(key), i.details];
    };
    for (const c of state.connections) {
      rows.push([c.label, c.color, ...cells(c.a), ...cells(c.b)]);
    }
    download('rack-connections.csv', rows.map((r) => r.map(q).join(',')).join('\r\n'), 'text/csv');
  }

  // ------------------------------------------------------------------
  // CSV rack import
  // ------------------------------------------------------------------
  // Builds a new rack from a spreadsheet exported as CSV. Row 1 is a header
  // and is skipped. Columns (spreadsheet letters):
  //   A patch panel · B patch panel port · D switch · E switch port
  //       → one cable per row (rows with no switch just list a panel port)
  //   I device, listed top of rack → bottom
  //   J Ethernet ports · K Ethernet rows · L SFP ports · M SFP rows
  //       Fiber panels ignore J/K (L/M become LC ports); patch panels ignore L/M.
  // A and D may be numbers or names. A number in A means "the Nth patch
  // panel" and in D "the Nth switch", counted in column I order; fiber panels
  // are never counted. Generic names in column I ("Patch Panel", "Switch",
  // "Fiber Panel") are numbered the same way, so the rack reads
  // "Patch Panel 2", "Switch 1" and so on. A name in A/D that isn't in
  // column I is added at the bottom, sized to the highest port it uses.
  const CSV_COL = { A: 0, B: 1, D: 3, E: 4, I: 8, J: 9, K: 10, L: 11, M: 12 };

  // RFC 4180-style parser. The delimiter (comma, semicolon or tab) is taken
  // from whichever appears most in the first line, which covers Excel's
  // regional CSV variants.
  function parseCSV(text) {
    text = text.replace(/^﻿/, '');
    const first = text.split(/\r?\n/, 1)[0];
    const delim = [',', ';', '\t'].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (quoted) {
        if (ch !== '"') cell += ch;
        else if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else if (ch === '"') quoted = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  // Visual style guessed from the device name in column I.
  function skinFromName(name) {
    const n = name.toLowerCase();
    const rules = [
      [/fib(er|re)\s*panel/, 'fiber'], [/patch\s*panel/, 'patch'], [/switch/, 'switch'], [/router/, 'router'],
      [/firewall/, 'firewall'], [/cable\s*manag/, 'cablemgmt'], [/shelf/, 'shelf'], [/blank/, 'blank'],
      [/\b(nas|san|storage)\b/, 'storage'], [/\b(ups|pdu|power)\b/, 'power'], [/\bkvm\b/, 'kvm'], [/server|host|hypervisor/, 'server'],
    ];
    return rules.find(([re]) => re.test(n))?.[1] || 'generic';
  }

  // A device from its name and port counts. Height is the number of units
  // needed for its port rows (2 rows per U), at least 1U. Blank row counts
  // default to 2 rows above 24 ports (like real 48-port gear), otherwise 1.
  // A patch panel, fiber panel or switch with no port counts gets 24 ports.
  function csvDevice(name, eth, ethRows, sfpN, sfpRows, skin = skinFromName(name)) {
    if (skin === 'fiber') eth = 0;
    if (skin === 'patch') sfpN = 0;
    if (!eth && !sfpN) { if (skin === 'patch' || skin === 'switch') eth = 24; if (skin === 'fiber') sfpN = 24; }
    ethRows = ethRows || (eth > 24 ? 2 : 1);
    sfpRows = sfpRows || (sfpN > 24 ? 2 : 1);
    const groups = [];
    const numbering = (rows) => (skin === 'switch' && rows > 1 ? 'oddeven' : 'seq');
    if (eth > 0) { const rows = clamp(ethRows || 1, 1, eth); groups.push({ kind: 'rj45', count: eth, rows, label: '', numbering: numbering(rows) }); }
    if (sfpN > 0) {
      const rows = clamp(sfpRows || 1, 1, sfpN);
      groups.push(skin === 'fiber'
        ? { kind: 'lc', count: sfpN, rows, label: 'LC', numbering: 'seq' }
        : { kind: 'sfp', count: sfpN, rows, label: 'SFP', numbering: numbering(rows) });
    }
    const height = Math.max(1, ...groups.map((g) => Math.ceil(g.rows / 2)));
    return { id: uid('dev'), rackId: null, u: 1, height, name, skin, template: 'csv', groups, notes: '', portInfo: {} };
  }

  // Turn a port cell ("12", "Gi1/0/12", "SFP 2", "Port 49") into a port key.
  // Numbers past the Ethernet ports continue into the SFP ports, the way
  // switches number their uplinks (on a 48 + 4 switch, port 49 is SFP 1).
  function csvPortKey(dev, text) {
    const n = +((String(text).match(/\d+/g) || []).pop() || 0);
    if (!n) return null;
    const eth = dev.groups.findIndex((g) => g.kind === 'rj45');
    const sfp = dev.groups.findIndex((g) => g.kind === 'sfp' || g.kind === 'lc');
    const ethCount = eth >= 0 ? dev.groups[eth].count : 0;
    if (/sfp|lc|fib/i.test(text) && sfp >= 0) return n <= dev.groups[sfp].count ? portKey(dev.id, sfp, n - 1) : null;
    if (eth >= 0 && n <= ethCount) return portKey(dev.id, eth, n - 1);
    if (sfp >= 0 && n - ethCount <= dev.groups[sfp].count) return portKey(dev.id, sfp, n - ethCount - 1);
    return null;
  }

  function csvToRack(rows) {
    const warnings = [];
    const cell = (r, c) => String(rows[r]?.[c] ?? '').trim();
    const num = (v) => { const n = parseInt(String(v).replace(/[^\d]/g, ''), 10); return Number.isFinite(n) && n > 0 ? Math.min(n, 400) : 0; };

    // Devices from column I, in rack order. Patch panels, fiber panels and
    // switches are each numbered in that order; for patch panels and
    // switches that number is what a bare "2" in column A or D refers to.
    const order = [];
    const counters = { patch: [], fiber: [], switch: [] };
    const byName = new Map();
    const seen = new Map();
    const generic = /^(patch\s*panel|fib(er|re)\s*panel|switch)$/i;
    for (let r = 1; r < rows.length; r++) {
      const raw = cell(r, CSV_COL.I);
      if (!raw) continue;
      const skin = skinFromName(raw);
      const list = counters[skin];
      const n = (seen.get(raw.toLowerCase()) || 0) + 1;
      seen.set(raw.toLowerCase(), n);
      const name = list && generic.test(raw) ? `${raw} ${list.length + 1}` : n > 1 ? `${raw} ${n}` : raw;
      const [eth, sfpN] = [num(cell(r, CSV_COL.J)), num(cell(r, CSV_COL.L))];
      const d = csvDevice(name, eth, num(cell(r, CSV_COL.K)), sfpN, num(cell(r, CSV_COL.M)), skin);
      const given = skin === 'fiber' ? sfpN : skin === 'patch' ? eth : eth + sfpN;
      if (!given && portCount(d)) warnings.push(`Row ${r + 1}: no port count for ${name}, so it was given ${portCount(d)} ports.`);
      order.push(d);
      if (list) list.push(d);
      if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), d);
    }

    // Column A/D reference → device: a number picks the Nth patch panel or
    // switch (fiber panels are not counted); anything else is a name.
    const missing = new Map();
    const resolve = (ref, kind) => (/^\d+$/.test(ref)
      ? counters[kind][+ref - 1] || null
      : byName.get(ref.toLowerCase()) || missing.get(ref.toLowerCase())?.dev || null);

    // Cable rows. A row with only A and B filled just lists an unused panel
    // port and is skipped quietly.
    const cables = [];
    for (let r = 1; r < rows.length; r++) {
      const [pp, ppPort, sw, swPort] = [cell(r, CSV_COL.A), cell(r, CSV_COL.B), cell(r, CSV_COL.D), cell(r, CSV_COL.E)];
      if (!sw && !swPort) continue;
      if (!pp || !ppPort || !sw || !swPort) { warnings.push(`Row ${r + 1}: skipped, a cable needs columns A, B, D and E.`); continue; }
      cables.push({ r, pp, ppPort, sw, swPort });
      // Names not in column I are created after the listed devices, sized
      // to the highest port used.
      for (const [ref, port, kind] of [[pp, ppPort, 'patch'], [sw, swPort, 'switch']]) {
        if (/^\d+$/.test(ref) || byName.has(ref.toLowerCase())) continue;
        const m = missing.get(ref.toLowerCase()) || { name: ref, max: 0, kind };
        m.max = Math.max(m.max, +((port.match(/\d+/g) || []).pop() || 0));
        missing.set(ref.toLowerCase(), m);
      }
    }
    for (const m of missing.values()) {
      const count = Math.max(24, Math.ceil(m.max / 24) * 24);
      const skin = skinFromName(m.name) === 'generic' ? m.kind : skinFromName(m.name);
      m.dev = csvDevice(m.name, count, 0, 0, 0, skin);
      order.push(m.dev);
      warnings.push(`“${m.name}” isn't listed in column I, so it was added at the bottom as a ${count}-port ${skin === 'patch' ? 'patch panel' : skin}.`);
    }

    const connections = [];
    const used = new Set();
    for (const c of cables) {
      const pd = resolve(c.pp, 'patch');
      const sd = resolve(c.sw, 'switch');
      if (!pd) { warnings.push(`Row ${c.r + 1}: there is no patch panel ${c.pp} in column I; cable skipped.`); continue; }
      if (!sd) { warnings.push(`Row ${c.r + 1}: there is no switch ${c.sw} in column I; cable skipped.`); continue; }
      const a = csvPortKey(pd, c.ppPort);
      const b = csvPortKey(sd, c.swPort);
      if (!a) { warnings.push(`Row ${c.r + 1}: ${pd.name} has no port ${c.ppPort}; cable skipped.`); continue; }
      if (!b) { warnings.push(`Row ${c.r + 1}: ${sd.name} has no port ${c.swPort}; cable skipped.`); continue; }
      if (a === b) { warnings.push(`Row ${c.r + 1}: both ends are the same port; cable skipped.`); continue; }
      const dup = [a, b].find((k) => used.has(k));
      if (dup) { warnings.push(`Row ${c.r + 1}: ${dup === a ? `${pd.name} port ${c.ppPort}` : `${sd.name} port ${c.swPort}`} already has a cable from an earlier row; skipped.`); continue; }
      used.add(a); used.add(b);
      connections.push({ id: uid('c'), a, b, color: ui.color, label: '' });
    }
    return { devices: order, connections, warnings, needed: order.reduce((n, d) => n + d.height, 0) };
  }

  async function importCSV(file) {
    const rows = parseCSV(await file.text());
    const res = csvToRack(rows);
    if (!res.devices.length) { alert('No devices found. Column I (from row 2 down) should list the devices in the rack, top to bottom.'); return; }
    const warn = res.warnings.length
      ? `<p class="warn-list">${res.warnings.length} note${res.warnings.length === 1 ? '' : 's'}:</p><ul class="warn-list">${res.warnings.slice(0, 40).map((w) => `<li>${esc(w)}</li>`).join('')}${res.warnings.length > 40 ? `<li>…and ${res.warnings.length - 40} more</li>` : ''}</ul>` : '';
    const list = res.devices.map((d) => `<li>${esc(d.name)} <span class="muted">${d.height}U · ${portCount(d)} ports</span></li>`).join('');
    const v = await formDialog({
      title: 'Build rack from CSV', ok: 'Create rack',
      note: `<p>${res.devices.length} devices (${res.needed}U) and ${res.connections.length} cables, placed top to bottom in this order:</p><ul>${list}</ul>${warn}`,
      fields: [
        { name: 'name', label: 'Rack name', value: file.name.replace(/\.[^.]+$/, ''), required: true },
        { name: 'units', label: `Height (U, at least ${res.needed})`, type: 'number', value: Math.max(42, res.needed), min: res.needed, max: 100, required: true },
      ],
    });
    if (!v) return;
    const units = clamp(v.units | 0, res.needed, 100);
    if (res.needed > 100) { alert(`These devices need ${res.needed}U, more than the 100U maximum for one rack.`); return; }
    const rack = { id: uid('rack'), name: v.name.trim() || 'Imported rack', units };
    let top = units;
    for (const d of res.devices) { d.rackId = rack.id; d.u = top - d.height + 1; top -= d.height; }
    ui.pending = ui.conn = ui.device = null; ui.multi = [];
    commit(() => {
      state.racks.push(rack);
      state.devices.push(...res.devices);
      state.connections.push(...res.connections);
    });
    requestAnimationFrame(() => $('#workspace').scrollTo({ left: $('#workspace').scrollWidth, behavior: 'smooth' }));
  }

  // ------------------------------------------------------------------
  // Dialog helper
  // ------------------------------------------------------------------
  // `note` is optional trusted HTML shown above the fields.
  function formDialog({ title, fields, ok = 'Save', note = '' }) {
    return new Promise((resolve) => {
      const dlg = $('#dlg');
      $('#dlg-title').textContent = title;
      $('#dlg-ok').textContent = ok;
      $('#dlg-fields').innerHTML = (note ? `<div class="dlg-note">${note}</div>` : '') + fields.map((f) => {
        const cls = `field${f.wide ? ' wide' : ''}`;
        if (f.type === 'select') {
          return `<label class="${cls}">${esc(f.label)}<select name="${f.name}">${f.options.map((o) => `<option value="${esc(o.value)}"${o.value === f.value ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>`;
        }
        const attrs = [f.min != null && `min="${f.min}"`, f.max != null && `max="${f.max}"`, f.required && 'required'].filter(Boolean).join(' ');
        return `<label class="${cls}">${esc(f.label)}<input name="${f.name}" type="${f.type || 'text'}" value="${esc(f.value)}" ${attrs}></label>`;
      }).join('');
      dlg.returnValue = '';
      dlg.addEventListener('close', () => {
        if (dlg.returnValue !== 'ok') return resolve(null);
        const fd = new FormData($('#dlg-form'));
        const out = {};
        for (const f of fields) out[f.name] = f.type === 'number' ? Number(fd.get(f.name)) || 0 : String(fd.get(f.name) ?? '');
        resolve(out);
      }, { once: true });
      dlg.showModal();
      dlg.querySelector('input')?.select();
    });
  }

  // ------------------------------------------------------------------
  // Events
  // ------------------------------------------------------------------
  // Side panels (equipment palette on the left, inspector on the right) can be
  // collapsed. The choice is per browser, remembered in localStorage.
  const panels = { left: true, right: true };
  try { Object.assign(panels, JSON.parse(localStorage.getItem('networkplanner.panels')) || {}); } catch { /* ignore */ }
  function applyPanels() {
    $('.layout').classList.toggle('hide-left', !panels.left);
    $('.layout').classList.toggle('hide-right', !panels.right);
    for (const [side, label] of [['left', 'equipment panel'], ['right', 'details panel']]) {
      const b = $(`#toggle-${side}`);
      b.setAttribute('aria-pressed', String(panels[side]));
      b.title = `${panels[side] ? 'Hide' : 'Show'} the ${label} (${side === 'left' ? '[' : ']'})`;
    }
    try { localStorage.setItem('networkplanner.panels', JSON.stringify(panels)); } catch { /* storage unavailable */ }
  }
  function togglePanel(side, show = !panels[side]) {
    panels[side] = show;
    applyPanels();
  }

  function bindEvents() {
    // Toolbar
    applyPanels();
    $('#toggle-left').addEventListener('click', () => togglePanel('left'));
    $('#toggle-right').addEventListener('click', () => togglePanel('right'));
    $('#btn-add-rack').addEventListener('click', addRack);
    // Loop warning: show the overview (which lists every loop) and the first loop.
    $('#loop-alert').addEventListener('click', () => {
      togglePanel('right', true);
      clearSelection();
      renderInspector();
      $('#inspector').scrollTo({ top: 0 });
      if (loops.issues[0]) scrollToPort(loops.issues[0].links[0].a);
    });
    $('#btn-undo').addEventListener('click', undo);
    $('#btn-export').addEventListener('click', () => download('rack-layout.json', JSON.stringify(state, null, 2), 'application/json'));
    $('#file-import').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const data = sanitize(JSON.parse(await file.text()));
        if (!confirm(`Replace the current layout with "${file.name}" (${data.racks.length} racks, ${data.devices.length} devices, ${data.connections.length} cables)? You can undo this.`)) return;
        ui.pending = ui.conn = ui.device = null;
        commit(() => { state = data; });
        renderPalette();
      } catch (err) {
        alert(`Could not import: ${err.message}`);
      }
    });
    $('#file-csv').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try { await importCSV(file); } catch (err) { alert(`Could not import the CSV: ${err.message}`); }
    });
    $('#cable-mode').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-mode]');
      if (!b) return;
      ui.mode = b.dataset.mode;
      $('#cable-mode').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
      drawCables();
    });
    const colorBar = $('#cable-color');
    colorBar.innerHTML = swatchesHTML(ui.color, 'data-newcolor');
    const setNewColor = (c) => {
      ui.color = c;
      document.querySelectorAll('[data-newcolor]').forEach((x) => x.classList.toggle('on', x.dataset.newcolor === c));
    };
    document.addEventListener('click', (e) => { const s = e.target.closest('[data-newcolor]'); if (s) setNewColor(s.dataset.newcolor); });

    const setZoom = (z) => { ui.zoom = clamp(Math.round(z * 100) / 100, 0.3, 1.6); sizeCanvas(); drawCables(); };
    $('#btn-zoom-in').addEventListener('click', () => setZoom(ui.zoom + 0.1));
    $('#btn-zoom-out').addEventListener('click', () => setZoom(ui.zoom - 0.1));
    $('#workspace').addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setZoom(ui.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    }, { passive: false });

    // Palette
    $('#palette').addEventListener('click', (e) => {
      if (e.target.closest('#btn-custom')) return addCustomDevice();
      const del = e.target.closest('[data-del-tpl]');
      if (del) {
        e.stopPropagation();
        commit(() => { state.custom = state.custom.filter((t) => t.type !== del.dataset.delTpl); });
        renderPalette();
        return;
      }
      const item = e.target.closest('.pal-item');
      if (item) autoPlace(findTpl(item.dataset.tpl));
    });

    // Racks: clicks
    $('#racks').addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]');
      if (act) {
        if (act.dataset.act === 'add-rack') addRack();
        if (act.dataset.act === 'edit-rack') editRack(act.dataset.rack);
        if (act.dataset.act === 'del-rack') deleteRack(act.dataset.rack);
        return;
      }
      const port = e.target.closest('.port');
      if (port) { onPortClick(port.dataset.p, e.ctrlKey || e.metaKey); return; }
      const dev = e.target.closest('.device');
      if (dev) { ui.device = dev.dataset.dev; ui.conn = null; ui.origin = null; ui.pending = null; ui.multi = []; updateHighlights(); }
    });
    $('#workspace').addEventListener('click', (e) => {
      if (!e.target.closest('.device, .port, [data-act], .rack-head')) clearSelection();
    });

    // Hovering a connected port outlines its far end
    $('#racks').addEventListener('mouseover', (e) => {
      const p = e.target.closest('.port');
      const c = p && idx.byPort.get(p.dataset.p);
      setPeek(c ? otherEnd(c, p.dataset.p) : null);
    });
    $('#racks').addEventListener('mouseleave', () => setPeek(null));

    // Drag & drop (native HTML5). `drag` remembers what is being dragged and
    // where it was grabbed, so the device lands where the cursor shows it.
    document.addEventListener('dragstart', (e) => {
      const el = e.target.closest ? e.target : e.target.parentElement;
      const pal = el?.closest('.pal-item');
      const head = el?.closest('.rack-head');
      if (head) {
        // Dragging a rack by its header reorders the racks.
        const rackEl = head.closest('.rack');
        drag = { rack: idx.rack.get(rackEl.dataset.rack), el: rackEl };
        setTimeout(() => rackEl.classList.add('dragging'), 0);
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', 'rack-planner');
        return;
      }
      if (pal) {
        const tpl = findTpl(pal.dataset.tpl);
        drag = { tpl, height: tpl.height, grab: (tpl.height * UPX) / 2 };
      } else {
        const devEl = el?.closest('.device');
        if (!devEl) return;
        const dev = idx.dev.get(devEl.dataset.dev);
        const r = devEl.getBoundingClientRect();
        drag = { dev, height: dev.height, grab: (e.clientY - r.top) / ui.zoom, el: devEl };
        setTimeout(() => devEl.classList.add('dragging'), 0);
      }
      e.dataTransfer.effectAllowed = 'copyMove';
      e.dataTransfer.setData('text/plain', 'rack-planner');
    });

    const hideGhosts = (except) => document.querySelectorAll('.ghost').forEach((g) => { if (g !== except) g.hidden = true; });
    const clearRackMarks = () => document.querySelectorAll('.rack.drop-before, .rack.drop-after').forEach((r) => r.classList.remove('drop-before', 'drop-after'));

    // Rack reordering: the drop position is before the first rack whose centre
    // is right of the cursor (or after the last rack). drag.slot = index in
    // state.racks to insert at, counted before the dragged rack is removed.
    function rackDragOver(e) {
      clearRackMarks();
      drag.slot = null;
      if (!e.target.closest?.('#workspace')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const els = [...document.querySelectorAll('#racks .rack')];
      let slot = els.findIndex((r) => { const b = r.getBoundingClientRect(); return e.clientX < b.left + b.width / 2; });
      if (slot === -1) slot = els.length;
      drag.slot = slot;
      if (slot < els.length) els[slot].classList.add('drop-before'); else els[els.length - 1]?.classList.add('drop-after');
    }

    // While dragging over a rack: convert the cursor's Y position to a rack
    // unit, check it fits, and move the green/red ghost there.
    document.addEventListener('dragover', (e) => {
      if (!drag) return;
      if (drag.rack) { rackDragOver(e); return; }
      const body = e.target.closest?.('.rack-body');
      const ghost = body?.querySelector('.ghost');
      hideGhosts(ghost);
      drag.target = null;
      if (!body) return;
      e.preventDefault();
      const rack = idx.rack.get(body.dataset.rack);
      const r = body.getBoundingClientRect();
      const y = (e.clientY - r.top) / ui.zoom;
      const h = drag.height;
      const topU = rack.units - Math.round((y - drag.grab) / UPX);
      const u = clamp(topU - h + 1, 1, Math.max(1, rack.units - h + 1));
      const ok = h <= rack.units && fits(rack, u, h, drag.dev?.id);
      ghost.hidden = false;
      ghost.classList.toggle('bad', !ok);
      ghost.style.top = `${(rack.units - (u + h - 1)) * UPX}px`;
      ghost.style.height = `${Math.min(h, rack.units) * UPX}px`;
      if (ok) drag.target = { rack, u };
      e.dataTransfer.dropEffect = ok ? (drag.dev ? 'move' : 'copy') : 'none';
    });

    document.addEventListener('drop', (e) => {
      if (!drag) return;
      e.preventDefault();
      if (drag.rack) {
        clearRackMarks();
        const from = state.racks.indexOf(drag.rack);
        const slot = drag.slot;
        if (slot == null || from === -1) return;
        const to = slot > from ? slot - 1 : slot;
        if (to === from) return;
        commit(() => { const [r] = state.racks.splice(from, 1); state.racks.splice(to, 0, r); });
        return;
      }
      const t = drag.target;
      const d = drag;
      hideGhosts();
      if (!t) return;
      if (d.dev) {
        ui.device = d.dev.id;
        commit(() => { const dev = idx.dev.get(d.dev.id); dev.rackId = t.rack.id; dev.u = t.u; });
      } else {
        addFromTemplate(d.tpl, t.rack.id, t.u);
      }
    });

    document.addEventListener('dragend', () => {
      drag?.el?.classList.remove('dragging');
      drag = null;
      hideGhosts();
      clearRackMarks();
    });

    // Inspector
    const insp = $('#inspector');
    insp.addEventListener('focusin', (e) => { if (e.target.matches('[data-f], [data-pf]')) editing = false; });
    insp.addEventListener('input', (e) => {
      const pf = e.target.dataset.pf;
      if (pf) {
        if (!editing) { pushUndo(); editing = true; }
        setPortInfo(e.target.dataset.port, pf, e.target.value);
        if (NET_FIELDS.some((n) => n.f === pf)) {
          e.target.classList.toggle('warn', !netValid(pf, e.target.value));
          e.target.title = netValid(pf, e.target.value) ? '' : `This doesn't look like a valid ${pf === 'vlan' ? 'VLAN list (1–4094)' : 'IPv4 address'}; it is saved anyway.`;
        }
        renderRacks({ inspector: false });
        scheduleSave();
        return;
      }
      const f = e.target.dataset.f;
      if (!f) return;
      if (!editing) { pushUndo(); editing = true; }
      const target = e.target.closest('[data-scope="conn"]') ? idx.conn.get(ui.conn) : idx.dev.get(ui.device);
      if (!target) return;
      target[f] = e.target.value;
      renderRacks({ inspector: false });
      scheduleSave();
    });
    // Port-group layout edits (rows / numbering) — port identities are unchanged, so cables survive
    insp.addEventListener('change', (e) => {
      // Rear connection pickers. Choosing a panel links to the same port
      // number on it if that's free, otherwise its first free port.
      const ds = e.target.dataset;
      if ('rearDev' in ds) {
        const key = ds.port;
        const target = idx.dev.get(e.target.value);
        if (!target) { commit(() => setRear(key, null)); return; }
        const keys = allKeys(target);
        const free = (k) => !idx.rear.has(k);
        const same = keys[flatIndex(key)];
        const pick = same && free(same) ? same : keys.find(free);
        if (!pick) { alert(`Every port on ${target.name} is already linked at the rear.`); renderInspector(); return; }
        commit(() => setRear(key, pick));
        return;
      }
      if ('rearPort' in ds) { commit(() => setRear(ds.port, e.target.value)); return; }
      const dev = ui.device && idx.dev.get(ui.device);
      if (!dev) return;
      const rowsGi = e.target.dataset.grows;
      const numGi = e.target.dataset.gnum;
      if (rowsGi != null) {
        const g = dev.groups[+rowsGi];
        const rows = clamp(parseInt(e.target.value, 10) || 1, 1, Math.min(dev.height * 2, g.count));
        commit(() => { g.rows = rows; });
      } else if (numGi != null) {
        commit(() => { dev.groups[+numGi].numbering = e.target.value; });
      }
    });
    insp.addEventListener('click', (e) => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      const c = ui.conn && idx.conn.get(ui.conn);
      if (act === 'del-conn' && c) { ui.conn = null; commit(() => { state.connections = state.connections.filter((x) => x.id !== c.id); }); return; }
      if (act === 'del-dev' && ui.device) { deleteDevice(ui.device); return; }
      if (act === 'disc-all' && ui.device) { const id = ui.device; commit(() => removeDeviceConns(id)); return; }
      if (act === 'dup-dev' && ui.device) {
        const src = idx.dev.get(ui.device);
        const slot = findFreeSlot(src.height, src.rackId);
        if (!slot) { alert(`No free ${src.height}U space available.`); return; }
        // IPs must be unique, so a duplicate starts with no network settings.
        const copy = { ...clone(src), id: uid('dev'), rackId: slot.rack.id, u: slot.u, name: `${src.name} (copy)`, portInfo: {} };
        ui.device = copy.id;
        commit(() => state.devices.push(copy));
        return;
      }
      if (act === 'csv') { exportCSV(); return; }
      if (act === 'trunk' && ui.device) {
        const src = idx.dev.get(ui.device);
        const dst = idx.dev.get(insp.querySelector('[data-trunk-dev]')?.value);
        if (!dst) return;
        const A = allKeys(src);
        const B = allKeys(dst);
        commit(() => { for (let i = 0; i < Math.min(A.length, B.length); i++) setRear(A[i], B[i]); });
        return;
      }
      if (act === 'rear-clear' && ui.device) { const id = ui.device; commit(() => removeDeviceRear(id)); return; }
      if (act === 'multi-clear') { clearSelection(); return; }
      const unm = e.target.closest('[data-unmulti]');
      if (unm) { ui.multi = ui.multi.filter((k) => k !== unm.dataset.unmulti); updateHighlights(); return; }
      const mrow = e.target.closest('li[data-mkey]');
      if (mrow) {
        const k = mrow.dataset.mkey;
        const mc = idx.byPort.get(k);
        const target = mc ? otherEnd(mc, k) : idx.rear.get(k) || k;
        scrollToPort(target); setPeek(target);
        return;
      }

      const ga = e.target.closest('[data-goto-any]');
      if (ga) { scrollToPort(ga.dataset.gotoAny); setPeek(ga.dataset.gotoAny); return; }

      const sw = e.target.closest('[data-conncolor]');
      if (sw && c) { commit(() => { c.color = sw.dataset.conncolor; }); return; }

      const goto = e.target.closest('[data-goto]');
      if (goto && c) { ui.origin = otherEnd(c, goto.dataset.goto); updateHighlights(); scrollToPort(goto.dataset.goto); return; }

      const li = e.target.closest('li[data-conn]');
      if (li) {
        const cc = idx.conn.get(li.dataset.conn);
        ui.conn = cc.id; ui.origin = li.dataset.origin; ui.device = null; ui.pending = null; ui.multi = [];
        updateHighlights();
        scrollToPort(otherEnd(cc, li.dataset.origin));
      }
    });

    // Keyboard
    document.addEventListener('keydown', (e) => {
      const typing = e.target.matches('input, textarea, select');
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) { e.preventDefault(); undo(); return; }
      if (typing || $('#dlg').open) return;
      if (e.key === 'Escape') clearSelection();
      if (e.key === '[' && !e.ctrlKey && !e.metaKey) togglePanel('left');
      if (e.key === ']' && !e.ctrlKey && !e.metaKey) togglePanel('right');
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (ui.conn) { const id = ui.conn; ui.conn = null; commit(() => { state.connections = state.connections.filter((x) => x.id !== id); }); }
        else if (ui.device) deleteDevice(ui.device);
      }
    });

    window.addEventListener('resize', () => drawCables());
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  // Start-up: load from server → else browser copy → else a starter rack.
  (async function init() {
    bindEvents();
    const { data, fromServer } = await load();
    state = data || defaultState();
    if (!state.custom) state.custom = [];
    rebuildIndex();
    renderPalette();
    renderRacks();
    if (fromServer) setStatus('Saved', 'ok');
    else scheduleSave();
  })();
})();
