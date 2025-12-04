// app.js

async function run() {
  await miro.onReady();
  const applyBtn = document.getElementById('applyBtn');
  const messageEl = document.getElementById('message');

  function showMessage(text, type = 'note') {
    messageEl.textContent = text;
    messageEl.className = type;
  }

  applyBtn.addEventListener('click', async () => {
    try {
      showMessage('Обработка выделения...', 'note');

      const mode = document.getElementById('mode').value;        // 'width' | 'height'
      const targetSize = Number(document.getElementById('targetSize').value) || 0;
      const columns = Math.max(1, Number(document.getElementById('columns').value) || 1);
      const rowsInput = Number(document.getElementById('rows').value) || 0;
      const maxRows = rowsInput > 0 ? rowsInput : null;
      const gapX = Math.max(0, Number(document.getElementById('gapX').value) || 0);
      const gapY = Math.max(0, Number(document.getElementById('gapY').value) || 0);

      if (targetSize <= 0) {
        showMessage('Размер должен быть больше 0', 'error');
        return;
      }

      const selection = await miro.board.getSelection();
      const images = selection.filter(item => item.type === 'image');

      if (!images.length) {
        showMessage('Выделите на доске изображения и попробуйте снова.', 'error');
        return;
      }

      images.sort((a, b) => {
        if (a.y === b.y) return a.x - b.x;
        return a.y - b.y;
      });

      const centerX = images.reduce((acc, item) => acc + item.x, 0) / images.length;
      const centerY = images.reduce((acc, item) => acc + item.y, 0) / images.length;

      const updatedImages = [];

      for (const img of images) {
        const newImg = { id: img.id };

        if (mode === 'width') {
          const scale = targetSize / img.width;
          newImg.width = targetSize;
          newImg.height = img.height * scale;
        } else if (mode === 'height') {
          const scale = targetSize / img.height;
          newImg.height = targetSize;
          newImg.width = img.width * scale;
        }

        updatedImages.push(newImg);
      }

      await miro.board.update({
        items: updatedImages
      });

      const updatedFull = await Promise.all(
        updatedImages.map(u => miro.board.get({ id: u.id }))
      );

      const total = updatedFull.length;
      const cols = columns;
      const rows = maxRows ? Math.min(maxRows, Math.ceil(total / cols)) : Math.ceil(total / cols);

      const avgWidth = updatedFull.reduce((acc, i) => acc + i.width, 0) / total;
      const avgHeight = updatedFull.reduce((acc, i) => acc + i.height, 0) / total;

      const gridWidth = (cols - 1) * (avgWidth + gapX);
      const gridHeight = (rows - 1) * (avgHeight + gapY);

      const startX = centerX - gridWidth / 2;
      const startY = centerY - gridHeight / 2;

      const positioned = [];
      for (let idx = 0; idx < total; idx++) {
        const item = updatedFull[idx];
        const row = Math.floor(idx / cols);
        const col = idx % cols;

        if (maxRows && row >= maxRows) break;

        const x = startX + col * (avgWidth + gapX);
        const y = startY + row * (avgHeight + gapY);

        positioned.push({
          id: item.id,
          x,
          y
        });
      }

      if (positioned.length) {
        await miro.board.update({
          items: positioned
        });
      }

      showMessage(`Готово! Обработано изображений: ${positioned.length}.`, 'success');
    } catch (e) {
      console.error(e);
      showMessage('Ошибка при обработке. Открой консоль браузера для подробностей.', 'error');
    }
  });
}

run();
