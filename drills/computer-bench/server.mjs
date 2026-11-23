#!/usr/bin/env node
// The bench fixture's server: every path serves fixture.html; the page's events go to /log and
// read back from /events, the ground truth a run is scored on.
//   node drills/computer-bench/server.mjs [port]   (default 8765)

import fs from 'node:fs'
import http from 'node:http'
import { pathToFileURL } from 'node:url'

const page = fs.readFileSync(new URL('./fixture.html', import.meta.url))
let events = []

export function serve(port = 8765) {
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/log') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        try { events.push(JSON.parse(body)) } catch {}
        res.end()
      })
      return
    }
    if (req.url === '/events') return res.end(JSON.stringify(events))
    if (req.url === '/reset') { events = []; return res.end('[]') }
    if (req.url === '/favicon.ico') { res.statusCode = 404; return res.end() }
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(page)
  })
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)))
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8765)
  await serve(port)
  console.log(`bench fixture on http://localhost:${port}/`)
}
