// NotificationListener: Utility for EventMaster notification batching and debounce
const EventMaster = require('barco-eventmaster')

class NotificationListener {
  constructor(frameIp, listenerHost, port, events, debounceMs = 500) {
    this.em = new EventMaster(frameIp)
    this.listenerHost = listenerHost
    this.port = port
    this.events = events
    this.debounceMs = debounceMs
    this.pending = {}
    this.counters = {}
    this.pullTimer = null
    for (const evt of events) {
      this.pending[evt] = { add: new Set(), remove: new Set(), update: new Set() }
      this.counters[evt] = 0
    }
    this.onPull = null // Set by user
  }

  start() {
    this.em.startNotificationServer(this.port, (notification) => {
      try {
        const n = notification?.result || notification
        const type = n?.notificationType || n?.type
        const change = n?.change
        if (type && change && this.pending[type]) {
          for (const id of change.add || []) this.pending[type].add.add(id)
          for (const id of change.remove || []) this.pending[type].remove.add(id)
          for (const id of change.update || []) this.pending[type].update.add(id)
          this.counters[type]++
          this.schedulePull(type)
        } else {
          this.schedulePull(type || 'unknown')
        }
      } catch (e) {
        // Optionally log error
      }
    })
    this.em.subscribe(this.listenerHost, this.port, this.events, () => {})
  }

  schedulePull(reason) {
    if (this.pullTimer) clearTimeout(this.pullTimer)
    this.pullTimer = setTimeout(() => {
      this.pullTimer = null
      const snapshot = {}
      for (const evt of this.events) {
        snapshot[evt] = {
          add: Array.from(this.pending[evt].add),
          remove: Array.from(this.pending[evt].remove),
          update: Array.from(this.pending[evt].update),
        }
        this.pending[evt].add.clear()
        this.pending[evt].remove.clear()
        this.pending[evt].update.clear()
      }
      const counts = { ...this.counters }
      for (const k of Object.keys(this.counters)) this.counters[k] = 0
      if (this.onPull) this.onPull({ reason, snapshot, counts })
    }, this.debounceMs)
  }
}

module.exports = NotificationListener
