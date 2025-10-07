#!/usr/bin/env node
const EventMaster = require('barco-eventmaster')
const os = require('os')

const DEFAULT_PORT = parseInt(process.env.LISTENER_PORT || '3000', 10)
const FRAME_IP = process.env.FRAME_IP || '172.16.110.22'
const PULL_DEBOUNCE_MS = parseInt(process.env.PULL_DEBOUNCE_MS || '500', 10)
const RAW_LOG = /^(1|true|yes)$/i.test(process.env.RAW_LOG || '')

function getLocalIPv4s() {
  const out = []
  const ifaces = os.networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push({ name, address: iface.address })
    }
  }
  return out
}

function pickListenerHost() {
  if (process.env.LISTENER_HOST) return process.env.LISTENER_HOST
  const ips = getLocalIPv4s()
  return ips.length ? ips[0].address : '127.0.0.1'
}

async function main() {
  const listenerHost = pickListenerHost()
  const port = DEFAULT_PORT

  console.log('Local IPv4 interfaces:', getLocalIPv4s().map(x => `${x.name}:${x.address}`).join(', '))
  console.log(`Frame IP=${FRAME_IP}, listener=${listenerHost}:${port}`)

  const em = new EventMaster(FRAME_IP)

  // Accumulate changes and debounce pull
  const pending = {
    ScreenDestChanged: { add: new Set(), remove: new Set(), update: new Set() },
    AUXDestChanged: { add: new Set(), remove: new Set(), update: new Set() },
    DestUpdated: { add: new Set(), remove: new Set(), update: new Set() },
    DestChanged: { add: new Set(), remove: new Set(), update: new Set() },
  }
  let pullTimer = null
  const counters = { ScreenDestChanged: 0, AUXDestChanged: 0, DestUpdated: 0, DestChanged: 0 }

  function schedulePull(reason) {
    if (pullTimer) clearTimeout(pullTimer)
    pullTimer = setTimeout(() => {
      pullTimer = null
      // Snapshot and clear pending
      const snapshot = {}
      for (const evt of Object.keys(pending)) {
        snapshot[evt] = {
          add: Array.from(pending[evt].add),
          remove: Array.from(pending[evt].remove),
          update: Array.from(pending[evt].update),
        }
        pending[evt].add.clear()
        pending[evt].remove.clear()
        pending[evt].update.clear()
      }
      console.log(`Pull triggered (${reason}) after ${PULL_DEBOUNCE_MS}ms. Summary counts:`, JSON.stringify(counters))
      console.log('Accumulated changes:', JSON.stringify(snapshot))
      // Reset counters after a pull
      for (const k of Object.keys(counters)) counters[k] = 0
      // TODO: Make actual pull calls to EM here (commented to avoid flood until confirmed)
      // Example: em.getDestinations(...) then pretty print relevant entries
    }, PULL_DEBOUNCE_MS)
  }

  em.startNotificationServer(port, (notification) => {
    try {
      const n = notification?.result || notification
      if (RAW_LOG) {
        console.log('Notification raw:', JSON.stringify(n))
      }
      const type = n?.notificationType || n?.type
      const change = n?.change
      if (type && change) {
        const acc = pending[type]
        if (acc) {
          for (const id of change.add || []) acc.add.add(id)
          for (const id of change.remove || []) acc.remove.add(id)
          for (const id of change.update || []) acc.update.add(id)
          if (counters[type] !== undefined) counters[type] += 1
          schedulePull(type)
        } else {
          // Unknown type; still schedule a pull to be safe
          schedulePull(type || 'unknown')
        }
      } else {
        // No structured change; still schedule once
        schedulePull('unstructured')
      }
    } catch (e) {
      console.error('Notification handler error:', e)
    }
  })
  console.log(`Notification server listening on ${listenerHost}:${port}`)

  // Subscribe to common events; adjust as needed
  const events = ['ScreenDestChanged', 'AUXDestChanged', 'DestUpdated', 'DestChanged']

  em.subscribe(listenerHost, port, events, (err, result) => {
    if (err) {
      console.error('Subscribe error:', err)
    } else {
      console.log('Subscribe OK:', JSON.stringify(result))
    }
  })

  console.log('Waiting for events... Press Ctrl+C to exit')
  // Safely write heartbeat; avoid EPIPE if stdout is closed (e.g., piped to head)
  const keepAlive = setInterval(() => {
    try {
      if (process.stdout.isTTY) process.stdout.write('.')
    } catch (e) {
      if (e && e.code === 'EPIPE') {
        // stdout closed; exit cleanly
        process.exit(0)
      }
    }
  }, 5000)
  // Globally handle EPIPE on stdout
  if (process.stdout && typeof process.stdout.on === 'function') {
    process.stdout.on('error', (e) => {
      if (e && e.code === 'EPIPE') process.exit(0)
    })
  }
  process.on('SIGINT', () => {
    clearInterval(keepAlive)
    console.log('\nExiting...')
    process.exit(0)
  })
}

main().catch((e) => {
  console.error('Fatal error:', e)
  process.exit(1)
})
