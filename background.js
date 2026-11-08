// YT Scraper Supersónico - Background Service Worker
// Despliega o alterna directamente el Modal Flotante dentro de la pestaña activa de YouTube

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  try {
    // 1. Intentar alternar si ya está inyectado en la página (además verifica la URL real dentro de la pestaña sin requerir permiso "tabs")
    const checkResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        const host = (window.location && window.location.hostname) || "";
        const isYT =
          host.includes("youtube.com") || host.includes("youtu.be");

        if (!isYT) {
          alert(
            "YT Scraper Supersónico: Abre una pestaña de YouTube (canal, videos, shorts, búsqueda o playlist) para usar el panel extractor."
          );
          return { isYT: false, alreadyLoaded: false };
        }

        if (
          window.__YT_SCRAPER_SUPERSONICO__ &&
          typeof window.__YT_SCRAPER_SUPERSONICO__.toggleModal === "function"
        ) {
          window.__YT_SCRAPER_SUPERSONICO__.toggleModal();
          return { isYT: true, alreadyLoaded: true };
        }

        return { isYT: true, alreadyLoaded: false };
      }
    });

    const info = checkResult && checkResult[0] && checkResult[0].result;
    if (!info || !info.isYT) return;

    // 2. Si estamos en YouTube y aún no estaba cargado, inyectar content-modal.js
    if (!info.alreadyLoaded) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content-modal.js"]
      });
    }
  } catch (err) {
    console.error("Error al abrir YT Scraper Supersónico:", err);
  }
});
