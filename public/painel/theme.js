// Carrega antes de pintar a página, para o tema escuro não piscar claro. Arquivo à parte porque a CSP não aceita script inline.
try {
  if (localStorage.getItem('roxa.theme') === 'dark') document.documentElement.dataset.theme = 'dark'
} catch {}
