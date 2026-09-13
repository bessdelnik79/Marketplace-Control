// Native editable layers. Existing layers are never removed or overwritten.
// Re-running resumes only layers tagged by this version of the importer.
async function mcImportV2() {
  // Scripter bundles older typings; detect modern methods dynamically.
  if (typeof figma['loadAllPagesAsync'] === 'function') await figma['loadAllPagesAsync']();
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Medium' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Semi Bold' });
  function color(hex) {
    return { r: parseInt(hex.slice(1, 3), 16) / 255, g: parseInt(hex.slice(3, 5), 16) / 255, b: parseInt(hex.slice(5, 7), 16) / 255 };
  }
  function fill(role, theme) {
    return { type: 'SOLID', color: color(MC_DESIGN.palettes[theme][role]) };
  }
  function page(name) {
    var found = figma.root.children.find(function(p) { return p.name === 'MC · ' + name; });
    if (!found) found = figma.root.children.find(function(p) { return p.name === name; });
    if (!found) found = figma.createPage();
    found.name = 'MC · ' + name;
    return found;
  }
  async function selectPage(p) {
    if (typeof figma['setCurrentPageAsync'] === 'function') await figma['setCurrentPageAsync'](p);
    else figma.currentPage = p;
  }
  function make(spec, parent, inheritedTheme, key) {
    var theme = spec.theme || inheritedTheme;
    var node = parent.children.find(function(n) { return n.getPluginData('mc-import-v2') === key; });
    if (!node) {
      if (spec.kind === 'text') node = figma.createText();
      else if (spec.kind === 'rect') node = figma.createRectangle();
      else if (spec.kind === 'circle') node = figma.createEllipse();
      else if (spec.kind === 'path') node = figma.createVector();
      else node = figma.createFrame();
      parent.appendChild(node);
      node.setPluginData('mc-import-v2', key);
    }
    node.name = spec.name;
    if (spec.kind === 'text') {
      node.fontName = { family: 'Inter', style: spec.weight >= 600 ? 'Semi Bold' : spec.weight >= 500 ? 'Medium' : 'Regular' };
      node.fontSize = spec.size;
      node.lineHeight = { unit: 'PIXELS', value: spec.lineHeight || spec.size * 1.45 };
      node.characters = spec.text;
      node.textAutoResize = 'HEIGHT';
      node.resize(spec.w, Math.max(1, spec.h));
      node.textAlignHorizontal = spec.align || 'LEFT';
      node.fills = [fill(spec.fill || 'text', theme)];
    } else if (spec.kind === 'path') {
      node.vectorPaths = [{ windingRule: 'NONZERO', data: spec.path }];
      node.fills = spec.fill ? [fill(spec.fill, theme)] : [];
    } else {
      node.resize(spec.w, spec.h);
      node.fills = spec.fill ? [fill(spec.fill, theme)] : [];
      if (spec.kind !== 'circle') node.cornerRadius = spec.radius || 0;
      if (node.type === 'FRAME') {
        node.clipsContent = false;
        if (spec.layout) {
          node.layoutMode = spec.layout;
          node.primaryAxisSizingMode = 'FIXED';
          node.counterAxisSizingMode = 'FIXED';
          node.itemSpacing = spec.gap || 0;
          node.paddingLeft = node.paddingRight = spec.paddingX !== undefined ? spec.paddingX : (spec.padding || 0);
          node.paddingTop = node.paddingBottom = spec.paddingY !== undefined ? spec.paddingY : (spec.padding || 0);
          node.counterAxisAlignItems = 'CENTER';
        }
      }
    }
    node.strokes = spec.stroke ? [fill(spec.stroke, theme)] : [];
    if (spec.stroke) node.strokeWeight = spec.strokeWidth || (spec.kind === 'path' ? 1.7 : 1);
    node.x = spec.x || 0;
    node.y = spec.y || 0;
    var children = spec.children || [];
    for (var i = 0; i < children.length; i++) make(children[i], node, theme, key + '/' + i);
    return node;
  }
  var screensPage = page('Экраны');
  var stylesPage = page('Стили');
  await selectPage(screensPage);
  var frames = [];
  for (var i = 0; i < MC_DESIGN.screens.length; i++) {
    frames.push(make(MC_DESIGN.screens[i], screensPage, MC_DESIGN.screens[i].theme, 'screen/' + i));
  }
  await selectPage(stylesPage);
  var oldBottom = 100;
  for (var j = 0; j < stylesPage.children.length; j++) {
    var old = stylesPage.children[j];
    if (!old.getPluginData('mc-import-v2')) oldBottom = Math.max(oldBottom, old.y + old.height + 80);
  }
  var styles = make(MC_DESIGN.styleSheet, stylesPage, 'Light', 'styles');
  styles.y = oldBottom;
  var states = make(MC_DESIGN.states, stylesPage, 'Light', 'states');
  states.x = 1800;
  states.y = 100;
  await selectPage(screensPage);
  figma.viewport.scrollAndZoomIntoView([frames[0]]);
  figma.notify('Готово: 4 редактируемых экрана. Старые слои сохранены.');
}
await mcImportV2();
