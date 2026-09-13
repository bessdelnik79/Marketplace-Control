// The build script prepends the declarative design data to this runtime.
// No network, credentials, document deletion or third-party dependencies.
async function importMarketplaceControl() {
  await Promise.all(['Regular', 'Medium', 'Semi Bold'].map(style =>
    figma.loadFontAsync({ family: 'Inter', style })));
  const prefix = 'MC · ';
  const pageNames = ['Экраны', 'Компоненты', 'Стили'];
  const existing = pageNames.map(name => figma.root.children.find(p => p.name === prefix + name));
  if (existing.some(Boolean)) throw new Error('Макет MC уже импортирован. Используйте другой файл, чтобы не создавать дубликаты.');
  const empty = figma.root.children.filter(p => p.children.length === 0);
  const used = new Set();
  const pages = pageNames.map((name, i) => {
    const p = figma.root.children.find(p => p.name === name && !used.has(p.id)) || empty.find(p => !used.has(p.id)) || figma.createPage();
    used.add(p.id);
    p.name = prefix + name;
    return p;
  });
  const variables = {};
  for (const [theme, palette] of Object.entries(MC_DESIGN.palettes)) {
    let collection = (await figma.variables.getLocalVariableCollectionsAsync()).find(c => c.name === 'MC Import ' + theme);
    if (!collection) collection = figma.variables.createVariableCollection('MC Import ' + theme);
    collection.renameMode(collection.defaultModeId, theme);
    for (const [role, hex] of Object.entries(palette)) {
      const variable = figma.variables.createVariable(role, collection, 'COLOR');
      variable.scopes = ['FRAME_FILL', 'SHAPE_FILL', 'TEXT_FILL', 'STROKE_COLOR'];
      variable.setValueForMode(collection.defaultModeId, rgb(hex));
      variable.setVariableCodeSyntax('WEB', 'var(--mc-' + role + ')');
      variables[theme + '/' + role] = variable;
    }
  }
  function rgb(hex) {
    return { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 };
  }
  function paint(role, theme) {
    return figma.variables.setBoundVariableForPaint({ type: 'SOLID', color: rgb(MC_DESIGN.palettes[theme][role]) }, 'color', variables[theme + '/' + role]);
  }
  const components = new Map();
  const icons = new Map();
  function iconKey(spec, theme) { return theme + '/' + spec.path + '/' + (spec.stroke || '') + '/' + (spec.fill || ''); }
  const componentKeys = {};
  function flattenText(node, path = '', theme = 'Light') {
    const out = [];
    const key = path ? path + '/' + node.name : (node.component || node.name);
    if (node.kind === 'text') out.push([key, node.text]);
    if (node.kind === 'path') out.push([key, icons.get(iconKey(node, theme)).id]);
    for (const child of node.children || []) out.push(...flattenText(child, key, theme));
    return out;
  }
  function build(spec, parent, theme, asDefinition = false) {
    theme = spec.theme || theme;
    if (spec.component && !asDefinition) {
      const key = spec.component + '/' + theme + '/' + spec.w;
      const definition = components.get(key);
      if (!definition) throw new Error('Missing component ' + key);
      const instance = definition.createInstance();
      parent.appendChild(instance);
      instance.name = spec.name;
      const overrides = {};
      for (const [path, value] of flattenText(spec, '', theme)) overrides[componentKeys[key][path]] = value;
      instance.setProperties(overrides);
      instance.x = spec.x; instance.y = spec.y;
      return instance;
    }
    let node;
    if (spec.kind === 'text') {
      node = figma.createText();
      node.fontName = { family: 'Inter', style: spec.weight >= 600 ? 'Semi Bold' : spec.weight >= 500 ? 'Medium' : 'Regular' };
      node.fontSize = spec.size;
      node.lineHeight = { unit: 'PIXELS', value: spec.lineHeight || spec.size * 1.45 };
      node.characters = spec.text;
      node.textAutoResize = 'HEIGHT';
      node.resize(spec.w, Math.max(1, spec.h));
      node.textAlignHorizontal = spec.align || 'LEFT';
      node.fills = [paint(spec.fill || 'text', theme)];
    } else if (spec.kind === 'rect') {
      node = figma.createRectangle(); node.resize(spec.w, spec.h);
      node.fills = spec.fill ? [paint(spec.fill, theme)] : [];
      node.cornerRadius = spec.radius || 0;
    } else if (spec.kind === 'circle') {
      node = figma.createEllipse(); node.resize(spec.w, spec.h);
      node.fills = spec.fill ? [paint(spec.fill, theme)] : [];
    } else if (spec.kind === 'path') {
      node = icons.get(iconKey(spec, theme)).createInstance();
    } else {
      node = asDefinition ? figma.createComponent() : spec.layout ? figma.createAutoLayout(spec.layout) : figma.createFrame();
      node.resize(spec.w, spec.h);
      node.fills = spec.fill ? [paint(spec.fill, theme)] : [];
      node.cornerRadius = spec.radius || 0;
      node.clipsContent = false;
      if (spec.layout) {
        node.layoutMode = spec.layout;
        node.primaryAxisSizingMode = 'FIXED'; node.counterAxisSizingMode = 'FIXED';
        node.itemSpacing = spec.gap || 0;
        node.paddingLeft = node.paddingRight = spec.paddingX ?? spec.padding ?? 0;
        node.paddingTop = node.paddingBottom = spec.paddingY ?? spec.padding ?? 0;
        node.counterAxisAlignItems = 'CENTER';
      }
    }
    node.name = spec.name;
    if (spec.stroke && spec.kind !== 'path') { node.strokes = [paint(spec.stroke, theme)]; node.strokeWeight = spec.strokeWidth || 1; }
    parent.appendChild(node);
    node.x = spec.x || 0; node.y = spec.y || 0;
    const textNodes = {};
    for (const child of spec.children || []) build(child, node, theme);
    if (asDefinition) {
      // TEXT properties permit native edits in every placed instance.
      function expose(data, actual, path = '') {
        const key = path ? path + '/' + data.name : (data.component || data.name);
        if (data.kind === 'text') {
          const property = node.addComponentProperty(key, 'TEXT', data.text);
          actual.componentPropertyReferences = { characters: property };
          textNodes[key] = property;
        }
        if (data.kind === 'path') {
          const property = node.addComponentProperty(key, 'INSTANCE_SWAP', actual.mainComponent.id);
          actual.componentPropertyReferences = { mainComponent: property };
          textNodes[key] = property;
        }
        if (!data.component || actual === node) for (let i = 0; i < (data.children || []).length; i++) expose(data.children[i], actual.children[i], key);
      }
      expose(spec, node);
      return { node, textNodes };
    }
    return node;
  }
  await figma.setCurrentPageAsync(pages[1]);
  for (const screen of [...MC_DESIGN.screens, { ...MC_DESIGN.states, theme: 'Light' }]) {
    function collectIcons(spec) {
      if (spec.kind === 'path') {
        const key = iconKey(spec, screen.theme);
        if (!icons.has(key)) {
          const component = figma.createComponent();
          component.name = 'Icon/' + screen.theme + '/' + spec.name + '/' + (spec.stroke || spec.fill);
          component.resize(24, 24); component.fills = [];
          const vector = figma.createVector();
          vector.name = 'Editable vector';
          vector.vectorPaths = [{ windingRule: 'NONZERO', data: spec.path }];
          vector.fills = spec.fill ? [paint(spec.fill, screen.theme)] : [];
          vector.strokes = spec.stroke ? [paint(spec.stroke, screen.theme)] : [];
          vector.strokeWeight = spec.strokeWidth || 1.7;
          component.appendChild(vector);
          vector.x = vector.y = 0;
          pages[1].appendChild(component);
          component.x = 80 + (icons.size % 12) * 80;
          component.y = 80 + Math.floor(icons.size / 12) * 70;
          icons.set(key, component);
        }
      }
      for (const child of spec.children || []) collectIcons(child);
    }
    collectIcons(screen);
  }
  let componentY = 80 + Math.ceil(icons.size / 12) * 70;
  for (const screen of [...MC_DESIGN.screens, { ...MC_DESIGN.states, theme: 'Light' }]) {
    function collect(spec) {
      for (const child of spec.children || []) collect(child);
      if (!spec.component) return;
      const key = spec.component + '/' + screen.theme + '/' + spec.w;
      if (components.has(key)) return;
      const result = build(spec, pages[1], screen.theme, true);
      result.node.name = key;
      result.node.description = 'Редактируемый элемент Marketplace Control. Текст меняется в свойствах экземпляра. Иллюстративные данные, не прогноз.';
      result.node.x = 80; result.node.y = componentY;
      componentY += result.node.height + 40;
      components.set(key, result.node); componentKeys[key] = result.textNodes;
    }
    collect(screen);
  }
  await figma.setCurrentPageAsync(pages[0]);
  const frames = [];
  for (const spec of MC_DESIGN.screens) frames.push(build(spec, pages[0], spec.theme));
  await figma.setCurrentPageAsync(pages[2]);
  const stylesFrame = build(MC_DESIGN.styleSheet, pages[2], 'Light');
  // Existing foundation examples are preserved if importing into the original file.
  stylesFrame.y = Math.max(100, ...pages[2].children.filter(n => n !== stylesFrame).map(n => n.y + n.height + 80));
  const states = build(MC_DESIGN.states, pages[2], 'Light');
  states.x = 1800; states.y = 100;
  await figma.setCurrentPageAsync(pages[0]);
  figma.viewport.scrollAndZoomIntoView([frames[0]]);
  figma.closePlugin('Готово: 4 редактируемых экрана, компоненты и стили.');
}
importMarketplaceControl().catch(error => figma.closePlugin('Импорт остановлен: ' + error.message));
