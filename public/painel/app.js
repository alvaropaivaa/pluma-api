'use strict'

// ============ utilitários ============

/** Cria elemento. Texto sempre via textContent (nunca innerHTML com dado do servidor) */
function h(tag, attrs, ...children) {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v)
    else if (k === 'class') el.className = v
    else if (k === 'value') el.value = v
    else if (k === 'checked') el.checked = !!v
    else el.setAttribute(k, v === true ? '' : v)
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue
    el.append(c instanceof Node ? c : document.createTextNode(String(c)))
  }
  return el
}

// Ícones (traços no estilo Lucide). Constantes fixas deste arquivo, por isso podem ir como SVG
const ICONS = {
  phone: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/>',
  play: '<path d="m5 3 14 9-14 9V3z"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15z"/><path d="M6.5 17A2.5 2.5 0 0 0 4 19.5 2.5 2.5 0 0 0 6.5 22H20v-5"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  out: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v6M14 11v6"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  logout: '<path d="M18.4 5.6a9 9 0 1 1-12.8 0M12 2v10"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  arrow: '<path d="m15 18-6-6 6-6"/>',
  ext: '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 20h.01M2 9a15 15 0 0 1 20 0"/>',
  chart: '<path d="M3 21h18M6 21v-7h4v7M10 21V4h4v17M14 21v-11h4v11"/>',
  whatsapp: '<path d="M21 11.5a8.4 8.4 0 0 1-12.4 7.4L3 21l2.1-5.6A8.4 8.4 0 1 1 21 11.5z"/><path d="M9 9.5c0 3 2.5 5.5 5.5 5.5"/>',
  webhook: '<path d="M18 16.98h-5.99c-1.1 0-1.95.94-2.48 1.9A4 4 0 0 1 2 17c.01-.7.2-1.4.57-2"/><path d="m6 17 3.13-5.78c.53-.97.1-2.18-.5-3.1a4 4 0 1 1 6.89-4.06"/><path d="m12 6 3.13 5.73C15.66 12.7 16.9 13 18 13a4 4 0 0 1 0 8"/>',
  plug: '<path d="M12 22v-5M9 8V2M15 8V2M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8z"/>',
  building: '<path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18zM6 12H4a2 2 0 0 0-2 2v8h4M18 9h2a2 2 0 0 1 2 2v11h-4M10 6h4M10 10h4M10 14h4M10 18h4"/>',
  updown: '<path d="m7 15 5 5 5-5M7 9l5-5 5 5"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  collapse: '<path d="M4 4v16M20 12H9M14 7l-5 5 5 5"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M6.3 17.7l-1.4 1.4M19.1 4.9l-1.4 1.4"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  trendUp: '<path d="m22 7-8.5 8.5-5-5L2 17"/><path d="M16 7h6v6"/>',
  trendDown: '<path d="m22 17-8.5-8.5-5 5L2 7"/><path d="M16 17h6v-6"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 12 10 5 10-5M2 17l10 5 10-5"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
}
function icon(name) {
  const span = document.createElement('span')
  span.style.display = 'inline-flex'
  span.innerHTML = `<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`
  return span
}

async function api(path, opts = {}) {
  const headers = { 'x-painel': '1', ...(opts.headers || {}) }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const res = await fetch(path, { method: opts.method || 'GET', headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined, credentials: 'same-origin' })
  const data = res.status === 204 ? null : await res.json().catch(() => null)
  if (res.status === 401 && (path.startsWith('/instances') || path.startsWith('/painel/api/dashboard'))) {
    state.me = null
    location.hash = '#/login'
  }
  if (!res.ok) throw Object.assign(new Error((data && (data.error || data.message)) || `Erro ${res.status}`), { status: res.status, data })
  return data
}

function toast(msg, bad) {
  document.querySelectorAll('.toast').forEach((t) => t.remove())
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg)
  document.body.append(t)
  setTimeout(() => t.remove(), bad ? 5000 : 2600)
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${label || 'Copiado'} ✓`)
  } catch {
    toast('Não consegui copiar; selecione e copie manualmente', true)
  }
}

/** Botão que trava enquanto roda e mostra o erro */
function action(label, fn, cls = 'btn', ico) {
  const b = h('button', {
    class: cls,
    type: 'button',
    onclick: async (e) => {
      e.stopPropagation()
      b.disabled = true
      try {
        await fn()
      } catch (err) {
        toast(err.message, true)
      } finally {
        b.disabled = false
      }
    },
  }, ico ? icon(ico) : null, label)
  return b
}

function modal(title, body, opts = {}) {
  const close = () => {
    bg.remove()
    opts.onClose && opts.onClose()
  }
  const bg = h('div', { class: 'modal-bg', onclick: (e) => e.target === bg && close() })
  const footer = opts.onConfirm
    ? h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:4px' },
        h('button', { class: 'btn', type: 'button', onclick: close }, 'Cancelar'),
        action(opts.confirmLabel || 'Salvar', async () => {
          await opts.onConfirm()
          close()
        }, opts.danger ? 'btn btn-danger' : 'btn btn-primary'),
      )
    : h('div', { class: 'row', style: 'justify-content:flex-end;margin-top:4px' }, h('button', { class: 'btn', type: 'button', onclick: close }, 'Fechar'))
  bg.append(h('div', { class: 'card modal' + (opts.wide ? ' wide' : '') }, h('div', { class: 'card-body' }, h('h2', { style: 'font-size:18px' }, title), h('div', { style: 'margin-top:16px' }, body), footer)))
  document.body.append(bg)
  const first = bg.querySelector('input,textarea')
  if (first) first.focus()
  return close
}

const STATUS = {
  connected: ['Conectado', 'ok', 'Online e pronto para enviar'],
  connecting: ['Conectando', 'warn', 'Estabelecendo conexão'],
  qr: ['Aguardando QR', 'warn', 'Leia o QR code no celular'],
  created: ['Não conectado', '', 'Clique em conectar'],
  disconnected: ['Desconectado', '', 'Clique em conectar'],
  logged_out: ['Deslogado', 'bad', 'Removido no celular'],
  replaced: ['Aberto em outro lugar', 'bad', 'Conecte de novo aqui'],
  forbidden: ['Bloqueado', 'bad', 'O WhatsApp recusou o acesso'],
}
const st = (s) => STATUS[s] || [s, '', '']
const fmtDate = (d) => (d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const fmtPhone = (p) => {
  if (!p) return '—'
  const m = String(p).match(/^55(\d{2})(\d{4,5})(\d{4})$/)
  return m ? `+55 (${m[1]}) ${m[2]}-${m[3]}` : '+' + p
}
const initials = (s) => (s || '?').split(/[\s@.]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('')

// ============ estado e rotas ============

const state = { me: null, brand: { name: 'API Roxa', color: '#7C2D92', logo: null }, timers: [], list: { q: '', filter: 'all', page: 1 }, count: 0, instances: [], dash: { period: '30d', metric: 'sent' } }
const app = document.getElementById('app')

const clearTimers = () => {
  state.timers.forEach(clearInterval)
  state.timers = []
}
const every = (ms, fn) => state.timers.push(setInterval(fn, ms))

/** Preferências deste navegador. Sem localStorage (janela privada) só não lembra de nada. */
const pref = {
  get(key, fallback) {
    try {
      return localStorage.getItem(`roxa.${key}`) ?? fallback
    } catch {
      return fallback
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`roxa.${key}`, value)
    } catch {}
  },
}

function applyBrand(brand) {
  state.brand = brand
  const root = document.documentElement.style
  root.setProperty('--brand', brand.color)
  root.setProperty('--brand-ink', inkFor(brand.color))
  document.title = `${brand.name} · Painel`
}

/** Lista as instâncias e guarda: a faixa de aviso e o sino usam a mesma lista */
async function listInstances() {
  const all = await api('/instances')
  state.instances = all
  state.count = all.length
  return all
}

async function route() {
  clearTimers()
  const parts = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/')
  if (parts[0] === 'login') return renderLogin()
  if (!state.me) {
    try {
      state.me = await api('/painel/api/me')
      applyBrand(state.me.brand)
    } catch {
      location.hash = '#/login'
      return
    }
  }
  const view =
    parts[0] === 'conta' ? ['conta', renderAccount()] :
    parts[0] === 'chaves' ? ['chaves', renderKeys()] :
    parts[0] === 'webhooks' ? ['webhooks', renderWebhooksHub()] :
    parts[0] === 'testar' ? ['testar', renderTester(parts[1])] :
    parts[0] === 'instancias' && parts[1] ? ['instancias', renderInstance(parts[1], parts[2] || 'conexao')] :
    parts[0] === 'instancias' ? ['instancias', renderInstances()] :
    ['dashboard', renderDashboard()]
  // Conta e chaves não pedem a lista, mas a faixa de aviso e o sino precisam dela
  if (parts[0] === 'conta' || parts[0] === 'chaves') await listInstances().catch(() => null)
  layout(view[0], await view[1])
}
window.addEventListener('hashchange', () => route().catch((e) => toast(e.message, true)))

const PAGES = {
  dashboard: ['Dashboard', 'chart'],
  instancias: ['Instâncias', 'phone'],
  testar: ['Testar API', 'play'],
  chaves: ['Chaves de API', 'key'],
  webhooks: ['Webhooks', 'webhook'],
  conta: ['Minha conta', 'user'],
}
// "created" e "qr" são o caminho normal de quem está conectando; estes pedem alguma ação
const needsAttention = (i) => ['disconnected', 'logged_out', 'replaced', 'forbidden'].includes(i.status)

/** Menu suspenso preso a um botão. Fecha ao clicar fora. */
function openPop(anchor, ...content) {
  document.querySelectorAll('.pop').forEach((p) => p.remove())
  const pop = h('div', { class: 'card pop' }, ...content)
  document.body.append(pop)
  const a = anchor.getBoundingClientRect()
  const p = pop.getBoundingClientRect()
  const top = a.bottom + p.height + 14 > innerHeight ? a.top - p.height - 6 : a.bottom + 6
  pop.style.top = `${Math.max(8, top)}px`
  pop.style.left = `${Math.max(8, Math.min(a.left, innerWidth - p.width - 8))}px`
  const off = (e) => {
    if (pop.contains(e.target) && !e.target.closest('a,button')) return
    setTimeout(() => pop.remove(), 0)
    document.removeEventListener('pointerdown', off)
  }
  setTimeout(() => document.addEventListener('pointerdown', off), 0)
}

function logoutButton() {
  return h('button', {
    type: 'button',
    onclick: async () => {
      await api('/painel/api/logout', { method: 'POST' }).catch(() => null)
      state.me = null
      state.instances = []
      location.hash = '#/login'
    },
  }, icon('out'), 'Sair')
}

function topBanner() {
  const down = state.instances.filter(needsAttention)
  if (!down.length) return null
  const one = down.length === 1
  return h('div', { class: 'banner', role: 'status' },
    icon('alert'),
    h('span', {}, one ? `O número "${down[0].name}" está desconectado` : `${down.length} números estão desconectados`),
    h('a', { class: 'banner-btn', href: one ? `#/instancias/${down[0].id}/conexao` : '#/instancias' }, one ? 'Resolver' : 'Ver números'),
  )
}

function themeButton() {
  const isDark = () => document.documentElement.dataset.theme === 'dark'
  const b = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Trocar tema',
    'aria-label': 'Trocar entre tema claro e escuro',
    onclick: () => {
      if (isDark()) delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = 'dark'
      pref.set('theme', isDark() ? 'dark' : 'light')
      b.replaceChildren(icon(isDark() ? 'sun' : 'moon'))
    },
  }, icon(isDark() ? 'sun' : 'moon'))
  return b
}

function bellButton() {
  const down = state.instances.filter(needsAttention)
  const b = h('button', {
    class: 'icon-btn',
    type: 'button',
    title: 'Avisos',
    'aria-label': down.length ? `Avisos: ${down.length} número(s) precisam de atenção` : 'Avisos: nenhum',
    onclick: () => openPop(b,
      h('div', { class: 'pop-title' }, h('b', {}, 'Avisos')),
      down.length
        ? down.map((i) => h('a', { href: `#/instancias/${i.id}/conexao` }, h('span', { class: `dot ${st(i.status)[1]}` }), h('span', {}, i.name, h('small', {}, st(i.status)[0]))))
        : h('div', { class: 'pop-empty' }, 'Tudo certo: nenhum número precisa de atenção.'),
    ),
  }, icon('bell'), down.length ? h('span', { class: 'bell-dot' }) : null)
  return b
}

/** Grupo recolhível do menu; o que contém a página atual fica sempre aberto */
function navGroup(id, label, ico, activeInside, links) {
  const open = activeInside || pref.get(`nav.${id}`, '1') === '1'
  const sub = h('div', { class: 'nav-sub', hidden: !open }, links)
  const head = h('button', {
    class: 'nav-head' + (open ? ' open' : ''),
    type: 'button',
    'aria-expanded': String(open),
    onclick: () => {
      sub.hidden = !sub.hidden
      head.classList.toggle('open', !sub.hidden)
      head.setAttribute('aria-expanded', String(!sub.hidden))
      pref.set(`nav.${id}`, sub.hidden ? '0' : '1')
    },
  }, icon(ico), h('span', { class: 'label' }, label), h('span', { class: 'chev' }, icon('down')))
  return h('div', {}, head, sub)
}

function layout(active, content) {
  document.querySelectorAll('.pop').forEach((p) => p.remove())
  // A tela é redesenhada a cada atualização automática: quem está lendo não pode voltar para o topo
  const previousScroll = document.querySelector('.main-col')?.scrollTop ?? 0
  const samePage = state.renderedHash === location.hash
  state.renderedHash = location.hash

  const link = (id, label, href, ico, extra) => h('a', { href, title: label, class: active === id ? 'active' : '' }, icon(ico), h('span', { class: 'label' }, label), extra)
  const shell = h('div', { class: 'shell' + (pref.get('side', 'open') === 'closed' ? ' collapsed' : '') })
  const side = h('aside', { class: 'side' })
  const scrim = h('div', { class: 'scrim', onclick: () => { side.classList.remove('open'); scrim.classList.remove('open') } })
  const [pageTitle, pageIcon] = PAGES[active]

  side.append(
    h('div', { class: 'side-top' },
      h('a', { class: 'brand', href: '#/dashboard' }, brandMark(state.brand), h('span', { class: 'brand-word' }, state.brand.name)),
      h('button', {
        class: 'icon-btn side-collapse',
        type: 'button',
        title: 'Recolher menu',
        'aria-label': 'Recolher ou abrir o menu',
        onclick: () => pref.set('side', shell.classList.toggle('collapsed') ? 'closed' : 'open'),
      }, icon('collapse')),
    ),
    h('button', {
      class: 'acct',
      type: 'button',
      title: state.me.account_name,
      onclick: (e) => openPop(e.currentTarget,
        h('div', { class: 'pop-title' }, 'Conta', h('b', {}, state.me.account_name)),
        h('a', { href: '#/conta' }, icon('user'), 'Minha conta'),
        h('a', { href: '#/chaves' }, icon('key'), 'Chaves de API'),
      ),
    }, h('span', { class: 'acct-ico' }, icon('building')), h('span', { class: 'acct-name' }, state.me.account_name), icon('updown')),
    h('nav', { class: 'menu' },
      link('dashboard', 'Dashboard', '#/dashboard', 'chart'),
      navGroup('whatsapp', 'WhatsApp', 'whatsapp', active === 'instancias' || active === 'testar', [
        link('instancias', 'Instâncias', '#/instancias', 'phone', state.count ? h('span', { class: 'count' }, state.count) : null),
        link('testar', 'Testar API', '#/testar', 'play'),
      ]),
    ),
    h('div', { class: 'side-sep' }),
    h('nav', { class: 'menu' },
      navGroup('integracao', 'Integração', 'plug', active === 'chaves' || active === 'webhooks', [
        h('a', { href: '/docs/', target: '_blank', rel: 'noopener', title: 'Documentação' }, icon('book'), h('span', { class: 'label' }, 'Documentação'), h('span', { class: 'nav-ext' }, icon('ext'))),
        link('chaves', 'Chaves de API', '#/chaves', 'key'),
        link('webhooks', 'Webhooks', '#/webhooks', 'webhook'),
      ]),
    ),
    h('div', { class: 'side-foot' },
      h('div', { class: 'side-sep' }),
      h('button', {
        class: 'usercard',
        type: 'button',
        title: state.me.email,
        onclick: (e) => openPop(e.currentTarget,
          h('div', { class: 'pop-title' }, h('b', {}, state.me.name || state.me.account_name), state.me.email),
          h('a', { href: '#/conta' }, icon('user'), 'Minha conta'),
          logoutButton(),
        ),
      }, h('span', { class: 'initials' }, initials(state.me.name || state.me.email)), h('span', { class: 'who-name' }, state.me.name || state.me.email), icon('down')),
    ),
  )

  const banner = topBanner()
  const main = h('div', { class: 'main-col' },
    h('header', { class: 'pagebar' },
      h('button', {
        class: 'icon-btn menu-btn',
        type: 'button',
        'aria-label': 'Abrir o menu',
        onclick: () => { side.classList.add('open'); scrim.classList.add('open') },
      }, icon('menu')),
      h('div', { class: 'pagebar-title' }, icon(pageIcon), h('span', {}, pageTitle)),
      h('div', { class: 'pagebar-actions' }, themeButton(), bellButton()),
    ),
    h('main', { class: 'panel' }, content),
  )
  shell.append(side, scrim, main)
  app.replaceChildren(h('div', { class: 'frame' + (banner ? ' has-banner' : '') }, banner, shell))
  if (samePage) main.scrollTop = previousScroll
}

// ============ login ============

async function renderLogin() {
  try {
    applyBrand(await api('/painel/api/brand'))
  } catch {}
  const email = h('input', { type: 'email', required: true, autocomplete: 'username', placeholder: 'voce@empresa.com' })
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password', placeholder: '••••••••••' })
  const err = h('p', { style: 'color:var(--bad);margin:0 0 12px;font-size:13.5px' })
  const submit = h('button', { class: 'btn btn-primary btn-pill', type: 'submit', style: 'width:100%' }, 'Entrar')
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault()
      submit.disabled = true
      err.textContent = ''
      try {
        await api('/painel/api/login', { method: 'POST', body: { email: email.value, password: password.value } })
        state.me = null
        location.hash = '#/dashboard'
      } catch (e2) {
        err.textContent = e2.message
      } finally {
        submit.disabled = false
      }
    },
  },
    h('label', { class: 'field' }, h('span', {}, 'E-mail'), email),
    h('label', { class: 'field' }, h('span', {}, 'Senha'), password),
    err,
    submit,
  )
  app.replaceChildren(
    h('div', { class: 'login-wrap' },
      h('div', { class: 'login' },
        h('div', { class: 'brand' }, brandMark(state.brand), state.brand.name),
        h('div', { class: 'card' }, h('div', { class: 'card-body', style: 'padding:28px' },
          h('h2', { style: 'font-size:20px' }, 'Bem-vindo de volta'),
          h('p', { class: 'sub' }, 'Entre para gerenciar seus números de WhatsApp.'),
          form,
        )),
        h('p', { class: 'muted', style: 'text-align:center;margin-top:18px' }, h('a', { href: '/docs/' }, 'Ver a documentação da API →')),
      ),
    ),
  )
  email.focus()
}

// ============ conexão (janela com QR) ============

function openConnect(inst, onDone) {
  let timer
  const qrArea = h('div', { class: 'qr-box' }, h('div', {}, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, 'Gerando QR code…')))
  const phone = h('input', { type: 'text', placeholder: '5511999999999', inputmode: 'numeric' })
  const poll = async () => {
    const r = await api(`/instances/${inst.id}/qr`).catch(() => null)
    if (!r) return
    if (r.status === 'connected') {
      clearInterval(timer)
      toast('Conectado! 🎉')
      closeModal()
      onDone()
      return
    }
    if (r.pairingCode) {
      qrArea.replaceChildren(h('div', {},
        h('div', { class: 'muted' }, 'No celular: Aparelhos conectados → Conectar aparelho → Conectar com número de telefone'),
        h('div', { class: 'pair-code' }, r.pairingCode),
        h('div', { class: 'muted', style: 'margin-top:8px' }, 'Digite assim que aparecer. O código vale cerca de 1 minuto e, quando vence, outro entra no lugar aqui mesmo — use sempre o que está na tela.'),
      ))
    } else if (r.qrImage) {
      qrArea.replaceChildren(h('img', { src: r.qrImage, alt: 'QR code' }))
    } else if (['disconnected', 'logged_out'].includes(r.status)) {
      qrArea.replaceChildren(h('div', {}, h('p', { class: 'muted' }, 'O QR expirou.'), action('Gerar outro', () => start(), 'btn btn-primary', 'refresh')))
    }
  }
  const start = async (pairPhone) => {
    qrArea.replaceChildren(h('div', {}, h('div', { class: 'spinner' }), h('span', { class: 'muted' }, pairPhone ? 'Gerando código…' : 'Gerando QR code…')))
    if (pairPhone) await api(`/instances/${inst.id}/disconnect`, { method: 'POST' })
    await api(`/instances/${inst.id}/connect`, { method: 'POST', body: pairPhone ? { phone: pairPhone } : {} })
    clearInterval(timer)
    timer = setInterval(poll, 2000)
    setTimeout(poll, 1200)
  }
  const body = h('div', { class: 'grid grid-2', style: 'align-items:start' },
    qrArea,
    h('div', {},
      h('ol', { class: 'steps' },
        h('li', {}, 'Abra o WhatsApp no celular'),
        h('li', {}, 'Toque em ', h('b', {}, 'Configurações → Aparelhos conectados')),
        h('li', {}, 'Toque em ', h('b', {}, 'Conectar aparelho'), ' e aponte para o QR'),
      ),
      h('div', { class: 'note', style: 'margin-top:18px' },
        h('b', { style: 'display:block;color:var(--ink);margin-bottom:8px' }, 'Sem câmera? Conecte por código'),
        h('label', { class: 'field', style: 'margin-bottom:10px' }, h('span', {}, 'Número com DDI e DDD'), phone),
        action('Gerar código', async () => {
          const v = phone.value.replace(/\D/g, '')
          if (v.length < 10) throw new Error('Informe o número completo, ex.: 5511999999999')
          await start(v)
        }, 'btn btn-sm'),
      ),
    ),
  )
  const closeModal = modal(`Conectar · ${inst.name}`, body, { wide: true, onClose: () => clearInterval(timer) })
  start().catch((e) => toast(e.message, true))
}

// ============ lista de instâncias ============

function newInstanceModal() {
  const name = h('input', { type: 'text', placeholder: 'Ex.: Comercial - Loja Centro', maxlength: 100 })
  modal('Criar instância', h('label', { class: 'field' }, h('span', {}, 'Nome'), name, h('small', {}, 'Só para você identificar. Dá para mudar depois.')), {
    confirmLabel: 'Criar instância',
    onConfirm: async () => {
      if (!name.value.trim()) throw new Error('Informe um nome')
      const inst = await api('/instances', { method: 'POST', body: { name: name.value.trim() } })
      toast('Instância criada')
      await route()
      openConnect(inst, route)
    },
  })
}

function deleteModal(inst) {
  const typed = h('input', { type: 'text', placeholder: inst.name })
  modal('Excluir instância', h('div', {},
    h('p', { class: 'muted', style: 'margin-top:0' }, 'O número é deslogado e a instância apagada. Os sistemas que usam o ID e o token dela param de funcionar. Não dá para desfazer.'),
    h('label', { class: 'field' }, h('span', {}, `Digite "${inst.name}" para confirmar`), typed),
  ), {
    confirmLabel: 'Excluir',
    danger: true,
    onConfirm: async () => {
      if (typed.value !== inst.name) throw new Error('O nome não confere')
      await api(`/instances/${inst.id}`, { method: 'DELETE' })
      toast('Instância excluída')
      if (location.hash.startsWith('#/instancias/')) location.hash = '#/instancias'
      else route()
    },
  })
}

function instanceCard(i) {
  const [label, cls, hint] = st(i.status)
  const connected = i.status === 'connected'
  const manage = () => (location.hash = `#/instancias/${i.id}/conexao`)
  return h('div', { class: 'card inst' },
    h('div', { class: 'inst-top' },
      h('div', {}, h('b', {}, i.name), h('small', {}, `Criada em ${fmtDate(i.createdAt)}`)),
      h('button', { class: 'btn btn-icon', type: 'button', title: 'Excluir', onclick: () => deleteModal(i) }, icon('trash')),
    ),
    h('div', { class: 'status-box ' + cls },
      h('div', {}, h('b', {}, label), h('small', {}, hint)),
      h('span', { class: 'dot ' + cls }),
    ),
    h('div', { class: 'inst-id' },
      h('small', {}, 'ID da instância'),
      h('div', { class: 'idline' },
        h('code', {}, i.id),
        h('button', { class: 'btn btn-icon', type: 'button', title: 'Copiar ID', onclick: () => copy(i.id, 'ID copiado') }, icon('copy')),
      ),
    ),
    h('div', { class: 'inst-phone' },
      connected
        ? h('span', { class: 'who' }, i.picture ? h('img', { class: 'av', src: i.picture, alt: '' }) : h('span', { class: 'av' }), fmtPhone(i.phone))
        : h('span', { class: 'who off' }, icon('wifi'), 'Desconectado'),
      h('button', { class: 'btn btn-sm btn-outline-accent', type: 'button', onclick: manage }, 'Gerenciar'),
    ),
    h('div', { class: 'inst-actions' },
      connected
        ? action('Resetar', async () => {
            await api(`/instances/${i.id}/restart`, { method: 'POST' })
            toast('Reiniciando conexão…')
            setTimeout(route, 2500)
          }, 'btn btn-warn btn-caps btn-sm', 'refresh')
        : h('button', { class: 'btn btn-primary btn-caps btn-sm', type: 'button', onclick: () => openConnect(i, route) }, icon('link'), 'Conectar'),
      connected
        ? action('Sair', async () => {
            if (!confirm(`Deslogar ${fmtPhone(i.phone)}? Vai precisar ler o QR code de novo.`)) return
            await api(`/instances/${i.id}/logout`, { method: 'POST' })
            toast('Número deslogado')
            route()
          }, 'btn btn-danger btn-caps btn-sm', 'logout')
        : action('Resetar', async () => {
            await api(`/instances/${i.id}/restart`, { method: 'POST' })
            toast('Reiniciando…')
            setTimeout(route, 2500)
          }, 'btn btn-warn btn-caps btn-sm', 'refresh'),
    ),
  )
}

async function renderInstances() {
  const all = await listInstances()
  every(15000, async () => {
    const now = await api('/instances').catch(() => null)
    if (now && JSON.stringify(now.map((x) => x.status)) !== JSON.stringify(all.map((x) => x.status))) route()
  })
  const PER_PAGE = 12
  const gridEl = h('div', { class: 'inst-grid' })
  const pagerEl = h('div', { class: 'pager' })
  const draw = () => {
    const { q, filter } = state.list
    const filtered = all.filter((i) => {
      if (filter === 'on' && i.status !== 'connected') return false
      if (filter === 'off' && i.status === 'connected') return false
      const text = `${i.name} ${i.id} ${i.phone || ''}`.toLowerCase()
      return !q || text.includes(q.toLowerCase())
    })
    const pages = Math.max(1, Math.ceil(filtered.length / PER_PAGE))
    state.list.page = Math.min(state.list.page, pages)
    const slice = filtered.slice((state.list.page - 1) * PER_PAGE, state.list.page * PER_PAGE)
    gridEl.replaceChildren(...(slice.length ? slice.map(instanceCard) : [h('div', { class: 'card empty', style: 'grid-column:1/-1' }, h('b', {}, 'Nada encontrado'), 'Tente outra busca ou filtro.')]))
    pagerEl.replaceChildren(
      h('button', { type: 'button', disabled: state.list.page === 1, onclick: () => { state.list.page--; draw() } }, '‹'),
      ...Array.from({ length: pages }, (_, n) => h('button', { type: 'button', class: n + 1 === state.list.page ? 'on' : '', onclick: () => { state.list.page = n + 1; draw() } }, n + 1)),
      h('button', { type: 'button', disabled: state.list.page === pages, onclick: () => { state.list.page++; draw() } }, '›'),
    )
  }
  const segBtn = (key, label) => h('button', { type: 'button', class: state.list.filter === key ? 'on' : '', onclick: (e) => { state.list.filter = key; state.list.page = 1; e.target.parentElement.querySelectorAll('button').forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); draw() } }, label)
  const connected = all.filter((i) => i.status === 'connected').length

  const head = h('div', { class: 'page-head' },
    h('div', {}, h('h1', {}, 'Instâncias', h('span', { class: 'badge-count' }, all.length)), h('p', {}, `${connected} conectada${connected === 1 ? '' : 's'} · ${all.length - connected} desconectada${all.length - connected === 1 ? '' : 's'}`)),
    h('button', { class: 'btn btn-primary btn-pill', type: 'button', onclick: newInstanceModal }, icon('plus'), 'Criar instância'),
  )
  if (!all.length) {
    return [head, h('div', { class: 'card empty' },
      h('div', { class: 'ill' }, icon('chat')),
      h('b', {}, 'Conecte seu primeiro número'),
      h('p', { style: 'margin:0 0 20px' }, 'Crie uma instância e leia o QR code com o WhatsApp do celular. Leva menos de um minuto.'),
      h('button', { class: 'btn btn-primary btn-pill', type: 'button', onclick: newInstanceModal }, icon('plus'), 'Criar instância'),
    )]
  }
  const search = h('input', { type: 'search', placeholder: 'Pesquisar por nome, número ou ID…', value: state.list.q, oninput: (e) => { state.list.q = e.target.value; state.list.page = 1; draw() } })
  draw()
  return [
    head,
    h('div', { class: 'card toolbar' },
      h('div', { class: 'search' }, icon('search'), search),
      h('div', { class: 'seg' }, segBtn('all', 'Todas'), segBtn('on', 'Conectadas'), segBtn('off', 'Desconectadas')),
    ),
    gridEl,
    all.length > PER_PAGE ? pagerEl : null,
  ]
}

// ============ detalhe da instância ============

const TABS = [
  ['conexao', 'Visão geral'],
  ['credenciais', 'ID e token'],
  ['webhooks', 'Webhooks'],
  ['configuracoes', 'Configurações'],
  ['fila', 'Fila'],
  ['logs', 'Logs'],
]

async function renderInstance(id, tab) {
  const [inst] = await Promise.all([api(`/instances/${id}`), listInstances()])
  const body = await ({ conexao: tabOverview, credenciais: tabCredentials, webhooks: tabWebhooks, configuracoes: tabSettings, fila: tabQueue, logs: tabLogs }[tab] || tabOverview)(inst)
  const [label, cls] = st(inst.status)
  return [
    h('a', { class: 'crumb', href: '#/instancias' }, icon('arrow'), 'Instâncias'),
    h('div', { class: 'page-head', style: 'margin-top:8px' },
      h('div', {},
        h('h1', {}, inst.name),
        h('p', { class: 'row', style: 'gap:14px' }, h('span', { class: 'tag' }, h('span', { class: 'dot ' + cls }), label), inst.phone ? h('span', {}, fmtPhone(inst.phone)) : null),
      ),
      h('div', { class: 'row' },
        h('a', { class: 'btn', href: `#/testar/${inst.id}` }, icon('play'), 'Testar API'),
        inst.status === 'connected' ? null : h('button', { class: 'btn btn-primary', type: 'button', onclick: () => openConnect(inst, route) }, icon('link'), 'Conectar'),
      ),
    ),
    h('nav', { class: 'tabs' }, TABS.map(([k, l]) => h('a', { href: `#/instancias/${id}/${k}`, class: k === tab ? 'active' : '' }, l))),
    body,
  ]
}

async function tabOverview(inst) {
  const connected = inst.status === 'connected'
  let d = null
  if (connected) d = await api(`/instances/${inst.id}/device`).catch(() => null)
  every(10000, async () => {
    const now = await api(`/instances/${inst.id}`).catch(() => null)
    if (now && now.status !== inst.status) route()
  })
  return h('div', { class: 'grid grid-2' },
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        connected
          ? h('div', { class: 'row', style: 'gap:16px;margin-bottom:20px' },
              d && d.picture ? h('img', { class: 'avatar', src: d.picture, alt: '' }) : h('span', { class: 'avatar' }),
              h('div', {}, h('b', { style: 'font-size:18px' }, (d && d.name) || 'Conectado'), h('div', { class: 'muted' }, fmtPhone(inst.phone))),
            )
          : h('div', { class: 'empty', style: 'padding:24px 8px' },
              h('div', { class: 'ill' }, icon('link')),
              h('b', {}, 'Número não conectado'),
              h('p', { style: 'margin:0 0 16px' }, 'Conecte lendo o QR code ou com um código no celular.'),
              h('button', { class: 'btn btn-primary btn-pill', type: 'button', onclick: () => openConnect(inst, route) }, icon('link'), 'Conectar agora'),
            ),
        connected
          ? h('div', { class: 'grid grid-2' },
              h('div', { class: 'stat' }, 'Conectado desde', h('b', {}, fmtDate(inst.connectedAt))),
              h('div', { class: 'stat' }, 'Conta', h('b', {}, d ? (d.isBusiness ? 'WhatsApp Business' : 'WhatsApp') : '—')),
              h('div', { class: 'stat' }, 'Recado', h('b', {}, (d && d.about) || '—')),
              h('div', { class: 'stat' }, 'Criada em', h('b', {}, fmtDate(inst.createdAt))),
            )
          : null,
        inst.lastError && !connected ? h('div', { class: 'note warn', style: 'margin-top:16px' }, `Último erro: ${inst.lastError}`) : null,
      ),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('h2', {}, 'Ações'),
        h('p', { class: 'sub' }, 'Resetar resolve a maioria das travadas. Sair desloga o número e exige ler o QR de novo.'),
        h('div', { class: 'grid', style: 'gap:10px' },
          action('Resetar conexão', async () => {
            await api(`/instances/${inst.id}/restart`, { method: 'POST' })
            toast('Reiniciando…')
            setTimeout(route, 2500)
          }, 'btn btn-warn', 'refresh'),
          connected
            ? action('Sair (deslogar o número)', async () => {
                if (!confirm('Deslogar este número? Vai precisar ler o QR code de novo.')) return
                await api(`/instances/${inst.id}/logout`, { method: 'POST' })
                route()
              }, 'btn btn-danger', 'logout')
            : null,
          h('button', { class: 'btn btn-danger', type: 'button', onclick: () => deleteModal(inst) }, icon('trash'), 'Excluir instância'),
        ),
      ),
    ),
  )
}

function secretRow(label, value, hide) {
  const mask = '•'.repeat(28)
  const code = h('code', {}, hide ? mask : value)
  let shown = !hide
  return h('label', { class: 'field' },
    h('span', {}, label),
    h('div', { class: 'secret' },
      code,
      hide ? h('button', { class: 'btn btn-sm', type: 'button', onclick: (e) => { shown = !shown; code.textContent = shown ? value : mask; e.currentTarget.textContent = shown ? 'Ocultar' : 'Mostrar' } }, 'Mostrar') : null,
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copy(value, `${label} copiado`) }, icon('copy'), 'Copiar'),
    ),
  )
}

async function tabCredentials(inst) {
  const base = state.me.publicUrl.replace(/\/$/, '')
  const curl = `curl -X POST "${base}/v1/message/send-text?instanceId=${inst.id}" \\\n  -H "Authorization: Bearer ${inst.token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"phone": "5511999999999", "message": "Olá! 👋"}'`
  return h('div', { class: 'grid grid-2' },
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('h2', {}, 'Credenciais'),
        h('p', { class: 'sub' }, 'Cole no sistema que vai usar este número: automação, chatbot, CRM, n8n…'),
        secretRow('URL base', `${base}/v1`),
        secretRow('Instance ID', inst.id),
        secretRow('Token', inst.token, true),
        h('div', { class: 'note', style: 'margin-bottom:14px' }, 'Trate o token como uma senha. Se vazar, gere um novo: o antigo para de funcionar na hora.'),
        action('Gerar token novo', async () => {
          if (!confirm('Gerar um token novo? O atual para de funcionar na hora.')) return
          await api(`/instances/${inst.id}/token/rotate`, { method: 'POST' })
          toast('Token novo gerado')
          route()
        }, 'btn btn-danger btn-sm', 'refresh'),
      ),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('h2', {}, 'Primeira requisição'),
        h('p', { class: 'sub' }, 'Envie uma mensagem com este comando. Todas as rotas estão na documentação.'),
        h('pre', { class: 'code' }, curl),
        h('div', { class: 'row', style: 'margin-top:12px' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copy(curl, 'Comando copiado') }, icon('copy'), 'Copiar'),
          h('a', { class: 'btn btn-sm', href: `#/testar/${inst.id}` }, icon('play'), 'Testar no painel'),
          h('a', { class: 'btn btn-sm', href: '/docs/', target: '_blank', rel: 'noopener' }, icon('book'), 'Documentação'),
        ),
      ),
    ),
  )
}

async function tabWebhooks(inst) {
  const hooks = inst.wapiWebhooks || {}
  const fields = [
    ['received', 'Ao receber mensagem', 'webhookReceived'],
    ['delivery', 'Ao enviar mensagem', 'webhookDelivery · inclui as enviadas pelo celular'],
    ['status', 'Status da mensagem', 'webhookStatus · enviada, entregue, lida'],
    ['connected', 'Ao conectar', 'webhookConnected'],
    ['disconnected', 'Ao desconectar', 'webhookDisconnected'],
    ['presence', 'Presença', 'webhookPresence · digitando, online'],
  ]
  const inputs = {}
  const same = h('input', { type: 'url', placeholder: 'https://seu-sistema.com/webhook' })
  const native = h('input', { type: 'url', value: inst.webhookUrl || '', placeholder: 'https://…' })
  return h('div', { class: 'grid grid-2', style: 'align-items:start' },
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('h2', {}, 'URLs de webhook'),
        h('p', { class: 'sub' }, 'Para onde avisamos cada evento. Deixe em branco o que não quiser receber.'),
        h('label', { class: 'field' },
          h('span', {}, 'Usar a mesma URL em todos'),
          h('div', { class: 'secret' }, same, h('button', { class: 'btn btn-sm', type: 'button', onclick: () => Object.values(inputs).forEach((i) => (i.value = same.value)) }, 'Aplicar')),
        ),
        fields.map(([k, label, hint]) => {
          inputs[k] = h('input', { type: 'url', value: hooks[k] || '', placeholder: 'https://…' })
          return h('label', { class: 'field' }, h('span', {}, label), inputs[k], h('small', {}, hint))
        }),
        action('Salvar webhooks', async () => {
          await api(`/instances/${inst.id}/wapi-webhooks`, { method: 'PUT', body: Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()])) })
          toast('Webhooks salvos')
        }, 'btn btn-primary'),
      ),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('h2', {}, 'Webhook único (avançado)'),
        h('p', { class: 'sub' }, 'Todos os eventos numa URL só, no formato nativo e com assinatura HMAC.'),
        h('label', { class: 'field' }, h('span', {}, 'URL'), native),
        action('Salvar', async () => {
          await api(`/instances/${inst.id}/webhook`, { method: 'PUT', body: { webhookUrl: native.value.trim() || null } })
          toast('Webhook salvo')
        }, 'btn btn-primary'),
        h('div', { class: 'note', style: 'margin-top:16px' }, 'Confira as entregas na aba Logs. Se o seu sistema estiver fora do ar, tentamos de novo por algumas horas.'),
      ),
    ),
  )
}

async function tabSettings(inst) {
  const s = inst.settings
  const name = h('input', { type: 'text', value: inst.name, maxlength: 100 })
  const autoRead = h('input', { type: 'checkbox', checked: s.autoRead })
  const ignoreGroups = h('input', { type: 'checkbox', checked: s.ignoreGroups })
  const importHistory = h('input', { type: 'checkbox', checked: s.importHistory })
  const rejectCalls = h('input', { type: 'checkbox', checked: s.rejectCalls })
  const callMessage = h('textarea', { placeholder: 'Ex.: Olá! Por aqui atendemos só por mensagem.' }, s.callMessage || '')
  const perMinute = h('input', { type: 'number', min: 1, max: 600, value: s.sendPerMinute })
  const perDay = h('input', { type: 'number', min: 0, value: s.sendPerDay })
  const useProxy = h('input', { type: 'checkbox', checked: !!s.proxy })
  const pProto = h('select', {}, ['http', 'https', 'socks5'].map((p) => h('option', { value: p, selected: s.proxy && s.proxy.protocol === p }, p)))
  const pHost = h('input', { type: 'text', value: s.proxy ? s.proxy.host : '', placeholder: 'proxy.exemplo.com' })
  const pPort = h('input', { type: 'number', value: s.proxy ? s.proxy.port : '', placeholder: '1080' })
  const pUser = h('input', { type: 'text', value: s.proxy ? s.proxy.user || '' : '', autocomplete: 'off' })
  const pPass = h('input', { type: 'password', placeholder: s.proxy ? '(mantém a atual se vazio)' : '', autocomplete: 'new-password' })
  const check = (input, title, hint) => h('label', { class: 'check' }, input, h('span', {}, h('b', {}, title), h('small', {}, hint)))
  return h('div', { class: 'grid grid-2', style: 'align-items:start' },
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('h2', { style: 'margin-bottom:18px' }, 'Comportamento'),
        h('label', { class: 'field' }, h('span', {}, 'Nome da instância'), name),
        check(autoRead, 'Leitura automática', 'Marca como lida toda mensagem recebida.'),
        check(ignoreGroups, 'Ignorar grupos', 'Não avisa mensagens de grupo no webhook.'),
        check(importHistory, 'Importar histórico ao conectar', s.historyImportedAt ? `Já importado em ${new Date(s.historyImportedAt).toLocaleString('pt-BR')}. Acontece uma vez por número.` : 'Na próxima conexão, manda as mensagens recentes que o WhatsApp entregar, marcadas como histórico. Acontece uma vez.'),
        check(rejectCalls, 'Recusar ligações', 'Recusa chamadas de voz e vídeo automaticamente.'),
        h('label', { class: 'field' }, h('span', {}, 'Mensagem para quem ligou'), callMessage, h('small', {}, 'Em branco = não envia nada.')),
        action('Salvar', async () => {
          await api(`/instances/${inst.id}/settings`, { method: 'PATCH', body: { name: name.value.trim(), autoRead: autoRead.checked, importHistory: importHistory.checked, ignoreGroups: ignoreGroups.checked, rejectCalls: rejectCalls.checked, callMessage: callMessage.value.trim() || null } })
          toast('Configurações salvas')
        }, 'btn btn-primary'),
        h('h2', { style: 'margin:28px 0 6px' }, 'Ritmo de envio'),
        h('p', { class: 'sub' }, 'Mensagem acima do limite não falha: espera na fila e sai assim que houver vaga. Números novos ou em disparo frio se beneficiam de um ritmo menor.'),
        h('div', { class: 'grid grid-2', style: 'gap:12px' },
          h('label', { class: 'field' }, h('span', {}, 'Por minuto'), perMinute, h('small', {}, 'De 1 a 600.')),
          h('label', { class: 'field' }, h('span', {}, 'Por dia'), perDay, h('small', {}, '0 = sem limite.')),
        ),
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          action('Salvar ritmo', async () => {
            const pm = Number(perMinute.value), pd = Number(perDay.value)
            if (!Number.isInteger(pm) || pm < 1 || pm > 600) throw new Error('Por minuto: use um número de 1 a 600')
            if (!Number.isInteger(pd) || pd < 0) throw new Error('Por dia: use 0 ou mais')
            await api(`/instances/${inst.id}/settings`, { method: 'PATCH', body: { sendPerMinute: pm, sendPerDay: pd } })
            toast('Ritmo salvo')
          }, 'btn btn-primary'),
          action('Voltar ao padrão', async () => {
            const r = await api(`/instances/${inst.id}/settings`, { method: 'PATCH', body: { sendPerMinute: null, sendPerDay: null } })
            perMinute.value = r.settings.sendPerMinute
            perDay.value = r.settings.sendPerDay
            toast('Ritmo padrão restaurado')
          }, 'btn'),
        ),
      ),
    ),
    h('div', { class: 'card' },
      h('div', { class: 'card-body' },
        h('h2', {}, 'Proxy'),
        h('p', { class: 'sub' }, 'Faz o número sair por outro IP. Ajuda a separar números e reduzir risco de bloqueio. Vale na próxima conexão.'),
        check(useProxy, 'Usar proxy', 'Desmarque e salve para remover.'),
        h('div', { class: 'grid grid-2', style: 'gap:12px' },
          h('label', { class: 'field' }, h('span', {}, 'Protocolo'), pProto),
          h('label', { class: 'field' }, h('span', {}, 'Porta'), pPort),
        ),
        h('label', { class: 'field' }, h('span', {}, 'Host'), pHost),
        h('div', { class: 'grid grid-2', style: 'gap:12px' },
          h('label', { class: 'field' }, h('span', {}, 'Usuário'), pUser),
          h('label', { class: 'field' }, h('span', {}, 'Senha'), pPass),
        ),
        action('Salvar proxy', async () => {
          if (useProxy.checked && !pPass.value && s.proxy && s.proxy.user) throw new Error('Informe a senha do proxy de novo para salvar')
          await api(`/instances/${inst.id}/settings`, { method: 'PATCH', body: { proxy: useProxy.checked ? { protocol: pProto.value, host: pHost.value.trim(), port: Number(pPort.value), user: pUser.value || undefined, pass: pPass.value || undefined } : null } })
          toast('Proxy salvo. Resete a conexão para aplicar.')
        }, 'btn btn-primary'),
      ),
    ),
  )
}

async function tabQueue(inst) {
  const { jobs, total } = await api(`/instances/${inst.id}/queue?perPage=100`)
  every(5000, () => route())
  return h('div', { class: 'card' },
    h('div', { class: 'card-body row', style: 'justify-content:space-between' },
      h('div', {}, h('h2', {}, `Na fila: ${total}`), h('p', { class: 'sub', style: 'margin:0' }, 'Mensagens esperando o horário (delay) ou o limite por minuto. Atualiza sozinho.')),
      total ? action('Esvaziar fila', async () => {
        if (!confirm('Cancelar todas as mensagens da fila?')) return
        await api(`/instances/${inst.id}/queue`, { method: 'DELETE' })
        route()
      }, 'btn btn-danger btn-sm', 'trash') : null,
    ),
    jobs.length
      ? h('div', { class: 'table-wrap' },
          h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Tipo'), h('th', {}, 'Criada'), h('th', {}, 'Sai a partir de'), h('th', {}, 'Message ID'), h('th', {}))),
            h('tbody', {}, jobs.map((j) =>
              h('tr', {},
                h('td', {}, j.type),
                h('td', { class: 'muted' }, fmtDate(j.createdAt)),
                h('td', {}, fmtDate(j.sendAfter)),
                h('td', { class: 'mono muted' }, j.messageId || '—'),
                h('td', {}, action('Cancelar', async () => {
                  await api(`/instances/${inst.id}/queue/${j.jobId}`, { method: 'DELETE' })
                  route()
                }, 'btn btn-sm')),
              ),
            )),
          ),
        )
      : h('div', { class: 'empty' }, h('b', {}, 'Fila vazia'), 'Tudo que foi pedido já saiu.'),
  )
}

async function tabLogs(inst) {
  const { logs, total } = await api(`/instances/${inst.id}/webhook-logs?perPage=50`)
  const status = (l) =>
    l.delivered_at ? h('span', { class: 'tag' }, h('span', { class: 'dot ok' }), `${l.response_status || 200}`) :
    l.failed_at ? h('span', { class: 'tag' }, h('span', { class: 'dot bad' }), 'desistiu') :
    l.attempts ? h('span', { class: 'tag' }, h('span', { class: 'dot warn' }), `tentando (${l.attempts})`) :
    h('span', { class: 'tag' }, h('span', { class: 'dot' }), 'na fila')
  return h('div', { class: 'card' },
    h('div', { class: 'card-body' }, h('h2', {}, 'Entregas de webhook'), h('p', { class: 'sub', style: 'margin:0' }, `${total} nos últimos 7 dias. As mais recentes primeiro.`)),
    logs.length
      ? h('div', { class: 'table-wrap' },
          h('table', {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Quando'), h('th', {}, 'Evento'), h('th', {}, 'Resultado'), h('th', {}, 'Tempo'), h('th', {}, 'Erro'))),
            h('tbody', {}, logs.map((l) =>
              h('tr', {},
                h('td', { class: 'muted' }, fmtDate(l.created_at)),
                h('td', { class: 'mono' }, l.event),
                h('td', {}, status(l)),
                h('td', { class: 'muted' }, l.duration_ms != null ? `${l.duration_ms} ms` : '—'),
                h('td', { class: 'muted', style: 'max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }, l.last_error || ''),
              ),
            )),
          ),
        )
      : h('div', { class: 'empty' }, h('b', {}, 'Nenhum webhook ainda'), 'Configure uma URL na aba Webhooks.'),
  )
}

// ============ testar API ============

const PRESETS = [
  ['Enviar texto', 'POST', '/v1/message/send-text', { phone: '5511999999999', message: 'Olá! Teste pela API 👋' }],
  ['Enviar imagem', 'POST', '/v1/message/send-image', { phone: '5511999999999', image: 'https://picsum.photos/600/400', caption: 'Imagem de teste' }],
  ['Enviar áudio', 'POST', '/v1/message/send-audio', { phone: '5511999999999', audio: 'https://…/audio.mp3' }],
  ['Enviar documento', 'POST', '/v1/message/send-document', { phone: '5511999999999', document: 'https://…/arquivo.pdf', extension: 'pdf', fileName: 'proposta' }],
  ['Enviar localização', 'POST', '/v1/message/send-location', { phone: '5511999999999', latitude: -23.5613, longitude: -46.6565, name: 'Av. Paulista', address: 'São Paulo - SP' }],
  ['Enviar enquete', 'POST', '/v1/message/send-poll', { phone: '5511999999999', message: 'Qual o melhor horário?', poll: ['Manhã', 'Tarde', 'Noite'] }],
  ['Número tem WhatsApp?', 'GET', '/v1/contacts/phone-exists', { phoneNumber: '5511999999999' }],
  ['Status da instância', 'GET', '/v1/instance/status-instance', {}],
  ['Dados do aparelho', 'GET', '/v1/instance/device', {}],
  ['Listar grupos', 'GET', '/v1/group/get-all-groups', {}],
]

async function renderTester(preselect) {
  const all = await listInstances()
  const base = state.me.publicUrl.replace(/\/$/, '')
  const instSel = h('select', {}, all.map((i) => h('option', { value: i.id, selected: i.id === preselect }, `${i.name}${i.status === 'connected' ? ` · ${fmtPhone(i.phone)}` : ' · desconectada'}`)))
  const presetSel = h('select', {}, PRESETS.map(([label], n) => h('option', { value: n }, label)))
  const bodyIn = h('textarea', { class: 'code-input', spellcheck: 'false' })
  const methodTag = h('span', { class: 'badge-count mono' })
  const pathTag = h('code', { class: 'muted' })
  const curlOut = h('pre', { class: 'code' })
  const respOut = h('pre', { class: 'code', style: 'min-height:120px' }, 'A resposta aparece aqui.')
  const respStatus = h('span', { class: 'tag' })
  const current = () => PRESETS[Number(presetSel.value)]
  const inst = () => all.find((i) => i.id === instSel.value)
  const buildUrl = (params) => {
    const [, method, path] = current()
    const q = new URLSearchParams({ instanceId: instSel.value, ...(method === 'GET' ? params : {}) })
    return `${path}?${q}`
  }
  const refresh = () => {
    const [, method, path] = current()
    methodTag.textContent = method
    pathTag.textContent = path
    let params = {}
    try {
      params = JSON.parse(bodyIn.value || '{}')
    } catch {}
    const i = inst()
    curlOut.textContent = `curl -X ${method} "${base}${buildUrl(params)}" \\\n  -H "Authorization: Bearer ${i ? i.token.slice(0, 6) + '…' : 'TOKEN'}"` + (method === 'GET' ? '' : ` \\\n  -H "Content-Type: application/json" \\\n  -d '${JSON.stringify(params)}'`)
  }
  const loadPreset = () => {
    bodyIn.value = JSON.stringify(current()[3], null, 2)
    refresh()
  }
  presetSel.addEventListener('change', loadPreset)
  instSel.addEventListener('change', refresh)
  bodyIn.addEventListener('input', refresh)
  loadPreset()

  if (!all.length) return [h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Testar API'))), h('div', { class: 'card empty' }, h('b', {}, 'Crie uma instância primeiro'), h('a', { class: 'btn btn-primary', href: '#/instancias', style: 'margin-top:12px' }, 'Ir para instâncias'))]

  return [
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Testar API'), h('p', {}, 'Faça chamadas reais com o token da instância, sem sair do painel.'))),
    h('div', { class: 'grid grid-2', style: 'align-items:start' },
      h('div', { class: 'card' },
        h('div', { class: 'card-body' },
          h('label', { class: 'field' }, h('span', {}, 'Instância'), instSel),
          h('label', { class: 'field' }, h('span', {}, 'Ação'), presetSel),
          h('div', { class: 'row', style: 'margin-bottom:10px' }, methodTag, pathTag),
          h('label', { class: 'field' }, h('span', {}, 'Parâmetros (JSON)'), bodyIn, h('small', {}, 'Dica: use o seu próprio número para testar sem incomodar ninguém.')),
          action('Enviar requisição', async () => {
            let params
            try {
              params = JSON.parse(bodyIn.value || '{}')
            } catch {
              throw new Error('JSON inválido nos parâmetros')
            }
            const [, method] = current()
            respOut.textContent = 'Enviando…'
            const started = performance.now()
            const res = await fetch(buildUrl(params), {
              method,
              headers: { authorization: `Bearer ${inst().token}`, ...(method === 'GET' ? {} : { 'content-type': 'application/json' }) },
              body: method === 'GET' ? undefined : JSON.stringify(params),
            })
            const text = await res.text()
            let pretty = text
            try {
              pretty = JSON.stringify(JSON.parse(text), null, 2)
            } catch {}
            respStatus.replaceChildren(h('span', { class: 'dot ' + (res.ok ? 'ok' : 'bad') }), `${res.status} · ${Math.round(performance.now() - started)} ms`)
            respOut.textContent = pretty
          }, 'btn btn-primary btn-pill', 'play'),
        ),
      ),
      h('div', { class: 'grid' },
        h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:10px' }, h('h2', { style: 'margin:0' }, 'Resposta'), respStatus), respOut)),
        h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('h2', {}, 'Mesma chamada via cURL'), h('p', { class: 'sub' }, 'O token aparece cortado aqui; copie o completo na aba ID e token.'), curlOut)),
      ),
    ),
  ]
}

// ============ chaves e conta ============

/** Lista das chaves da conta: o "último uso" é o que diz se dá para revogar sem quebrar nada */
async function tabelaDeChaves() {
  const { keys } = await api('/painel/api/api-keys')
  if (!keys.length) return h('div', { class: 'empty', style: 'margin-top:16px' }, h('b', {}, 'Nenhuma chave'), 'Crie uma acima para um sistema usar a API.')
  return h('div', { class: 'table-wrap', style: 'margin-top:16px' },
    h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Apelido'), h('th', {}, 'Criada'), h('th', {}, 'Último uso'), h('th', {}))),
      h('tbody', {}, keys.map((k) =>
        h('tr', { style: k.revoked_at ? 'opacity:.55' : '' },
          h('td', {}, h('b', {}, k.name), k.hint ? h('small', { class: 'mono muted' }, ` …${k.hint}`) : null),
          h('td', { class: 'muted' }, fmtDate(k.created_at), k.created_by_email ? h('small', {}, ` por ${k.created_by_email}`) : null),
          h('td', { class: 'muted' }, k.revoked_at
            ? `revogada em ${fmtDate(k.revoked_at)}${k.revoked_by_email ? ` por ${k.revoked_by_email}` : ''}`
            : k.last_used_at ? fmtDate(k.last_used_at) : 'nunca usada'),
          h('td', {}, k.revoked_at ? null : action('Revogar', async () => {
            if (!confirm(`Revogar a chave "${k.name}"? Quem estiver usando ela para de funcionar na hora. As outras continuam valendo.`)) return
            await api(`/painel/api/api-keys/${k.id}/revoke`, { method: 'POST' })
            toast('Chave revogada')
            route()
          }, 'btn btn-danger btn-sm', 'trash')),
        ),
      )),
    ),
  )
}

async function renderKeys() {
  const keyOut = h('div')
  const nome = h('input', { type: 'text', placeholder: 'ex.: CRM' })
  const lista = h('div', {}, await tabelaDeChaves())
  const base = state.me.publicUrl.replace(/\/$/, '')
  return [
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Chaves de API'), h('p', {}, 'Uma chave por sistema que cria e gerencia instâncias sozinho.'))),
    h('div', { class: 'grid grid-2', style: 'align-items:start' },
      h('div', { class: 'card' },
        h('div', { class: 'card-body' },
          h('h2', {}, 'Chaves de parceiro'),
          h('p', { class: 'sub' }, 'Com ela, um sistema cria uma instância nova sozinho (por exemplo, quando o cliente clica em "Conectar WhatsApp") e recebe o ID e o token na hora, sem ninguém entrar no painel. Use uma chave por sistema: assim, revogar uma não atrapalha as outras. Por segurança, ela só aparece uma vez.'),
          h('label', { class: 'field' }, h('span', {}, 'Apelido'), nome, h('small', {}, 'De onde essa chave vai ser usada. Ex.: CRM, site, automação.')),
          action('Criar chave', async () => {
            const apelido = nome.value.trim()
            if (!apelido) return toast('Dê um apelido à chave', true)
            const { apiKey } = await api('/painel/api/api-keys', { method: 'POST', body: { name: apelido } })
            nome.value = ''
            keyOut.replaceChildren(
              h('div', { class: 'note warn', style: 'margin:16px 0 10px' }, 'Copie agora: ela não aparece de novo.'),
              h('div', { class: 'secret' }, h('code', {}, apiKey), h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copy(apiKey, 'Chave copiada') }, icon('copy'), 'Copiar')),
            )
            lista.replaceChildren(await tabelaDeChaves())
          }, 'btn btn-primary', 'key'),
          keyOut,
          lista,
        ),
      ),
      h('div', { class: 'card' },
        h('div', { class: 'card-body' },
          h('h2', {}, 'Como usar'),
          h('p', { class: 'sub' }, 'Criar uma instância nova pela API:'),
          h('pre', { class: 'code' }, `curl -X POST "${base}/v1/integrator/create-instance" \\\n  -H "Authorization: Bearer SUA_CHAVE" \\\n  -H "Content-Type: application/json" \\\n  -d '{"instanceName": "Cliente X"}'`),
          h('p', { class: 'sub', style: 'margin:12px 0 0' }, 'A resposta traz instanceId e token. Veja o passo a passo completo na documentação.'),
        ),
      ),
    ),
  ]
}

async function renderAccount() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' })
  const next = h('input', { type: 'password', autocomplete: 'new-password' })
  const alerts = await api('/account/alerts').catch(() => ({ alertEmails: [], fallback: [] }))
  const emails = h('textarea', { placeholder: 'um e-mail por linha', rows: 4 }, alerts.alertEmails.join('\n'))
  return [
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Minha conta'), h('p', {}, `${state.me.account_name} · ${state.me.email}`))),
    h('div', { class: 'card', style: 'max-width:520px;margin-bottom:16px' },
      h('div', { class: 'card-body' },
        h('h2', {}, 'E-mails de alerta'),
        h('p', { class: 'sub' }, 'Recebem aviso quando um número cai, fica instável ou volta a funcionar.'),
        h('label', { class: 'field' },
          h('span', {}, 'E-mails'),
          emails,
          h('small', {}, alerts.alertEmails.length ? 'Um por linha.' : `Em branco, os avisos vão para os usuários do painel: ${alerts.fallback.join(', ') || 'nenhum'}.`),
        ),
        action('Salvar e-mails', async () => {
          const list = emails.value.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean)
          await api('/account/alerts', { method: 'PUT', body: { alertEmails: list } })
          toast('E-mails de alerta salvos')
        }, 'btn btn-primary'),
      ),
    ),
    h('div', { class: 'card', style: 'max-width:520px' },
      h('div', { class: 'card-body' },
        h('h2', { style: 'margin-bottom:18px' }, 'Trocar senha'),
        h('label', { class: 'field' }, h('span', {}, 'Senha atual'), cur),
        h('label', { class: 'field' }, h('span', {}, 'Senha nova'), next, h('small', {}, 'Mínimo de 10 caracteres.')),
        action('Trocar senha', async () => {
          await api('/painel/api/password', { method: 'POST', body: { current: cur.value, next: next.value } })
          cur.value = next.value = ''
          toast('Senha trocada')
        }, 'btn btn-primary'),
      ),
    ),
  ]
}

// ============ webhooks (atalho por número) ============

async function renderWebhooksHub() {
  const all = await listInstances()
  const head = h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Webhooks'), h('p', {}, 'Cada número tem as próprias URLs. Escolha qual configurar.')))
  if (!all.length) return [head, h('div', { class: 'card empty' }, h('b', {}, 'Crie uma instância primeiro'), h('a', { class: 'btn btn-primary', href: '#/instancias', style: 'margin-top:12px' }, 'Ir para instâncias'))]
  return [
    head,
    h('div', { class: 'card table-wrap' },
      h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Número'), h('th', {}, 'Situação'), h('th', {}, 'URLs configuradas'), h('th', {}))),
        h('tbody', {}, all.map((i) => {
          const urls = Object.values(i.wapiWebhooks || {}).filter(Boolean).length + (i.webhookUrl ? 1 : 0)
          return h('tr', {},
            h('td', {}, h('b', { style: 'font-weight:500' }, i.name)),
            h('td', {}, h('span', { class: 'tag' }, h('span', { class: `dot ${st(i.status)[1]}` }), st(i.status)[0])),
            h('td', { class: 'muted' }, urls ? String(urls) : 'Nenhuma'),
            h('td', { style: 'text-align:right' }, h('a', { class: 'btn btn-sm', href: `#/instancias/${i.id}/webhooks` }, 'Configurar')),
          )
        })),
      ),
    ),
  ]
}

// ============ gráficos (SVG sem biblioteca: a CSP só aceita script deste site) ============

function svgEl(tag, attrs, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v)
  el.append(...children)
  return el
}

const fmtN = (n) => Number(n).toLocaleString('pt-BR')
const fmtAxis = (v) => (v >= 10000 ? `${fmtN(v / 1000)} mil` : fmtN(v))

/** Marcas redondas do eixo Y. Contagem é inteira: nunca repete rótulo como 1, 1, 2, 2. */
function niceTicks(max) {
  if (max <= 0) return [0, 1, 2, 3, 4]
  const rough = max / 4
  const mag = 10 ** Math.floor(Math.log10(rough))
  const norm = rough / mag
  const step = Math.max(1, Math.ceil((norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag))
  const out = []
  for (let v = 0; v < max + step; v += step) out.push(v)
  return out
}

/** Curva suave que não passa do valor real (não inventa pico nem número negativo) */
function monotonePath(p) {
  const n = p.length
  const dx = []
  const m = []
  for (let i = 0; i < n - 1; i++) {
    dx[i] = p[i + 1][0] - p[i][0]
    m[i] = (p[i + 1][1] - p[i][1]) / dx[i]
  }
  const t = [m[0]]
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (2 * m[i - 1] * m[i]) / (m[i - 1] + m[i])
  t[n - 1] = m[n - 2]
  let d = `M${p[0][0]},${p[0][1]}`
  for (let i = 0; i < n - 1; i++) {
    d += `C${p[i][0] + dx[i] / 3},${p[i][1] + (t[i] * dx[i]) / 3} ${p[i + 1][0] - dx[i] / 3},${p[i + 1][1] - (t[i + 1] * dx[i]) / 3} ${p[i + 1][0]},${p[i + 1][1]}`
  }
  return d
}

/** Desenha quando sabe a largura e redesenha se ela mudar */
function chartBox(draw) {
  const box = h('div', { class: 'chart' })
  let last = 0
  new ResizeObserver(([e]) => {
    const w = Math.round(e.contentRect.width)
    if (w && w !== last) {
      last = w
      box.replaceChildren()
      draw(box, w, box.clientHeight)
    }
  }).observe(box)
  return box
}

function showTip(box, tip, x, y, value, label) {
  tip.replaceChildren(h('b', {}, value), h('span', {}, label))
  tip.hidden = false
  const w = tip.offsetWidth
  tip.style.left = `${Math.max(0, Math.min(x - w / 2, box.clientWidth - w))}px`
  tip.style.top = `${Math.max(0, y - tip.offsetHeight - 12)}px`
}

function yAxis(svg, ticks, W, left, right, yOf) {
  for (const v of ticks) {
    svg.append(
      svgEl('line', { class: 'grid-line', x1: left, x2: W - right, y1: yOf(v), y2: yOf(v) }),
      svgEl('text', { x: left - 10, y: yOf(v) + 4, 'text-anchor': 'end' }, fmtAxis(v)),
    )
  }
}

/** Área: uma série ao longo do tempo. points = [{ label, tick, value }]; o tick é o rótulo curto do eixo. */
function areaChart(points, name, emptyText) {
  return chartBox((box, W, H) => {
    const L = 46, R = 12, T = 12, B = 28
    const max = Math.max(0, ...points.map((p) => p.value))
    const ticks = niceTicks(max)
    const top = ticks[ticks.length - 1]
    const xOf = (i) => (points.length === 1 ? (L + W - R) / 2 : L + (i * (W - L - R)) / (points.length - 1))
    const yOf = (v) => H - B - (v / top) * (H - T - B)
    const total = points.reduce((a, p) => a + p.value, 0)
    const svg = svgEl('svg', { width: W, height: H, role: 'img', tabindex: 0, 'aria-label': `${name}: ${fmtN(total)} no período, máximo de ${fmtN(max)}. Os valores também estão na tabela abaixo do gráfico.` })
    svg.append(svgEl('defs', {}, svgEl('linearGradient', { id: 'area-wash', x1: 0, x2: 0, y1: 0, y2: 1 },
      svgEl('stop', { offset: '0%', style: 'stop-color:var(--chart);stop-opacity:.16' }),
      svgEl('stop', { offset: '100%', style: 'stop-color:var(--chart);stop-opacity:0' }),
    )))
    yAxis(svg, ticks, W, L, R, yOf)
    const pts = points.map((p, i) => [xOf(i), yOf(p.value)])
    if (pts.length > 1) {
      const line = monotonePath(pts)
      svg.append(
        svgEl('path', { d: `${line}L${pts[pts.length - 1][0]},${yOf(0)}L${pts[0][0]},${yOf(0)}Z`, fill: 'url(#area-wash)' }),
        svgEl('path', { class: 'series-line', d: line }),
      )
    }
    const slots = Math.max(2, Math.floor((W - L - R) / 62))
    const every_ = Math.max(1, Math.ceil((points.length - 1) / (slots - 1)))
    points.forEach((p, i) => {
      if (i % every_ === 0) svg.append(svgEl('text', { x: xOf(i), y: H - 8, 'text-anchor': 'middle' }, p.tick))
    })
    const cross = svgEl('line', { class: 'crosshair', y1: T, y2: yOf(0), visibility: 'hidden' })
    const dot = svgEl('circle', { class: 'series-dot', r: 5, visibility: pts.length === 1 ? 'visible' : 'hidden', cx: pts[0]?.[0], cy: pts[0]?.[1] })
    svg.append(cross, dot)
    const tip = h('div', { class: 'chart-tip', hidden: true })
    let current = points.length - 1
    const focusAt = (i) => {
      current = i
      cross.setAttribute('x1', xOf(i))
      cross.setAttribute('x2', xOf(i))
      cross.setAttribute('visibility', 'visible')
      dot.setAttribute('cx', xOf(i))
      dot.setAttribute('cy', yOf(points[i].value))
      dot.setAttribute('visibility', 'visible')
      showTip(box, tip, xOf(i), yOf(points[i].value), fmtN(points[i].value), points[i].label)
    }
    const blur = () => {
      tip.hidden = true
      cross.setAttribute('visibility', 'hidden')
      if (pts.length > 1) dot.setAttribute('visibility', 'hidden')
    }
    svg.addEventListener('pointermove', (e) => {
      const x = e.clientX - svg.getBoundingClientRect().left
      focusAt(Math.max(0, Math.min(points.length - 1, Math.round(points.length === 1 ? 0 : ((x - L) * (points.length - 1)) / (W - L - R)))))
    })
    svg.addEventListener('pointerleave', blur)
    svg.addEventListener('focus', () => { if (svg.matches(':focus-visible')) focusAt(current) })
    svg.addEventListener('blur', blur)
    svg.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') focusAt(Math.max(0, current - 1))
      else if (e.key === 'ArrowRight') focusAt(Math.min(points.length - 1, current + 1))
    })
    box.append(svg, tip)
    if (!total) box.append(h('div', { class: 'chart-empty' }, emptyText))
  })
}

/** Colunas: poucos valores, cada um com o número em cima. bars = [{ label, tick, value }] */
function barChart(bars, name, emptyText) {
  return chartBox((box, W, H) => {
    const L = 46, R = 12, T = 24, B = 28
    const max = Math.max(0, ...bars.map((b) => b.value))
    const ticks = niceTicks(max)
    const top = ticks[ticks.length - 1]
    const yOf = (v) => H - B - (v / top) * (H - T - B)
    const band = (W - L - R) / bars.length
    const barW = Math.min(44, band * 0.6)
    const svg = svgEl('svg', { width: W, height: H, role: 'group', 'aria-label': `${name}. Os valores também estão na tabela abaixo do gráfico.` })
    yAxis(svg, ticks, W, L, R, yOf)
    const tip = h('div', { class: 'chart-tip', hidden: true })
    bars.forEach((b, i) => {
      const cx = L + band * i + band / 2
      const y = yOf(b.value)
      const r = Math.min(6, barW / 2, yOf(0) - y)
      const x0 = cx - barW / 2
      const x1 = cx + barW / 2
      const g = svgEl('g', { class: 'bar-group', tabindex: 0, role: 'img', 'aria-label': `${b.label}: ${fmtN(b.value)}` })
      g.append(svgEl('rect', { x: L + band * i, y: T, width: band, height: H - T - B, fill: 'transparent' }))
      if (b.value > 0) g.append(svgEl('path', { class: 'bar', d: `M${x0},${yOf(0)}V${y + r}Q${x0},${y} ${x0 + r},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${yOf(0)}Z` }))
      if (max > 0) g.append(svgEl('text', { class: 'value-label', x: cx, y: y - 7, 'text-anchor': 'middle' }, fmtAxis(b.value)))
      // "06/10–13/10" não cabe em coluna estreita (celular): fica só o início da semana
      g.append(svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle' }, band < 84 ? b.shortTick : b.tick))
      const show = () => showTip(box, tip, cx, y, fmtN(b.value), b.label)
      g.addEventListener('pointermove', show)
      g.addEventListener('focus', show)
      g.addEventListener('pointerleave', () => (tip.hidden = true))
      g.addEventListener('blur', () => (tip.hidden = true))
      svg.append(g)
    })
    box.append(svg, tip)
    if (!max) box.append(h('div', { class: 'chart-empty' }, emptyText))
  })
}

/** O gráfico tem que ser legível sem mouse: os mesmos números, em tabela */
function chartTable(cols, rows) {
  return h('details', { class: 'chart-table' },
    h('summary', {}, 'Ver em tabela'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c))))),
    )),
  )
}

// ============ dashboard ============

// Ilustrações próprias: pedestal roxo com o objeto flutuando. Constantes fixas, por isso podem ir como SVG.
const artBase = (top) => {
  const slab = (y, size, fill, extra = '') => `<rect x="${-size / 2}" y="${-size / 2}" width="${size}" height="${size}" rx="${size / 5}" transform="translate(70 ${y}) scale(1 .5) rotate(45)" fill="${fill}" ${extra}/>`
  let layers = ''
  for (let y = 106; y > 94; y -= 2) layers += slab(y, 74, 'var(--art-side)')
  return `<svg viewBox="0 0 140 140" aria-hidden="true">
    <defs><linearGradient id="art-${top}" x1="0" x2="1" y1="0" y2="1"><stop offset="0" style="stop-color:color-mix(in srgb,var(--brand) 62%,white)"/><stop offset="1" style="stop-color:var(--brand)"/></linearGradient></defs>
    <ellipse cx="70" cy="118" rx="52" ry="12" style="fill:var(--brand);opacity:.1"/>
    ${layers}${slab(94, 74, 'var(--art-top)')}${slab(92, 44, 'var(--brand)', 'opacity=".2"')}${slab(92, 26, 'var(--brand)', 'opacity=".38"')}`
}
const ART = {
  send: `${artBase('send')}
    <rect x="36" y="14" width="68" height="52" rx="16" fill="url(#art-send)"/><path d="M52 62v16l18-14z" fill="url(#art-send)"/>
    <path d="M54 41l34-15-10 32-8-13z" fill="#fff"/><path d="M70 45l18-19-22 18z" fill="#fff" opacity=".7"/></svg>`,
  inbox: `${artBase('inbox')}
    <rect x="58" y="8" width="52" height="38" rx="13" style="fill:var(--brand);opacity:.28"/>
    <rect x="30" y="24" width="68" height="46" rx="15" fill="url(#art-inbox)"/><path d="M78 66v14l-16-12z" fill="url(#art-inbox)"/>
    <circle cx="50" cy="47" r="4.5" fill="#fff"/><circle cx="64" cy="47" r="4.5" fill="#fff"/><circle cx="78" cy="47" r="4.5" fill="#fff"/></svg>`,
}
function art(name) {
  const el = h('div', { class: 'dash-art' })
  el.innerHTML = ART[name]
  return el
}

const PERIODS = [['today', 'Hoje'], ['7d', '7 dias'], ['30d', '30 dias']]
const pad2 = (n) => String(n).padStart(2, '0')
const ddmm = (d) => {
  const x = new Date(d)
  return `${pad2(x.getDate())}/${pad2(x.getMonth() + 1)}`
}
const fmtDuration = (s) => {
  if (s < 60) return s ? '< 1 min' : '0 min'
  const min = Math.round(s / 60)
  if (min < 60) return `${min} min`
  const hours = Math.floor(min / 60)
  if (hours < 48) return `${hours}h ${pad2(min % 60)}`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Variação contra o período anterior. Sem base para comparar, não mostra nada em vez de inventar. */
function deltaTag(cur, prev, upIsGood = true) {
  if (prev == null || prev === 0) return null
  const pct = Math.round(((cur - prev) / prev) * 100)
  const cls = pct === 0 ? '' : pct > 0 === upIsGood ? 'good' : 'bad'
  return h('span', { class: `delta ${cls}`, title: 'Comparado ao mesmo trecho do período anterior' }, pct === 0 ? null : icon(pct < 0 ? 'trendDown' : 'trendUp'), `${pct > 0 ? '+' : ''}${pct}%`)
}

function dashboardBody(all, d, setPeriod) {
  const connected = all.filter((i) => i.status === 'connected').length
  const hourly = d.period === 'today'
  const points = d.series.map((p) => {
    const [date, time] = p.t.split('T')
    const [, month, day] = date.split('-')
    return { value: p.sent, tick: hourly ? `${time.slice(0, 2)}h` : `${day}/${month}`, label: hourly ? `${time.slice(0, 2)}h às ${time.slice(0, 2)}h59` : `${day}/${month}` }
  })
  const heroCell = (label, hint, value, unit, delta, note, artName) => h('div', { class: 'dash-hero-cell' },
    h('div', { style: 'min-width:0' },
      h('div', { class: 'dash-hero-label' }, label, hint ? h('span', { class: 'hint', title: hint, 'aria-label': hint }, icon('info')) : null),
      h('div', { class: 'big' }, fmtN(value), h('small', {}, unit), delta),
      note ? h('div', { class: 'dash-sub' }, note) : null,
    ),
    art(artName),
  )
  const kpi = (ico, label, value, extra, sub) => h('div', {},
    h('div', { class: 'kpi-label' }, icon(ico), label),
    h('div', { class: 'kpi-value' }, value, extra),
    sub ? h('div', { class: 'kpi-sub' }, sub) : null,
  )
  const hookTotal = d.webhooks.delivered + d.webhooks.failed

  const metricBox = h('div')
  const metricPills = h('div', { class: 'pills' })
  const drawMetric = () => {
    const key = state.dash.metric
    const label = key === 'sent' ? 'Enviadas' : 'Falhas'
    const bars = d.weekly.map((w) => ({ value: w[key], tick: `${ddmm(w.from)}–${ddmm(w.to)}`, shortTick: ddmm(w.from), label: `${label}, ${ddmm(w.from)} a ${ddmm(w.to)}` }))
    metricBox.replaceChildren(
      barChart(bars, `${label} nas últimas 4 semanas`, key === 'sent' ? 'Sem envios nas últimas 4 semanas.' : 'Nenhuma falha nas últimas 4 semanas.'),
      chartTable(['Semana', 'Enviadas', 'Falhas'], d.weekly.map((w) => [`${ddmm(w.from)} a ${ddmm(w.to)}`, fmtN(w.sent), fmtN(w.failed)])),
    )
    metricPills.replaceChildren(...[['sent', 'Enviadas'], ['failed', 'Falhas']].map(([k, l]) =>
      h('button', { class: 'pill' + (k === key ? ' on' : ''), type: 'button', 'aria-pressed': String(k === key), onclick: () => { state.dash.metric = k; drawMetric() } }, l)))
  }
  drawMetric()

  const now = new Date()
  return [
    h('div', { class: 'dash-filters' },
      h('div', { class: 'pills', role: 'group', 'aria-label': 'Período' }, PERIODS.map(([k, l]) =>
        h('button', { class: 'pill' + (k === d.period ? ' on' : ''), type: 'button', 'aria-pressed': String(k === d.period), onclick: () => setPeriod(k) }, l))),
      h('span', { class: 'dash-updated' }, `Atualizado às ${pad2(now.getHours())}:${pad2(now.getMinutes())}`),
    ),
    h('div', { class: 'dash-hero' },
      heroCell('Enviadas pela API', 'Mensagens que saíram pela fila da API. O que é enviado direto pelo celular não entra aqui.', d.sent.value, d.sent.value === 1 ? 'mensagem' : 'mensagens', deltaTag(d.sent.value, d.sent.previous), d.sent.partial ? `Só os últimos ${d.retention.envios} dias` : null, 'send'),
      heroCell('Recebidas', `Mensagens que chegaram nos números conectados, sem contar status e histórico importado. Ficam guardadas por ${d.retention.mensagens} dias.`, d.received.value, d.received.value === 1 ? 'mensagem' : 'mensagens', deltaTag(d.received.value, d.received.previous), d.received.partial ? `Só os últimos ${d.retention.mensagens} dias` : null, 'inbox'),
    ),
    h('div', { class: 'card kpis' },
      kpi('phone', 'Conectados', fmtN(connected), h('small', {}, `de ${fmtN(all.length)}`), connected === all.length ? null : `${fmtN(all.length - connected)} fora do ar`),
      kpi('layers', 'Na fila agora', fmtN(d.queued)),
      kpi('alert', 'Falhas de envio', fmtN(d.failed.value), deltaTag(d.failed.value, d.failed.previous, false), d.failed.partial ? `Só os últimos ${d.retention.envios} dias` : null),
      kpi('webhook', 'Webhooks entregues', hookTotal ? `${Math.round((d.webhooks.delivered / hookTotal) * 100)}%` : '—', null,
        hookTotal ? `${fmtN(d.webhooks.delivered)} de ${fmtN(hookTotal)}${d.webhooks.partial ? `, últimos ${d.retention.webhooks} dias` : ''}` : 'Nenhuma entrega no período'),
      kpi('clock', 'Tempo fora do ar', fmtDuration(d.downtime.seconds), null, `${fmtN(d.downtime.drops)} ${d.downtime.drops === 1 ? 'queda' : 'quedas'}`),
    ),
    h('div', { class: 'dash-charts' },
      h('div', { class: 'card chart-card' },
        h('div', { class: 'chart-head' }, h('div', { class: 'chart-title' }, icon('trendUp'), hourly ? 'Envios por hora' : 'Envios por dia')),
        areaChart(points, hourly ? 'Envios por hora, hoje' : 'Envios por dia', 'Nenhum envio neste período.'),
        chartTable([hourly ? 'Hora' : 'Dia', 'Enviadas'], points.map((p) => [p.tick, fmtN(p.value)])),
      ),
      h('div', { class: 'card chart-card' },
        h('div', { class: 'chart-head' }, h('div', { class: 'chart-title' }, icon('trendUp'), 'Evolução', h('small', {}, 'últimas 4 semanas')), metricPills),
        metricBox,
      ),
    ),
    d.received.partial || d.webhooks.partial
      ? h('div', { class: 'note dash-note' }, d.retention.mensagens === d.retention.webhooks
          ? `Mensagens recebidas e entregas de webhook ficam guardadas por ${d.retention.webhooks} dias. Em períodos maiores, esses dois números cobrem só esse trecho.`
          : `Mensagens recebidas ficam guardadas por ${d.retention.mensagens} dias e entregas de webhook por ${d.retention.webhooks}. Em períodos maiores, esses dois números cobrem só esse trecho.`)
      : null,
  ]
}

async function renderDashboard() {
  const wrap = h('div', { class: 'dash' })
  let lastStatus = null
  const load = async () => {
    const [all, d] = await Promise.all([listInstances(), api(`/painel/api/dashboard?period=${state.dash.period}`)])
    const status = JSON.stringify(all.map((i) => [i.id, i.status]))
    // Número caiu ou voltou: redesenha tudo, porque a faixa de aviso e o sino mudam junto
    if (lastStatus && status !== lastStatus) return route()
    lastStatus = status
    wrap.classList.remove('loading')
    wrap.replaceChildren(...dashboardBody(all, d, (period) => {
      state.dash.period = period
      wrap.classList.add('loading')
      load().catch((e) => { wrap.classList.remove('loading'); toast(e.message, true) })
    }).filter(Boolean))
  }
  await load()
  every(30000, () => load().catch(() => null))
  return wrap
}

route().catch((e) => toast(e.message, true))

/** Texto sobre a cor da marca: branco ou quase-preto, o que tiver mais contraste (WCAG) */
function inkFor(hex) {
  const lum = (c) => {
    const v = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4))
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]
  }
  const l = lum(hex)
  return (1.05 / (l + 0.05)) >= (l + 0.05) / (lum('#04120c') + 0.05) ? '#ffffff' : '#04120c'
}

/** Logo da marca (imagem) ou a inicial do nome */
function brandMark(brand) {
  if (brand.logo) return h('img', { class: 'brand-logo', src: brand.logo, alt: '' })
  return h('span', { class: 'brand-mark' }, (brand.name || '?').trim()[0].toUpperCase())
}
