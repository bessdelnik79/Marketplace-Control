import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { design, current, average, renderSvg } from './build-editable.mjs';

function walk(spec) { return [spec, ...(spec.children || []).flatMap(walk)]; }
test('desktop profit omits delay caption and current chart labels are raised and larger', () => {
  for (const screen of design.screens.filter(s => s.name.startsWith('Desktop'))) {
    const profit = screen.children.find(n => n.name === 'Прибыль');
    assert.ok(!profit.children.some(n => n.name === 'Delay'));
    const now = screen.children.find(n => n.name === 'Сейчас / заказы');
    for (const name of ['Current label', 'Average label']) {
      const label = now.children.find(n => n.name === name);
      assert.equal(label.size, 16);
      assert.equal(label.y, 286);
    }
    assert.equal(now.children.find(n => n.name === 'Unit').size, 14);
    assert.equal(now.children.find(n => n.name === 'Unit').y, 325);
  }
});
test('all vector paths use explicit Figma-compatible M L C Z commands', () => {
  for (const spec of [...design.screens, design.states, design.styleSheet]) {
    for (const node of walk(spec).filter(n => n.kind === 'path')) {
      const tokens = node.path.trim().split(/\s+/);
      let index = 0;
      assert.equal(tokens[0], 'M');
      while (index < tokens.length) {
        const command = tokens[index++];
        assert.ok(['M', 'L', 'C', 'Z'].includes(command), node.path);
        const count = command === 'C' ? 6 : command === 'Z' ? 0 : 2;
        for (let i = 0; i < count; i++) assert.ok(Number.isFinite(Number(tokens[index++])), node.path);
      }
    }
  }
});
test('four screens, desktop 16:9, independent financial and current periods', () => {
  assert.equal(design.screens.length, 4);
  for (const screen of design.screens) {
    assert.ok(['Light', 'Dark'].includes(screen.theme));
    assert.equal(screen.w, screen.name.startsWith('Desktop') ? 1920 : 390);
    if (screen.w === 1920) {
      assert.equal(screen.w / screen.h, 16 / 9);
      const labels = walk(screen).filter(n => n.kind === 'text').map(n => n.text).join('\n');
      assert.match(labels, /1–7 сентября 2026/);
      assert.match(labels, /8–13 сентября 2026/);
      assert.match(labels, /Выкупы/);
      assert.match(labels, /КОНТРОЛЬНЫЕ ТОЧКИ/);
      assert.ok(!walk(screen).some(n => /previous|next|back/i.test(n.name) && n.kind === 'path'));
    }
  }
});
test('six pairs compare daily orders with daily historical mean', () => {
  assert.equal(current.reduce((a, b) => a + b), 42);
  assert.equal(average.reduce((a, b) => a + b), 34);
  assert.equal(((42 / 34 - 1) * 100).toFixed(1), '23.5');
  const now = design.screens[0].children.find(n => n.name === 'Сейчас / заказы');
  const days = now.children.filter(n => n.name.startsWith('Day '));
  assert.equal(days.length, 6);
  for (const [i, day] of days.entries()) {
    assert.equal(day.children.find(n => n.name === 'Current bar').h / 6, current[i]);
    assert.equal(day.children.find(n => n.name === 'Average bar').h / 6, average[i]);
  }
});
test('editable SVG contains live text, no raster images, and valid palette roles', () => {
  for (const spec of [...design.screens, design.states, design.styleSheet]) {
    const svg = renderSvg(spec);
    assert.match(svg, /<text /);
    assert.ok(!svg.includes('<image') && !svg.includes('undefined'));
    for (const node of walk(spec)) {
      assert.ok(Number.isFinite(node.w) && Number.isFinite(node.h) && node.w > 0 && node.h > 0, node.name);
      for (const role of [node.fill, node.stroke].filter(Boolean)) assert.ok(role in design.palettes.Light && role in design.palettes.Dark, role);
    }
  }
});
for (const importer of ['figma-import/code.js', 'scripter-import.js', 'scripter-recovery.js']) test(importer + ' creates native layers without networking', async () => {
  let serial = 0;
  const all = [];
  class Node {
    constructor(type) { this.id = String(++serial); this.type = type; this._children = []; this.loaded = type !== 'PAGE'; this.props = {}; this.fills = []; this.x = 0; this.y = 0; this.width = 100; this.height = 100; all.push(this); }
    get children() { assert.ok(this.loaded, 'Page children accessed before explicit loading'); return this._children; }
    getPluginData(key) { return this.data?.[key] || ''; }
    setPluginData(key, value) { this.data ||= {}; this.data[key] = value; }
    resize(w, h) { assert.ok(w > 0 && h > 0); this.width = w; this.height = h; }
    appendChild(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = this; this.children.push(child); }
    addComponentProperty(name, type, value) { const key = name + '#' + serial++; this.props[key] = { type, value }; return key; }
    get mainComponent() { throw new Error('Synchronous mainComponent is forbidden with dynamic-page'); }
    createInstance() { assert.equal(this.type, 'COMPONENT'); const n = new Node('INSTANCE'); n.width = this.width; n.height = this.height; n._mainComponent = this; return n; }
    setProperties(values) { for (const [key, value] of Object.entries(values)) { assert.ok(this._mainComponent.props[key], 'Invalid override: ' + key); assert.equal(typeof value, 'string'); } this.overrides = values; }
  }
  const root = new Node('DOCUMENT'); root.appendChild(new Node('PAGE'));
  const collections = [];
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });
  const figma = {
    root, loadAllPagesAsync: async () => { for (const page of root.children) page.loaded = true; },
    loadFontAsync: async () => {}, setCurrentPageAsync: async page => { page.loaded = true; figma.currentPage = page; },
    createPage: () => { assert.ok(root.children.length < 3, 'Starter page cap'); const p = new Node('PAGE'); p.loaded = true; root.appendChild(p); return p; },
    variables: {
      getLocalVariableCollectionsAsync: async () => collections,
      createVariableCollection: name => { const c = { name, defaultModeId: 'default', renameMode() {} }; collections.push(c); return c; },
      createVariable: () => ({ setValueForMode() {}, setVariableCodeSyntax() {} }),
      setBoundVariableForPaint: paint => paint,
    },
    viewport: { scrollAndZoomIntoView() {} },
    closePlugin: message => resolveDone(message),
    notify: message => resolveDone(message),
  };
  for (const [fn, type] of Object.entries({ createFrame: 'FRAME', createAutoLayout: 'FRAME', createComponent: 'COMPONENT', createRectangle: 'RECTANGLE', createEllipse: 'ELLIPSE', createText: 'TEXT', createVector: 'VECTOR' })) figma[fn] = () => new Node(type);
  const source = readFileSync(new URL('./' + importer, import.meta.url), 'utf8');
  assert.ok(!/fetch\(|XMLHttpRequest|https:\/\//.test(source));
  vm.runInNewContext('(async () => {\n' + source + '\n})().catch(error => figma.closePlugin(error.message));', { figma, print: resolveDone });
  const message = await done;
  assert.match(message, /^Готово:/);
  assert.equal(root.children.length, 3);
  const screens = root.children.find(p => p.name === 'MC · Экраны');
  assert.equal(screens.children.length, 4);
  assert.ok(all.filter(n => n.type === 'TEXT').length > 100);
  if (importer === 'scripter-recovery.js') {
    const count = all.length;
    await vm.runInNewContext('(async () => {\n' + source + '\n})()', { figma });
    assert.equal(all.length, count, 'Recovery rerun must not duplicate layers');
    assert.ok(!source.includes('print('));
    return;
  }
  assert.ok(all.filter(n => n.type === 'INSTANCE').length > 30);
  assert.ok(all.filter(n => n.type === 'COMPONENT' && !n.name.startsWith('Icon/')).every(n => Object.keys(n.props).length > 0));
  assert.ok(all.filter(n => n.type === 'INSTANCE' && n.name === 'Icon').every(n => Object.values(n._mainComponent.props).length === 0));
  assert.ok(all.filter(n => n.type === 'COMPONENT').some(n => Object.values(n.props).some(p => p.type === 'INSTANCE_SWAP')));
  assert.ok(all.filter(n => n.type === 'TEXT').every(n => n.fontName.family === 'Inter'));
});
