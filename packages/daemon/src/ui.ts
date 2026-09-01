/**
 * The web UI, served by the daemon at `/ui`.
 *
 * One self-contained document: no bundler, no CDN, no external asset. That is a
 * deliberate choice for a first version — the daemon already exposes everything
 * the screen needs, and a build step would be more machinery than the page.
 * When the UI grows past what one file can carry, it becomes its own package
 * with Vite behind it and this goes away.
 *
 * The page reads its token from its own query string, which is how it can be
 * opened by URL and still authenticate every call.
 *
 * The embedded script deliberately avoids template literals: this whole document
 * is one, and nesting them is a needless way to break the build.
 */
export function renderUi(version: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mnemonima</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --panel: #f6f7f9; --border: #e2e5ea; --text: #14171c;
    --muted: #656d78; --accent: #2f6feb; --accent-soft: #dce7fd;
    --ok: #1a7f4b; --warn: #a25c00;
    --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #14171c; --panel: #1b1f26; --border: #2a3038; --text: #e6e9ee;
      --muted: #9aa3af; --accent: #6699ff; --accent-soft: #1e2b45;
      --ok: #55c08a; --warn: #d9a441;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
    display: grid; grid-template-columns: 260px 1fr; height: 100vh;
  }
  aside {
    border-right: 1px solid var(--border); background: var(--panel);
    padding: 16px; overflow-y: auto; display: flex; flex-direction: column; gap: 18px;
  }
  h1 { font-size: 15px; margin: 0; letter-spacing: .04em; text-transform: uppercase; }
  h1 span { color: var(--muted); font-weight: 400; text-transform: none; letter-spacing: 0; }
  h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em;
       color: var(--muted); margin: 0 0 8px; }
  main { display: flex; flex-direction: column; overflow: hidden; }
  .bar { display: flex; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--border);
         align-items: center; flex-wrap: wrap; }
  input, select, button {
    font: inherit; color: inherit; background: var(--bg);
    border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px;
  }
  input[type=search] { flex: 1; min-width: 220px; }
  input[type=range] { padding: 0; }
  button { cursor: pointer; }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button.tab { border: 0; background: none; color: var(--muted); padding: 6px 2px; margin-right: 14px;
               border-bottom: 2px solid transparent; border-radius: 0; }
  button.tab[aria-selected=true] { color: var(--text); border-bottom-color: var(--accent); }
  .content { flex: 1; overflow: auto; padding: 16px; }
  .split { display: grid; grid-template-columns: 1fr 380px; gap: 0; height: 100%; overflow: hidden; }
  .split > div { overflow: auto; padding: 16px; }
  .split > div + div { border-left: 1px solid var(--border); background: var(--panel); }
  .project { display: block; width: 100%; text-align: left; border: 1px solid transparent;
             background: none; padding: 7px 9px; border-radius: 6px; margin-bottom: 2px; }
  .project:hover { background: var(--bg); }
  .project[aria-current=true] { background: var(--accent-soft); border-color: var(--accent); }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%;
         background: var(--border); margin-right: 7px; vertical-align: middle; }
  .dot.hot { background: var(--ok); }
  .stat { display: flex; justify-content: space-between; gap: 10px; padding: 2px 0; }
  .stat span:last-child { color: var(--muted); font-family: var(--mono); font-size: 12px; }
  .hit { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin-bottom: 10px;
         background: var(--panel); cursor: pointer; }
  .hit:hover { border-color: var(--accent); }
  .hit h3 { margin: 0 0 2px; font-size: 14px; }
  .id { font-family: var(--mono); color: var(--muted); font-size: 12px; margin-right: 8px; }
  .why { display: flex; height: 6px; border-radius: 3px; overflow: hidden; margin: 8px 0; background: var(--border); }
  .why i { display: block; }
  .legend { display: flex; gap: 12px; font-size: 11px; color: var(--muted); flex-wrap: wrap; }
  .legend b { font-weight: 500; }
  .snippet { font-size: 13px; color: var(--muted); margin-top: 6px; }
  .snippet em { color: var(--text); font-style: normal; font-family: var(--mono); font-size: 11px; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 7px; border-radius: 10px;
         border: 1px solid var(--border); margin: 0 4px 4px 0; }
  .tag.manual { border-color: var(--accent); color: var(--accent); }
  pre { white-space: pre-wrap; word-wrap: break-word; font-family: var(--mono); font-size: 12.5px;
        background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 12px; }
  canvas { width: 100%; height: 100%; display: block; cursor: grab; }
  .empty { color: var(--muted); padding: 24px 0; }
  a { color: var(--accent); }
  code { font-family: var(--mono); font-size: 12px; }
</style>
</head>
<body>
<aside>
  <h1>mnemonima <span>${version}</span></h1>

  <div>
    <h2>Projects</h2>
    <div id="projects"></div>
  </div>

  <div>
    <h2>Daemon</h2>
    <div id="daemon"></div>
  </div>

  <div>
    <h2>Loaded in memory</h2>
    <div id="loaded"></div>
  </div>
</aside>

<main>
  <div class="bar">
    <button class="tab" id="tab-search" aria-selected="true">Search</button>
    <button class="tab" id="tab-graph" aria-selected="false">Graph</button>
  </div>

  <div class="bar" id="search-bar">
    <input type="search" id="q" placeholder="Search, in English">
    <select id="mode">
      <option value="hybrid">hybrid</option>
      <option value="semantic">semantic</option>
      <option value="lexical">lexical</option>
      <option value="exact">exact</option>
    </select>
    <label style="color:var(--muted);font-size:12px">text
      <input type="range" id="balance" min="0" max="100" value="50" style="vertical-align:middle">
      vector</label>
    <span id="balance-label" style="color:var(--muted);font-family:var(--mono);font-size:12px"></span>
    <button class="primary" id="go">Find</button>
  </div>

  <div class="split" id="view">
    <div id="results"><p class="empty">Pick a project and search.</p></div>
    <div id="detail"><p class="empty">Nothing selected.</p></div>
  </div>
</main>

<script>
(function () {
  var token = new URLSearchParams(location.search).get('token') || ''
  var project = null
  var tab = 'search'

  function api(path, options) {
    var init = options || {}
    init.headers = Object.assign({ authorization: 'Bearer ' + token }, init.headers || {})
    return fetch(path, init).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) throw new Error(body.error || 'request failed')
        return body
      })
    })
  }

  function el(tag, className, text) {
    var node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
  }

  function ms(value) {
    if (value < 1000) return Math.round(value) + ' ms'
    if (value < 60000) return (value / 1000).toFixed(1) + ' s'
    return Math.round(value / 60000) + ' min'
  }

  // ---- sidebar -----------------------------------------------------------

  function refreshStatus() {
    return api('/status').then(function (status) {
      var daemon = document.getElementById('daemon')
      daemon.innerHTML = ''
      ;[
        ['uptime', ms(status.uptimeMs)],
        ['memory', status.memory.rssMb + ' MB'],
        ['capacity', status.loaded.length + ' / ' + status.capacity],
      ].forEach(function (pair) {
        var row = el('div', 'stat')
        row.appendChild(el('span', null, pair[0]))
        row.appendChild(el('span', null, pair[1]))
        daemon.appendChild(row)
      })

      var loaded = document.getElementById('loaded')
      loaded.innerHTML = ''
      if (status.loaded.length === 0) {
        loaded.appendChild(el('p', 'empty', 'Nothing loaded.'))
      } else {
        status.loaded.forEach(function (entry) {
          var box = el('div')
          box.style.marginBottom = '10px'
          box.appendChild(el('div', null, entry.name))
          var detail = entry.index
            ? entry.index.notes + ' notes, ' + entry.index.chunks + ' chunks' +
              (entry.index.fromSnapshot ? ' (restored)' : '')
            : 'index not built'
          var line = el('div', 'stat')
          line.appendChild(el('span', null, ''))
          line.appendChild(el('span', null, detail))
          box.appendChild(line)
          var idle = el('div', 'stat')
          idle.appendChild(el('span', null, ''))
          idle.appendChild(el('span', null, 'idle ' + ms(entry.idleMs)))
          box.appendChild(idle)
          loaded.appendChild(box)
        })
      }

      var list = document.getElementById('projects')
      list.innerHTML = ''
      status.registered.forEach(function (entry) {
        var button = el('button', 'project')
        var dot = el('span', 'dot' + (entry.loaded ? ' hot' : ''))
        button.appendChild(dot)
        button.appendChild(document.createTextNode(entry.name))
        button.setAttribute('aria-current', String(entry.name === project))
        button.onclick = function () {
          project = entry.name
          refreshStatus()
          if (tab === 'graph') drawGraph()
        }
        list.appendChild(button)
      })

      if (project === null && status.registered.length > 0) {
        project = status.registered[0].name
        refreshStatus()
      }
      return status
    })
  }

  // ---- search ------------------------------------------------------------

  var COLOURS = { text: '#2f6feb', vector: '#8b5cf6', meta: '#1a7f4b', graph: '#d9a441', multiChunk: '#94a3b8' }

  function whyBar(why) {
    var parts = ['text', 'vector', 'meta', 'graph', 'multiChunk']
    var total = parts.reduce(function (sum, key) { return sum + Math.max(0, why[key]) }, 0)
    var bar = el('div', 'why')
    if (total <= 0) return bar
    parts.forEach(function (key) {
      var value = Math.max(0, why[key])
      if (value <= 0) return
      var piece = el('i')
      piece.style.width = (value / total * 100) + '%'
      piece.style.background = COLOURS[key]
      piece.title = key + ' ' + value.toFixed(3)
      bar.appendChild(piece)
    })
    return bar
  }

  function search() {
    if (project === null) return
    var balance = Number(document.getElementById('balance').value) / 100
    var mode = document.getElementById('mode').value

    var body = {
      query: document.getElementById('q').value,
      mode: mode,
      limit: 20,
      minSimilarity: 0,
      expandLinks: 1,
    }
    if (mode === 'hybrid') body.weights = { text: 1 - balance, vector: balance }

    var results = document.getElementById('results')
    results.innerHTML = ''
    results.appendChild(el('p', 'empty', 'Searching...'))

    api('/projects/' + encodeURIComponent(project) + '/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }).then(function (result) {
      results.innerHTML = ''

      var summary = el('div', 'legend')
      summary.style.marginBottom = '12px'
      summary.appendChild(el('b', null, result.hits.length + ' notes'))
      summary.appendChild(el('span', null, 'from ' + result.candidates + ' candidates in ' + result.tookMs + ' ms'))
      Object.keys(COLOURS).forEach(function (key) {
        var chip = el('span', null, key)
        chip.style.borderBottom = '2px solid ' + COLOURS[key]
        summary.appendChild(chip)
      })
      results.appendChild(summary)

      if (result.hits.length === 0) {
        results.appendChild(el('p', 'empty', 'No matches.'))
        return
      }

      result.hits.forEach(function (hit) {
        var card = el('div', 'hit')
        var head = el('h3')
        head.appendChild(el('span', 'id', hit.id))
        head.appendChild(document.createTextNode(hit.title))
        card.appendChild(head)

        var score = el('div', 'legend')
        score.appendChild(el('b', null, hit.score.toFixed(3)))
        if (hit.via && hit.via.length) score.appendChild(el('span', null, 'via ' + hit.via.join(', ')))
        if (hit.why.matchedChunks) {
          score.appendChild(el('span', null, hit.why.matchedChunks + ' passages, best cut ' + hit.why.bestStrategy))
        }
        card.appendChild(score)
        card.appendChild(whyBar(hit.why))

        hit.snippets.slice(0, 2).forEach(function (snippet) {
          var line = el('div', 'snippet')
          if (snippet.headingPath) line.appendChild(el('em', null, snippet.headingPath + '  '))
          line.appendChild(document.createTextNode(snippet.text.slice(0, 220)))
          card.appendChild(line)
        })

        if (hit.neighbours && hit.neighbours.length) {
          var near = el('div', 'snippet', 'neighbours: ' + hit.neighbours.map(function (n) {
            return n.id + ' (' + n.relation + ')'
          }).join(', '))
          card.appendChild(near)
        }

        card.onclick = function () { openNote(hit.id) }
        results.appendChild(card)
      })

      refreshStatus()
    }).catch(function (error) {
      results.innerHTML = ''
      var box = el('p', 'empty', error.message)
      box.style.color = 'var(--warn)'
      results.appendChild(box)
    })
  }

  // ---- note --------------------------------------------------------------

  function openNote(id) {
    var detail = document.getElementById('detail')
    detail.innerHTML = ''
    detail.appendChild(el('p', 'empty', 'Loading ' + id + '...'))

    api('/projects/' + encodeURIComponent(project) + '/notes/' + encodeURIComponent(id))
      .then(function (note) {
        detail.innerHTML = ''
        var head = el('h3')
        head.style.margin = '0 0 4px'
        head.appendChild(el('span', 'id', note.id))
        head.appendChild(document.createTextNode(note.title))
        detail.appendChild(head)

        var meta = el('div', 'legend')
        meta.appendChild(el('span', null, 'revision ' + note.rev))
        meta.appendChild(el('span', null, note.status))
        meta.appendChild(el('span', null, new Date(note.updatedAt).toLocaleString()))
        detail.appendChild(meta)

        if (note.terms.length) {
          var terms = el('div')
          terms.style.margin = '12px 0'
          note.terms.forEach(function (term) {
            terms.appendChild(el('span', 'tag' + (term.source === 'manual' ? ' manual' : ''), term.term))
          })
          detail.appendChild(terms)
        }

        if (note.neighbours.length) {
          var links = el('div', 'snippet')
          links.appendChild(document.createTextNode('linked: '))
          note.neighbours.forEach(function (n, index) {
            if (index) links.appendChild(document.createTextNode(', '))
            var anchor = el('a', null, n.id)
            anchor.href = '#'
            anchor.onclick = function (event) { event.preventDefault(); openNote(n.id) }
            links.appendChild(anchor)
          })
          detail.appendChild(links)
        }

        var body = el('pre', null, note.body)
        body.style.marginTop = '12px'
        detail.appendChild(body)
      })
      .catch(function (error) {
        detail.innerHTML = ''
        detail.appendChild(el('p', 'empty', error.message))
      })
  }

  // ---- graph -------------------------------------------------------------

  var graphState = null

  function drawGraph() {
    if (project === null) return
    var host = document.getElementById('results')
    host.innerHTML = ''
    host.style.padding = '0'

    var canvas = el('canvas')
    host.appendChild(canvas)

    api('/projects/' + encodeURIComponent(project) + '/graph').then(function (graph) {
      var width = canvas.clientWidth || 800
      var height = canvas.clientHeight || 600
      var ratio = window.devicePixelRatio || 1
      canvas.width = width * ratio
      canvas.height = height * ratio

      var context = canvas.getContext('2d')
      context.scale(ratio, ratio)

      // Fruchterman-Reingold, run to completion before the first paint.
      //
      // Laying out inside an animation loop looks livelier and is unusable: the
      // nodes drift out from under the cursor, so a click lands on whatever
      // moved into that spot. A hundred nodes converge in milliseconds, so the
      // graph is simply computed, then drawn, and only redrawn on hover.
      var area = width * height
      var k = Math.sqrt(area / Math.max(1, graph.nodes.length)) * 0.72

      var nodes = graph.nodes.map(function (node, index) {
        var angle = (index / Math.max(1, graph.nodes.length)) * Math.PI * 2
        var radius = Math.min(width, height) * 0.34
        return {
          id: node.id, title: node.title, degree: node.degree,
          x: width / 2 + Math.cos(angle) * radius,
          y: height / 2 + Math.sin(angle) * radius,
          dx: 0, dy: 0,
        }
      })

      var byId = {}
      nodes.forEach(function (node) { byId[node.id] = node })
      var edges = graph.edges.filter(function (edge) { return byId[edge.from] && byId[edge.to] })

      var iterations = 320
      var temperature = Math.min(width, height) * 0.12

      for (var pass = 0; pass < iterations; pass += 1) {
        nodes.forEach(function (node) { node.dx = 0; node.dy = 0 })

        for (var i = 0; i < nodes.length; i += 1) {
          for (var j = i + 1; j < nodes.length; j += 1) {
            var a = nodes[i], b = nodes[j]
            var rx = a.x - b.x, ry = a.y - b.y
            var distance = Math.max(0.5, Math.sqrt(rx * rx + ry * ry))
            var repulsion = (k * k) / distance
            a.dx += (rx / distance) * repulsion; a.dy += (ry / distance) * repulsion
            b.dx -= (rx / distance) * repulsion; b.dy -= (ry / distance) * repulsion
          }
        }

        edges.forEach(function (edge) {
          var a = byId[edge.from], b = byId[edge.to]
          var ax = b.x - a.x, ay = b.y - a.y
          var distance = Math.max(0.5, Math.sqrt(ax * ax + ay * ay))
          var attraction = (distance * distance) / k
          a.dx += (ax / distance) * attraction; a.dy += (ay / distance) * attraction
          b.dx -= (ax / distance) * attraction; b.dy -= (ay / distance) * attraction
        })

        // A gentle pull to the middle, so a disconnected component drifts back
        // into view instead of pressing against the edge.
        nodes.forEach(function (node) {
          node.dx += (width / 2 - node.x) * 0.012
          node.dy += (height / 2 - node.y) * 0.012

          var length = Math.max(0.01, Math.sqrt(node.dx * node.dx + node.dy * node.dy))
          var step = Math.min(length, temperature)
          node.x = Math.max(28, Math.min(width - 28, node.x + (node.dx / length) * step))
          node.y = Math.max(20, Math.min(height - 20, node.y + (node.dy / length) * step))
        })

        temperature *= 0.975
      }

      // Fit to the canvas. Force layouts settle at whatever scale their
      // constants imply, which is never the size of the window; scaling the
      // finished result is simpler and more reliable than tuning the forces
      // until it happens to fit.
      var pad = 46
      var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
      nodes.forEach(function (node) {
        minX = Math.min(minX, node.x); maxX = Math.max(maxX, node.x)
        minY = Math.min(minY, node.y); maxY = Math.max(maxY, node.y)
      })

      var spanX = Math.max(1, maxX - minX)
      var spanY = Math.max(1, maxY - minY)
      // Labels run to the right of their node, so the right margin is wider.
      var scale = Math.min((width - pad * 3) / spanX, (height - pad * 2) / spanY, 2.5)

      nodes.forEach(function (node) {
        node.x = (node.x - (minX + maxX) / 2) * scale + width / 2 - pad * 0.5
        node.y = (node.y - (minY + maxY) / 2) * scale + height / 2
      })

      graphState = { nodes: nodes, edges: edges, byId: byId, hover: null }

      function paint() {
        var style = getComputedStyle(document.body)
        context.clearRect(0, 0, width, height)

        edges.forEach(function (edge) {
          var a = byId[edge.from], b = byId[edge.to]
          var touching = graphState.hover === a || graphState.hover === b
          context.strokeStyle = touching
            ? style.getPropertyValue('--accent')
            : style.getPropertyValue('--border')
          context.lineWidth = touching ? 1.5 : 1
          context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke()
        })

        nodes.forEach(function (node) {
          var radius = 4 + Math.min(9, node.degree * 1.6)
          var hovered = graphState.hover === node
          context.beginPath()
          context.arc(node.x, node.y, radius, 0, Math.PI * 2)
          context.fillStyle = hovered
            ? style.getPropertyValue('--accent')
            : style.getPropertyValue('--muted')
          context.fill()

          context.fillStyle = hovered
            ? style.getPropertyValue('--text')
            : style.getPropertyValue('--muted')
          context.font = (hovered ? '600 12px ' : '11px ') + 'system-ui, sans-serif'
          context.fillText(node.title.slice(0, 30), node.x + radius + 5, node.y + 4)
        })
      }

      paint()

      // Hit testing belongs to the event that needs it, not to whatever the
      // pointer happened to hover over last: a click has to work on its own,
      // including from a touch or a synthetic event that never moved first.
      function nodeAt(event) {
        var box = canvas.getBoundingClientRect()
        var x = (event.clientX - box.left) * (width / box.width)
        var y = (event.clientY - box.top) * (height / box.height)

        var closest = null
        var best = Infinity
        nodes.forEach(function (node) {
          var distance = Math.hypot(node.x - x, node.y - y)
          if (distance < 16 && distance < best) { best = distance; closest = node }
        })
        return closest
      }

      canvas.onmousemove = function (event) {
        var previous = graphState.hover
        graphState.hover = nodeAt(event)
        canvas.style.cursor = graphState.hover ? 'pointer' : 'default'
        if (previous !== graphState.hover) paint()
      }

      canvas.onclick = function (event) {
        var node = nodeAt(event)
        if (node) openNote(node.id)
      }
    })
  }

  // ---- wiring ------------------------------------------------------------

  function setTab(next) {
    tab = next
    document.getElementById('tab-search').setAttribute('aria-selected', String(next === 'search'))
    document.getElementById('tab-graph').setAttribute('aria-selected', String(next === 'graph'))
    document.getElementById('search-bar').style.display = next === 'search' ? 'flex' : 'none'

    var results = document.getElementById('results')
    results.style.padding = next === 'graph' ? '0' : '16px'
    if (next === 'graph') drawGraph()
    else { results.innerHTML = ''; results.appendChild(el('p', 'empty', 'Search to see results.')) }
  }

  document.getElementById('tab-search').onclick = function () { setTab('search') }
  document.getElementById('tab-graph').onclick = function () { setTab('graph') }
  document.getElementById('go').onclick = search
  document.getElementById('q').onkeydown = function (event) { if (event.key === 'Enter') search() }

  var balance = document.getElementById('balance')
  function showBalance() {
    var value = Number(balance.value) / 100
    document.getElementById('balance-label').textContent =
      (1 - value).toFixed(2) + ' / ' + value.toFixed(2)
  }
  balance.oninput = showBalance
  showBalance()

  refreshStatus()
  setInterval(refreshStatus, 5000)
})()
</script>
</body>
</html>`
}
