/** Open this plugin's service inside the existing Magpie sidebar frame. */
(async () => {
  // The sandbox allows navigation but forbids fetch; Magpie starts the
  // plugin host before serving this entry. Its service URL also works in Web mode.
  const theme = await magpie.ready;
  const options = await magpie.options.get();
  const target = new URL(magpie.service || `http://127.0.0.1:${Number(options.port) || 3491}/`, location.href);
  target.searchParams.set('visible', magpie.visible === false ? 'false' : 'true');
  target.searchParams.set('theme', theme.dark ? 'dark' : 'light');
  target.searchParams.set('tokens', JSON.stringify(theme.tokens || {}));
  document.getElementById('retry').addEventListener('click', () => location.reload());
  setTimeout(() => {
    document.getElementById('status').textContent = '路由监控服务暂未连接，请重试或检查插件日志';
    document.getElementById('retry').hidden = false;
  }, 7000);
  location.replace(target.href);
})().catch(() => {
  document.getElementById('status').textContent = '路由监控暂未连接，请重新打开这个页面';
  document.getElementById('retry').hidden = false;
});
