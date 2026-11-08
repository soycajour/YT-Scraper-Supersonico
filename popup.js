document.getElementById('btn').addEventListener('click', async () => {
  const limit = parseInt(document.getElementById('limit').value) || 0;
  document.getElementById('status').innerText = "Iniciando extracción agresiva...";
  
  let [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrapeYouTube,
    args: [limit] // Pasamos el límite a la función
  }, (results) => {
    if (results && results[0] && results[0].result) {
      const links = results[0].result;
      if (links.length === 0) {
        document.getElementById('status').innerText = "Error: No se detectaron videos.";
        return;
      }
      
      const content = links.join('\n');
      const blob = new Blob([content], { type: 'text/plain' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `youtube_links_${links.length}.txt`;
      a.click();
      
      document.getElementById('status').innerText = `¡${links.length} enlaces capturados!`;
    }
  });
});

async function scrapeYouTube(limit) {
  return new Promise((resolve) => {
    let lastHeight = 0;
    let retries = 0;

    let scrollInterval = setInterval(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      let currentHeight = document.documentElement.scrollHeight;
      
      // Verificamos si ya tenemos suficientes links antes de seguir haciendo scroll
      const currentLinks = document.querySelectorAll('a[href^="/watch?v="]').length;
      
      // Si hay límite y ya lo alcanzamos (con margen), paramos el scroll
      if (limit > 0 && currentLinks >= limit) {
        clearInterval(scrollInterval);
        extractLinks();
        return;
      }

      if (currentHeight === lastHeight) {
        retries++;
        if (retries > 4) { 
          clearInterval(scrollInterval);
          extractLinks();
        }
      } else {
        retries = 0;
        lastHeight = currentHeight;
      }
    }, 800);

    function extractLinks() {
      const anchors = document.querySelectorAll('a[href^="/watch?v="]');
      const links = new Set();
      
      for (let a of anchors) {
        let cleanUrl = "https://www.youtube.com" + a.getAttribute('href').split('&')[0];
        links.add(cleanUrl);
        
        // Si alcanzamos el límite exacto, dejamos de añadir al Set
        if (limit > 0 && links.size === limit) break;
      }
      
      resolve(Array.from(links));
    }
  });
}