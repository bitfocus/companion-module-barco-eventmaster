// NotificationListener: Event Master subscription listener with batching, debounce,
// error reporting and re-subscription.
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
		this.onPull = null // ({ reason, snapshot, counts }) after debounce
		this.onSubscribed = null // (ok, detail) after each subscribe attempt
		this.onError = null // (err) listener/server errors, e.g. port already in use
		this.onListening = null // () once the local server is bound
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
				}
				this.schedulePull(type || 'unknown')
			} catch (err) {
				if (this.onError) this.onError(err)
			}
		})
		const server = this.em.notificationServer
		if (server) {
			server.on('error', (err) => {
				if (this.onError) this.onError(err)
			})
			server.on('listening', () => {
				if (this.onListening) this.onListening()
			})
		}
		this.subscribe()
	}

	subscribe() {
		this.em.subscribe(this.listenerHost, String(this.port), this.events, (err, res) => {
			if (!this.onSubscribed) return
			if (err) this.onSubscribed(false, err?.message || String(err))
			else if (res && res.success !== undefined && res.success !== 0) {
				// The frame says why in `response`, e.g. a type the model doesn't support
				const why = typeof res.response === 'string' && res.response ? `: ${res.response}` : ''
				this.onSubscribed(false, `frame returned success=${res.success}${why}`)
			} else this.onSubscribed(true, res)
		})
	}

	// Frame subscriptions are lost when the frame restarts: drop any old one and subscribe again.
	resubscribe() {
		this.em.unsubscribe(this.listenerHost, String(this.port), this.events, () => this.subscribe())
	}

	stop() {
		if (this.pullTimer) {
			clearTimeout(this.pullTimer)
			this.pullTimer = null
		}
		return new Promise((resolve) => {
			let done = false
			const finish = () => {
				if (done) return
				done = true
				try {
					this.em.stopNotificationServer()
				} catch {
					// ignore
				}
				resolve()
			}
			// Don't let an unreachable frame hold up shutdown
			setTimeout(finish, 2000)
			try {
				this.em.unsubscribe(this.listenerHost, String(this.port), this.events, finish)
			} catch {
				finish()
			}
		})
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
