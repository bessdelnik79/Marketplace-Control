async function updateCaptions() {
  await figma.loadAllPagesAsync();
  let updated = 0;
  for (const page of figma.root.children) {
    for (const frame of page.children.filter(n => n.type === 'FRAME' && n.name.startsWith('Desktop · '))) {
      const profit = frame.children.find(n => n.name === 'Прибыль');
      const now = frame.children.find(n => n.name === 'Сейчас / заказы');
      if (!profit || !now || !('children' in profit) || !('children' in now)) continue;
      const caption = profit.children.find(n => n.type === 'TEXT' && n.name === 'Delay' && n.characters === 'Финансовые данные · итог с задержкой до 14 дней');
      if (caption) caption.remove();
      for (const [name, size, y] of [['Current label', 16, 286], ['Average label', 16, 286], ['Unit', 14, 325]]) {
        const label = now.children.find(n => n.type === 'TEXT' && n.name === name);
        if (!label) continue;
        if (label.fontName === figma.mixed) throw new Error('Смешанные шрифты в ' + name);
        await figma.loadFontAsync(label.fontName);
        label.fontSize = size;
        label.lineHeight = {unit: 'PIXELS', value: size * 1.45};
        if (name === 'Unit') label.resize(120, label.height);
        label.y = y;
      }
      for (const name of ['Current legend', 'Average legend']) {
        const marker = now.children.find(n => n.name === name);
        if (marker) marker.y = 292;
      }
      updated++;
    }
  }
  if (!updated) throw new Error('Не найдены desktop-макеты Marketplace Control. Откройте файл с импортированными экранами.');
  figma.closePlugin('Обновлено desktop-экранов: ' + updated);
}
updateCaptions().catch(error => figma.closePlugin('Обновление остановлено: ' + error.message));
