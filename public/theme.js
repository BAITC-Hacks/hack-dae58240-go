// Переключатель темы (MD3 switch). По умолчанию светлая; выбор запоминается в браузере.
// Подключается в <head> без defer, чтобы тема применилась до отрисовки (без мигания).
(function () {
  const KEY = 'theme';
  const root = document.documentElement;
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch { /* хранилище недоступно — просто светлая */ }
  const apply = theme => { root.dataset.theme = theme; };
  apply(saved === 'dark' ? 'dark' : 'light');

  document.addEventListener('DOMContentLoaded', () => {
    const host = document.querySelector('.headerRight');
    if (!host) return;
    const label = document.createElement('label');
    label.className = 'themeSwitch';
    label.title = 'Тёмная тема';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.role = 'switch';
    input.setAttribute('aria-label', 'Тёмная тема');
    input.checked = root.dataset.theme === 'dark';
    const track = document.createElement('span');
    track.className = 'themeTrack';
    track.setAttribute('aria-hidden', 'true');
    track.innerHTML = '<span class="themeThumb"></span>';
    const text = document.createElement('span');
    text.className = 'themeLabel';
    text.textContent = 'Тёмная тема';
    input.addEventListener('change', () => {
      const theme = input.checked ? 'dark' : 'light';
      apply(theme);
      try { localStorage.setItem(KEY, theme); } catch { /* не критично */ }
    });
    label.append(input, track, text);
    host.prepend(label);
  });
})();
