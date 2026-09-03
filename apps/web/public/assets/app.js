(() => {
  const runtimeState = document.getElementById('runtime-state');
  const runtimeLabel = document.getElementById('runtime-label');
  const buildLabel = document.getElementById('build-label');
  const webLedger = document.getElementById('web-ledger');

  function setRuntime(ok, payload) {
    const sha =
      ok && payload && typeof payload.build_sha === 'string' ? payload.build_sha : 'unknown';
    if (runtimeState) runtimeState.classList.toggle('is-offline', !ok);
    if (runtimeLabel) runtimeLabel.textContent = ok ? '在线' : '不可用';
    if (webLedger) webLedger.textContent = ok ? 'ONLINE' : 'OFFLINE';
    if (buildLabel) {
      buildLabel.textContent = sha === 'development' ? 'LOCAL' : sha.slice(0, 8).toUpperCase();
    }
  }

  fetch('/better-agent/api/healthz', { credentials: 'same-origin', cache: 'no-store' })
    .then((response) => {
      if (!response.ok) throw new Error(`health response ${response.status}`);
      return response.json();
    })
    .then((payload) => {
      setRuntime(payload && payload.status === 'ok', payload);
    })
    .catch(() => {
      setRuntime(false, null);
    });

  const links = Array.prototype.slice.call(document.querySelectorAll('.rail-link'));
  function syncRoute() {
    const route = window.location.hash.slice(1) || 'overview';
    links.forEach((link) => {
      link.classList.toggle('is-active', link.dataset.route === route);
    });
  }
  window.addEventListener('hashchange', syncRoute);
  syncRoute();
})();
