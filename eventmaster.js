const EventMaster = require('barco-eventmaster')
const NotificationListener = require('./tools/notification-listener')
const os = require('os')
const { InstanceBase, InstanceStatus, Regex, runEntrypoint } = require('@companion-module/base')
const ping = require('ping')
const getPresets = require('./presets')
const _ = require('lodash')

// Event Master notifications (E2 9.2.6318 and 9.2.6373, PDS-4K 9.2.5963) cover live state as well
// as structure: InputCfgChanged on source freeze, ScreenDestChanged on screen freeze, layer freeze,
// takes (one per transition frame) and arm, AUXDestChanged on aux changes, OutputCfgChanged (with
// output ids, not destination ids) on test patterns. They carry ids only, so each debounced batch
// triggers a targeted read of just what changed.
const NOTIFY_EVENTS = [
	'ScreenDestChanged',
	'AUXDestChanged',
	'InputCfgChanged',
	'OutputCfgChanged',
	'SourceChanged',
	'PresetChanged',
	'CueChanged',
	'StillChanged',
	'FrameChanged',
	'BGSourceChanged',
]
// No NativeRateChanged: the PDS-4K rejects the whole subscribe if it is listed ("not applicable for
// PDS"), and the slow full refresh picks up a native rate change anyway.
// Types that mean names, lists or frame settings changed: refresh everything, not just live state
const STRUCTURAL_EVENTS = [
	'SourceChanged',
	'PresetChanged',
	'CueChanged',
	'StillChanged',
	'FrameChanged',
	'BGSourceChanged',
]
const RESUBSCRIBE_MS = 10 * 60 * 1000
// While live updates are working, the full poll is replaced by a one-call heartbeat (to notice the
// frame going away and coming back, e.g. a reboot, which drops subscriptions) and a slow full refresh
// as a backstop for anything the frame doesn't notify (user keys, for one).
const HEARTBEAT_MS = 15 * 1000
const BACKSTOP_MS = 5 * 60 * 1000
const MISSED_HEARTBEATS_FOR_DOWN = 2

class BarcoInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
	}

	async init(config) {
		this.config = config
		this.eventmasterData = {
			presets: { 0: { id: 0, Name: 'no presets loaded yet' } },
			sources: { 0: { id: 0, Name: 'no sources loaded yet', SrcType: 0 } },
			cues: { 0: { id: 0, Name: 'no cues loaded yet' } },
			userKeys: { 0: { id: 0, Name: 'no user keys loaded yet' } },
			SuperAuxDestinations: { 0: { id: 0, Name: 'no auxes loaded yet' } },
			AuxDestinations: { 0: { id: 0, Name: 'no auxes loaded yet' } },
			ScreenDestinations: { 0: { id: 0, Name: 'no destinations loaded yet' } },
			SuperDestinations: { 0: { id: 0, Name: 'no destinations loaded yet' } },
		}
		// Track dynamic variables
		this.detectedCardSlots = []
		this.frameVariableDefinitions = []
		// Initialize variable change tracking to prevent unnecessary Stream Deck flashing
		this.previousVariableValues = {}
		this.lastVariableDefinitionsHash = null
		this.CHOICES_FREEZE = [
			{ label: 'Freeze', id: 1 },
			{ label: 'Unfreeze', id: 0 },
		]
		this.CHOICES_TESTPATTERN = [
			{ label: 'Off', id: '0' },
			{ label: 'Horizontal Ramp', id: '1' },
			{ label: 'Vertical Ramp', id: '2' },
			{ label: '100% Color Bars', id: '3' },
			{ label: '16x16 grid', id: '4' },
			{ label: '32x32 grid', id: '5' },
			{ label: 'Burst', id: '6' },
			{ label: '75% Color Bars', id: '7' },
			{ label: '50% Gray', id: '8' },
			{ label: 'Horizontal steps', id: '9' },
			{ label: 'Vertical steps', id: '10' },
			{ label: 'White', id: '11' },
			{ label: 'Black', id: '12' },
			{ label: 'SMPTE Bars', id: '13' },
			{ label: 'H Alignment', id: '14' },
			{ label: 'V Alignment', id: '15' },
			{ label: 'HV Alignment', id: '16' },
			{ label: 'Circle Alignment', id: '17' },
			{ label: 'Red', id: '18' },
			{ label: 'Green', id: '19' },
			{ label: 'Blue', id: '20' },
		]
		// Notification/subscription state
		this.notificationActive = false
		this.notificationPort = this.config && this.config.notification_port ? this.config.notification_port : 3000
		this.notificationHost = this.config && this.config.notification_host ? this.config.notification_host : undefined
		this._notifyTimer = null
		this._notifyNoEventTimer = null
		this._lastNotificationAt = 0
		this.setVariableDefinitions([
			{ variableId: 'frame_IP', name: 'Frame IP Address' },
			{ variableId: 'frame_MAC', name: 'Frame MAC Address' },
			{ variableId: 'frame_version', name: 'Frame Version' },
			{ variableId: 'frame_OSVersion', name: 'Frame OS Version' },
			{ variableId: 'power_status1', name: 'Power Supply 1 Status' },
			{ variableId: 'power_status2', name: 'Power Supply 2 Status' },
		])
		this.powerStatus = [
			'Power supply module is not present.',
			'Power supply module is present, but there is no AC current detected.',
			'Power supply module is present, and the AC current is detected, but there is no DC current.',
			'Power supply module is present, and everything is OK.',
		]
		this.updateStatus(InstanceStatus.UnknownWarning)

		// Register actions, feedbacks and presets immediately using the placeholder
		// data above, so the user can build and configure buttons even while the
		// device is offline/unreachable. These are refreshed with real values once
		// a connection is established (see initEventmaster / eventmasterPoller).
		this.refreshDefinitions()

		this.connection()
		this.log(`debug`, 'creating eventmaster')
	}

	async configUpdated(config) {
		this.log('debug', 'Config updated, reconnecting')
		// Stop existing timers and notifications before reconnecting with new settings.
		if (this.polling_interval) {
			clearInterval(this.polling_interval)
			this.polling_interval = undefined
		}
		if (this.retry_interval) {
			clearInterval(this.retry_interval)
			this.retry_interval = undefined
		}
		try {
			await this.teardownNotifications()
		} catch {
			// best-effort
		}
		this.config = config
		// Refresh cached notification settings from the new config.
		this.notificationPort = this.config?.notification_port || 3000
		this.notificationHost = this.config?.notification_host || undefined
		this.connection()
	}

	connection() {
		// Guard: a host is required before we can ping or connect.
		if (!this.config || !this.config.host) {
			this.log('error', 'Cannot connect: no target IP configured')
			this.updateStatus(InstanceStatus.BadConfig, 'No target IP configured')
			return
		}

		// Clear any existing retry timer so we never stack up multiple pollers
		// (e.g. when configUpdated() is called repeatedly).
		if (this.retry_interval) {
			clearInterval(this.retry_interval)
			this.retry_interval = undefined
		}

		this.pingAndConnect()
	}

	// Ping the frame; connect on success, otherwise schedule retries.
	// All async paths are guarded so a rejected probe can never crash the module.
	pingAndConnect() {
		// If a previous attempt found the local ping program unusable (common on
		// locked-down Linux hosts, containers, or HA appliances with a restricted
		// PATH/permissions), skip the ICMP pre-check entirely and connect directly.
		// The EventMaster JSON API call is the real reachability test anyway.
		if (this.pingUnavailable) {
			this.initEventmaster()
			return
		}

		ping.promise
			.probe(this.config.host)
			.then((res) => {
				if (res.alive) {
					this.log('debug', `ping ok (${this.config.host})`)
					this.clearRetry()
					this.initEventmaster()
				} else {
					this.log('debug', `ping failed (${this.config.host})`)
					this.updateStatus(InstanceStatus.Connecting, 'No ping response')
					this.scheduleRetry()
				}
			})
			.catch((err) => {
				// A rejection here means the local ping program could not be executed
				// Falling back to a direct connection
				this.pingUnavailable = true
				this.log(
					'warn',
					`Unable to run local ping program (${err?.message || err}). ` +
						`Skipping ICMP pre-check and connecting to ${this.config.host} directly.`,
				)
				this.clearRetry()
				this.initEventmaster()
			})
	}

	clearRetry() {
		if (this.retry_interval) {
			clearInterval(this.retry_interval)
			this.retry_interval = undefined
		}
	}

	scheduleRetry() {
		if (this.retry_interval) return // a retry loop is already running
		this.retry_interval = setInterval(() => {
			this.pingAndConnect()
		}, 5000)
	}

	initEventmaster() {
		this.log('info', `Connecting to EventMaster at ${this.config.host}`)
		try {
			this.eventmaster = new EventMaster(this.config.host)
		} catch (err) {
			this.log('error', `Failed to create EventMaster client: ${err?.message || err}`)
			this.updateStatus(InstanceStatus.ConnectionFailure, 'Failed to create client')
			this.scheduleRetry()
			return
		}

		// Setup optional live notifications
		if (this.config.enable_notifications) {
			this.setupNotifications().catch((e) => this.log('error', `Notifications setup failed: ${e}`))
		}
		this.updateStatus(InstanceStatus.Ok)
		this.getAllDataFromEventmaster()
			.then(() => {
				this.refreshDefinitions()
				this.eventmasterPoller()
			})
			.catch((err) => {
				// A rejection here would otherwise become an unhandled rejection and crash the module.
				this.log('error', `Initial data fetch failed: ${err?.message || err}`)
				this.updateStatus(InstanceStatus.ConnectionFailure, 'Initial data fetch failed')
				// Still attempt to register definitions and start polling so the module recovers.
				this.refreshDefinitions()
				this.eventmasterPoller()
			})
		if (this.retry_interval) {
			clearInterval(this.retry_interval)
			this.retry_interval = undefined
		}
	}

	// Rebuild action/feedback/preset definitions from the current data set.
	// Each builder is guarded individually so malformed data in one section
	// cannot take down the whole module.
	refreshDefinitions() {
		try {
			this.setActionDefinitions(this.getActions())
		} catch (err) {
			this.log('error', `Failed to build actions: ${err?.message || err}`)
		}
		try {
			this.setFeedbackDefinitions(this.getFeedbacks())
		} catch (err) {
			this.log('error', `Failed to build feedbacks: ${err?.message || err}`)
		}
		try {
			this.setPresetDefinitions(getPresets(this.eventmasterData))
		} catch (err) {
			this.log('error', `Failed to build presets: ${err?.message || err}`)
		}
	}

	async setupNotifications() {
		if (!this.eventmaster) return
		if (this.notificationActive) return
		const port = this.notificationPort || 3000
		const listenerHost = this.getNotificationHost()
		this.log('info', `Live updates: listening on ${listenerHost}:${port}, subscribing frame ${this.config.host}`)
		const typed = String(this.notificationHost || this.config?.notification_host || '').trim()
		this.setStatusVariables({ live_updates_listener: `${listenerHost}:${port} (${typed ? 'set' : 'auto'})` })
		this.setStatusVariables({ live_updates_status: 'Starting' })

		this._listenerError = null
		const listener = new NotificationListener(this.config.host, listenerHost, port, NOTIFY_EVENTS, 500)
		listener.onError = (err) => {
			const msg =
				err?.code === 'EADDRINUSE'
					? `port ${port} is already in use on this machine - choose another notification port`
					: err?.message || String(err)
			this._listenerError = msg
			this.log('error', `Live updates listener error: ${msg}`)
			this.setStatusVariables({ live_updates_status: `Error: ${msg}` })
			this.stopLivePolling(true) // notifications can't arrive: back to the full poll
		}
		listener.onSubscribed = (ok, detail) => {
			// A listener failure (e.g. port in use) means notifications can't arrive, whatever the frame says
			if (this._listenerError) {
				this.setStatusVariables({ live_updates_status: `Error: ${this._listenerError}` })
				return
			}
			if (ok) {
				this.log('info', `Live updates: subscribed (${listenerHost}:${port})`)
				this.setStatusVariables({ live_updates_status: 'Subscribed' })
				this.startLivePolling()
			} else {
				this.log('error', `Live updates: subscribe failed: ${detail}`)
				this.setStatusVariables({ live_updates_status: `Subscribe failed: ${detail}` })
				this.stopLivePolling(true)
			}
		}
		listener.onPull = async ({ counts, snapshot }) => {
			const types = Object.entries(counts || {})
				.filter(([, n]) => n > 0)
				.map(([t, n]) => `${t} x${n}`)
				.join(', ')
			this._lastNotificationAt = Date.now()
			this.log('debug', `Live update received: ${types || 'unknown'}`)
			this.setStatusVariables({
				live_updates_last: `${new Date().toLocaleTimeString()} ${types || 'notification'}`,
			})
			await this.applyLiveUpdate(this.planLiveUpdate(counts, snapshot))
		}
		this._notificationListener = listener
		listener.start()
		this.notificationActive = true

		// Subscriptions are lost when the frame restarts; renew them periodically as a backstop
		if (this._resubscribeTimer) clearInterval(this._resubscribeTimer)
		this._resubscribeTimer = setInterval(() => this.resubscribeNotifications('periodic'), RESUBSCRIBE_MS)
	}

	resubscribeNotifications(reason) {
		if (!this.notificationActive || !this._notificationListener) return
		this.log('debug', `Live updates: re-subscribing (${reason})`)
		this._notificationListener.resubscribe()
	}

	/**
	 * Live updates are working: replace the full poll with a one-call heartbeat and a slow full
	 * refresh. A polling interval of 0 means no polling at all, so neither runs then.
	 */
	startLivePolling() {
		if (this._liveMode) return
		this._liveMode = true
		if (this.polling_interval) {
			clearInterval(this.polling_interval)
			this.polling_interval = undefined
		}
		if (this.config?.pollingInterval === 0) {
			this.log('debug', 'Live updates on, polling disabled: no heartbeat or backstop refresh')
			return
		}
		const heartbeatMs = this._heartbeatMs || HEARTBEAT_MS
		const backstopMs = this._backstopMs || BACKSTOP_MS
		this._missedHeartbeats = 0
		this._frameDown = false
		this._heartbeatTimer = setInterval(() => this.heartbeatTick(), heartbeatMs)
		this._backstopTimer = setInterval(() => this.refreshStructure('backstop refresh'), backstopMs)
		this.log(
			'info',
			`Live updates working: full poll replaced by a ${heartbeatMs / 1000} s heartbeat and a full refresh every ${backstopMs / 60000} min`,
		)
	}

	// Live updates stopped or failed. restoreFullPoll: go back to the normal full poll
	stopLivePolling(restoreFullPoll) {
		if (this._heartbeatTimer) clearInterval(this._heartbeatTimer)
		if (this._backstopTimer) clearInterval(this._backstopTimer)
		this._heartbeatTimer = undefined
		this._backstopTimer = undefined
		const wasLive = this._liveMode
		this._liveMode = false
		if (restoreFullPoll && wasLive && this.eventmaster) {
			this.log('info', 'Live updates not working: back to the full poll')
			this.eventmasterPoller()
		}
	}

	/**
	 * One small read (power status, which also keeps the PSU variables current). Two misses in a row
	 * mean the frame is down; the first answer after that means it's back, possibly rebooted and so
	 * without our subscription: re-subscribe and refresh everything at once.
	 */
	async heartbeatTick() {
		if (!this.eventmaster || this._heartbeatInFlight) return
		this._heartbeatInFlight = true
		try {
			const res = await new Promise((resolve, reject) => {
				this.eventmaster.powerStatus((err, result) => (err ? reject(err) : resolve(result)))
			})
			if (this._frameDown) {
				this._frameDown = false
				this.log('info', 'Frame responding again: re-subscribing live updates and refreshing')
				this.updateStatus(InstanceStatus.Ok)
				this.resubscribeNotifications('frame back online')
				await this.refreshStructure('frame back online')
			}
			this._missedHeartbeats = 0
			this.applyPowerStatus(res)
		} catch (err) {
			this._missedHeartbeats = (this._missedHeartbeats || 0) + 1
			if (this._missedHeartbeats === MISSED_HEARTBEATS_FOR_DOWN) {
				this._frameDown = true
				this.log('warn', `Frame not responding (${err?.message || err}): will re-subscribe when it returns`)
				this.updateStatus(InstanceStatus.ConnectionFailure, 'Frame not responding')
			}
		} finally {
			this._heartbeatInFlight = false
		}
	}

	/**
	 * Turn a debounced batch of notifications into the reads it needs. Additions, removals or a
	 * structural type mean a full refresh; otherwise only what changed is re-read.
	 */
	planLiveUpdate(counts, snapshot) {
		const ids = (type) => {
			const c = snapshot?.[type]
			return [...new Set([...(c?.update || []), ...(c?.add || []), ...(c?.remove || [])])]
		}
		const hit = (type) => (counts?.[type] || 0) > 0
		const addOrRemove = Object.values(snapshot || {}).some((c) => c?.add?.length || c?.remove?.length)
		const owners = this.outputOwners(ids('OutputCfgChanged'))
		return {
			full: addOrRemove || STRUCTURAL_EVENTS.some(hit),
			sources: hit('InputCfgChanged'),
			destinations: hit('ScreenDestChanged') || hit('AUXDestChanged'),
			screens: [...new Set([...ids('ScreenDestChanged'), ...owners.screens])],
			auxes: [...new Set([...ids('AUXDestChanged'), ...owners.auxes])],
		}
	}

	/**
	 * OutputCfgChanged carries output ids. Find the screens and auxes that own those outputs from
	 * the cached content; an output we can't place means re-reading every destination's content.
	 */
	outputOwners(outputIds) {
		const result = { screens: [], auxes: [] }
		if (!outputIds.length) return result
		const outIds = (content) => [].concat(content?.OutputCfg ?? []).map((o) => o?.id)
		const unplaced = new Set(outputIds)
		for (const [kind, cache] of [
			['screens', this._screenContent],
			['auxes', this._auxContent],
		]) {
			for (const [id, content] of Object.entries(cache || {})) {
				const owned = outIds(content).filter((o) => unplaced.has(o))
				if (owned.length) result[kind].push(Number(id))
				for (const o of owned) unplaced.delete(o)
			}
		}
		if (unplaced.size) {
			result.screens = Object.values(this.eventmasterData?.ScreenDestinations || {}).map((d) => d.id)
			result.auxes = Object.values(this.eventmasterData?.AuxDestinations || {}).map((d) => d.id)
		}
		return result
	}

	/**
	 * Apply a live update plan. Serialised: plans arriving while one runs are merged and run next,
	 * so nothing is dropped and a burst costs at most one extra pass.
	 */
	async applyLiveUpdate(plan) {
		if (this._livePlanRunning) {
			const q = this._livePlanQueued
			this._livePlanQueued = q
				? {
						full: q.full || plan.full,
						sources: q.sources || plan.sources,
						destinations: q.destinations || plan.destinations,
						screens: [...new Set([...q.screens, ...plan.screens])],
						auxes: [...new Set([...q.auxes, ...plan.auxes])],
					}
				: plan
			return
		}
		this._livePlanRunning = true
		try {
			if (plan.full) {
				await this.refreshStructure('live update')
				return
			}
			const before = this.structureNames()
			if (plan.sources) await this.getSourcesFromEventmaster()
			if (plan.destinations) await this.getDestinationsFromEventmaster()
			// A rename comes as an update to an existing id; names feed variable definitions,
			// dropdowns and presets, so treat it as structural
			if (this.structureNames() !== before) {
				await this.refreshStructure('rename')
				return
			}
			await this.autoPopulateSourceMonitoring({ screens: plan.screens, auxes: plan.auxes })
		} catch (e) {
			this.log('error', `Live update failed: ${e?.message || e}`)
		} finally {
			this._livePlanRunning = false
			const next = this._livePlanQueued
			this._livePlanQueued = null
			if (next) await this.applyLiveUpdate(next)
		}
	}

	structureNames() {
		const names = (o) => Object.values(o || {}).map((x) => `${x.id}:${x.Name}`)
		const d = this.eventmasterData || {}
		return JSON.stringify([names(d.sources), names(d.ScreenDestinations), names(d.AuxDestinations)])
	}

	async refreshStructure(reason) {
		if (this._structureRefreshInFlight) return
		this._structureRefreshInFlight = true
		try {
			this._lastUpdateSource = reason
			await this.getAllDataFromEventmaster()
			this.refreshDefinitions()
		} catch (e) {
			this.log('error', `Refresh (${reason}) failed: ${e?.message || e}`)
		} finally {
			this._structureRefreshInFlight = false
		}
	}

	setStatusVariables(values) {
		this._statusVariables = { ...(this._statusVariables || {}), ...values }
		this.setVariableValues(values)
	}

	getLocalIPv4s() {
		const out = []
		try {
			const ifaces = os.networkInterfaces()
			for (const name of Object.keys(ifaces)) {
				for (const iface of ifaces[name] || []) {
					if (iface.family === 'IPv4' && !iface.internal) out.push(`${name}:${iface.address}`)
				}
			}
		} catch {
			// ignore
		}
		return out
	}

	async teardownNotifications() {
		this.stopLivePolling(false)
		if (this._resubscribeTimer) {
			clearInterval(this._resubscribeTimer)
			this._resubscribeTimer = null
		}
		if (!this.notificationActive) return
		this.notificationActive = false
		const listener = this._notificationListener
		this._notificationListener = null
		try {
			if (listener) await listener.stop()
		} catch {
			// ignore teardown errors
		}
		this.setStatusVariables({ live_updates_status: 'Off' })
	}

	/**
	 * Local IP the frame should send notifications to: the configured one, else the interface on
	 * the same /24 as the frame, else the first non-internal IPv4.
	 */
	getNotificationHost() {
		const typed = String(this.notificationHost || this.config?.notification_host || '').trim()
		if (typed) return typed
		const found = this.detectListenerIp()
		if (found.reason === 'fallback')
			this.log(
				'warn',
				`Live updates: no local interface on the frame's network; using ${found.address} (${found.iface}). Set the notification server host in the config if notifications don't arrive.`,
			)
		return found.address
	}

	// One line for the config form: what auto-detect picks for the saved frame address, and why
	describeDetectedListener() {
		if (!this.config?.host) return 'Set the target IP first'
		const d = this.detectListenerIp()
		if (d.reason === 'subnet') return `${d.address} (${d.iface})`
		if (d.reason === 'fallback')
			return `No interface on target's network. Best guess ${d.address} (${d.iface}): enter the right address.`
		return 'No network interface found'
	}

	/**
	 * Which of this machine's addresses the frame should send notifications to: the interface on the
	 * frame's network (by its real netmask; /24 assumed if the system doesn't report one), wired
	 * before Wi-Fi when several match, else the first interface as a guess.
	 * @returns {{address: string, iface: string, reason: 'subnet'|'fallback'|'none'}}
	 */
	detectListenerIp() {
		const toInt = (ip) => {
			const p = String(ip || '')
				.split('.')
				.map(Number)
			return p.length === 4 && p.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)
				? ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0
				: null
		}
		const candidates = []
		try {
			const ifaces = os.networkInterfaces()
			for (const name of Object.keys(ifaces)) {
				for (const iface of ifaces[name] || []) {
					if (iface.family === 'IPv4' && !iface.internal) candidates.push({ name, ...iface })
				}
			}
		} catch {
			// ignore
		}
		const frame = toInt(this.config?.host)
		const onFrameNet = candidates.filter((c) => {
			const ip = toInt(c.address)
			const mask = toInt(c.netmask) ?? toInt('255.255.255.0')
			return frame !== null && ip !== null && mask !== 0 && (ip & mask) >>> 0 === (frame & mask) >>> 0
		})
		// Wired first, then Wi-Fi, then VPN/virtual adapters and point-to-point (/32) links, which are
		// almost never the way a frame reaches this machine
		const rank = (c) =>
			/tailscale|zerotier|wireguard|vpn|vethernet|hyper-v|wsl|vmware|virtualbox|docker|npcap|loopback/i.test(c.name) ||
			c.netmask === '255.255.255.255'
				? 2
				: /wi-?fi|wlan|wireless/i.test(c.name)
					? 1
					: 0
		const best = (list) => [...list].sort((a, b) => rank(a) - rank(b))[0]
		const pick = best(onFrameNet)
		if (pick) return { address: pick.address, iface: pick.name, reason: 'subnet' }
		const guess = best(candidates)
		if (guess) return { address: guess.address, iface: guess.name, reason: 'fallback' }
		return { address: '127.0.0.1', iface: 'loopback', reason: 'none' }
	}

	async getFrameSettings() {
		if (this.eventmaster) {
			try {
				const res = await new Promise((resolve, reject) => {
					this.eventmaster.getFrameSettings({}, (err, result) => {
						if (err) reject(err)
						else resolve(result)
					})
				})

				// Log the response structure to understand the format
				// console.log('Frame Settings Response:', JSON.stringify(res, null, 2))

				// Parse the correct structure based on the actual response
				let frameData = null
				if (
					res.response &&
					res.response.System &&
					res.response.System.FrameCollection &&
					res.response.System.FrameCollection.Frame
				) {
					// Frame is a single object, not an array
					frameData = res.response.System.FrameCollection.Frame
				}

				if (frameData) {
					// Extract the basic frame data
					const frameIP = frameData.Enet?.IP || this.config.host || 'Unknown'
					const frameMAC = frameData.Enet?.MacAddress || 'Unknown'
					const version = frameData.Version || 'Unknown'
					const osVersion = frameData.OSVersion || 'Unknown'

					this.eventmasterData.frameIP = frameIP
					this.eventmasterData.frameMAC = frameMAC
					this.eventmasterData.version = version
					this.eventmasterData.OSVersion = osVersion

					// Start with basic variables
					const variableValues = {
						frame_IP: frameIP,
						frame_MAC: frameMAC,
						frame_version: version,
						frame_OSVersion: osVersion,
					}

					// Build dynamic variable definitions including card slots
					const variableDefinitions = [
						{ variableId: 'frame_IP', name: 'Frame IP Address' },
						{ variableId: 'frame_MAC', name: 'Frame MAC Address' },
						{ variableId: 'frame_version', name: 'Frame Version' },
						{ variableId: 'frame_OSVersion', name: 'Frame OS Version' },
						{ variableId: 'power_status1', name: 'Power Supply 1 Status' },
						{ variableId: 'power_status2', name: 'Power Supply 2 Status' },
					]

					// Process card slots if they exist
					if (frameData.Slot && Array.isArray(frameData.Slot)) {
						this.detectedCardSlots = [] // Reset detected cards
						frameData.Slot.forEach((slot, index) => {
							if (slot.Card) {
								const slotNum = index + 1
								const card = slot.Card

								// Store detected card info
								this.detectedCardSlots.push(slotNum)

								// Add variable definition for this card (single combined variable)
								variableDefinitions.push({ variableId: `card${slotNum}_info`, name: `Card ${slotNum} Information` })

								// Build health status
								let healthStatus = 'OK'
								if (card.OverTemp === 1 && card.FanWarn === 1) {
									healthStatus = 'Over Temp + Fan Warning'
								} else if (card.OverTemp === 1) {
									healthStatus = 'Over Temperature'
								} else if (card.FanWarn === 1) {
									healthStatus = 'Fan Warning'
								}

								// Combine all card info into a single string
								const cardInfo = `${card.CardTypeLabel || 'Unknown'} - Status: ${card.CardStatusLabel || 'Unknown'} - Temp/Fan: ${healthStatus}`
								variableValues[`card${slotNum}_info`] = cardInfo
							}
						})
					}

					// Add SysCard (motherboard) information if available
					if (frameData.SysCard) {
						variableDefinitions.push({ variableId: 'syscard_info', name: 'System Card Information' })

						let sysHealthStatus = 'OK'
						if (frameData.SysCard.OverTemp === 1 && frameData.SysCard.FanWarn === 1) {
							sysHealthStatus = 'Over Temp + Fan Warning'
						} else if (frameData.SysCard.OverTemp === 1) {
							sysHealthStatus = 'Over Temperature'
						} else if (frameData.SysCard.FanWarn === 1) {
							sysHealthStatus = 'Fan Warning'
						}

						const sysCardInfo = `${frameData.SysCard.CardTypeLabel || 'Unknown'} - Status: ${frameData.SysCard.CardStatusLabel || 'Unknown'} - Temp/Fan: ${sysHealthStatus}`
						variableValues.syscard_info = sysCardInfo
					}

					// Store frame variable definitions for use by updateDestinationVariables
					this.frameVariableDefinitions = variableDefinitions

					// Delegate variable definition updates to the centralized updater
					// This avoids redefining on every poll and ensures values are repopulated correctly
					this.updateDestinationVariables()

					// Set all variable values with change tracking
					const changedFrameVariables = {}
					Object.entries(variableValues).forEach(([key, value]) => {
						if (this.previousVariableValues[key] !== value) {
							changedFrameVariables[key] = value
							this.previousVariableValues[key] = value
						}
					})

					if (Object.keys(changedFrameVariables).length > 0) {
						this.setVariableValues(changedFrameVariables)
					}

					// this.log('debug', `Frame Settings Updated: IP=${frameIP}, Version=${version}, OS=${osVersion}`)
					// if (frameData.Slot) {
					//	this.log('debug', `Found ${frameData.Slot.length} card slots`)
					// }
				} else {
					this.log('warn', 'Frame settings data structure not recognized')
				}
			} catch (err) {
				this.log('error', 'EventMaster Frame Settings Error: ' + err)
				// Set fallback values with change tracking
				const fallbackVariables = {
					frame_IP: this.config.host || 'Unknown',
					frame_version: 'Error fetching',
					frame_OSVersion: 'Error fetching',
				}

				const changedFallbackVariables = {}
				Object.entries(fallbackVariables).forEach(([key, value]) => {
					if (this.previousVariableValues[key] !== value) {
						changedFallbackVariables[key] = value
						this.previousVariableValues[key] = value
					}
				})

				if (Object.keys(changedFallbackVariables).length > 0) {
					this.setVariableValues(changedFallbackVariables)
				}
			}
		}
	}
	// Polling function to keep data updated
	eventmasterPoller() {
		if (!this.config) return
		// Live updates working: the heartbeat and backstop refresh replace this poll
		if (this._liveMode) return

		// Always clear any existing poller before (re)starting to avoid stacking timers.
		if (this.polling_interval) {
			clearInterval(this.polling_interval)
			this.polling_interval = undefined
		}

		if (this.config.pollingInterval === 0) {
			this.log('debug', 'Polling disabled (interval set to 0)')
			return
		}

		const intervalMs = Math.ceil(this.config.pollingInterval * 1000) || 15000
		this.log('debug', `Starting poller with ${intervalMs}ms interval`)
		this.polling_interval = setInterval(() => {
			this._lastUpdateSource = 'poll'
			this.getAllDataFromEventmaster()
				.then(() => {
					this.refreshDefinitions()
				})
				.catch((err) => {
					// Guard: a rejected poll must not crash the module.
					this.log('error', `Poll failed: ${err?.message || err}`)
				})
		}, intervalMs)
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value:
					'This module uses the official EventMaster JSON API. If the status is OK, it ONLY means that the IP configured answers on icmp ping. With live updates on, the frame notifies changes (freeze, takes, names, presets) and the module re-reads just what changed. Otherwise everything refreshes on the polling interval.',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP',
				width: 6,
				default: '192.168.0.175',
				regex: Regex.IP,
			},
			{
				type: 'number',
				id: 'pollingInterval',
				label: 'Polling interval (seconds, 0 = off)',
				width: 6,
				default: 15,
			},
			{
				type: 'checkbox',
				id: 'enable_notifications',
				label: 'Enable live updates (EventMaster subscriptions)',
				width: 6,
				default: false,
			},

			{
				type: 'number',
				id: 'notification_port',
				label: 'Notification port (this machine)',
				width: 6,
				default: 3000,
				isVisible: (config) => !!config.enable_notifications,
			},
			{
				type: 'textinput',
				id: 'notification_host',
				label: 'Notification server host (leave blank to auto-detect)',
				width: 6,
				placeholder: 'Auto-detect local IP if empty',
				isVisible: (config) => !!config.enable_notifications,
			},
			{
				// Worked out each time the form opens, so it shows what auto-detect would pick right now
				type: 'static-text',
				id: 'notification_host_detected',
				label: 'Auto-detected address',
				width: 6, // sits in the gap beside the host field
				value: this.describeDetectedListener(),
				isVisible: (config) => !!config.enable_notifications,
			},
			{
				type: 'dropdown',
				id: 'auth_mode',
				label: 'Authentication Mode',
				choices: [
					{ id: 'none', label: 'None' },
					{ id: 'operator', label: 'Operator ID' },
					{ id: 'super_user', label: 'Super User Password' },
				],
				default: 'none',
			},
			{
				type: 'textinput',
				id: 'auth_value',
				label: 'Auth Value',
				width: 6,
				isVisible: (config) => config.auth_mode !== 'none',
			},
		]
	}

	getAuthType() {
		return this.config.auth_mode === 'none' ? undefined : this.config.auth_mode
	}

	getAuthValue() {
		return this.config.auth_mode === 'none' ? undefined : this.config.auth_value
	}

	async destroy() {
		if (this.retry_interval) clearInterval(this.retry_interval)
		if (this.polling_interval) clearInterval(this.polling_interval)
		// Teardown notifications if active
		try {
			await this.teardownNotifications()
		} catch {
			// ignore
		}
		delete this.eventmaster
		this.log(`debug`, 'destroy')
	}

	convertArrayToObject = (arr, sortByField) => {
		if (!arr) return {}
		if (sortByField) {
			arr.sort((a, b) => {
				if (a[sortByField] < b[sortByField]) return -1
				if (a[sortByField] > b[sortByField]) return 1
				return 0
			})
		}
		return arr.reduce((result, item) => {
			result[item.id] = item
			return result
		}, {})
	}

	// Helper function to convert a selected source value into the actual EventMaster source ID.
	// Companion dropdowns now store the EventMaster source ID directly, but some older code paths
	// still pass an array index. Resolve by real source ID first, then fall back to index lookup.
	getActualSourceId = (selectedValue) => {
		const sources = Object.values(this.eventmasterData.sources)
		const selectedSource =
			sources.find((source) => source.id === selectedValue) ||
			(selectedValue >= 0 && selectedValue < sources.length ? sources[selectedValue] : undefined)

		if (selectedSource) {
			const lookupType = selectedSource.id === selectedValue ? 'source id' : 'dropdown index'
			this.log(
				'debug',
				`Source lookup: ${lookupType} ${selectedValue} -> EventMaster ID ${selectedSource.id}, InputCfgIndex ${selectedSource.InputCfgIndex}, StillIndex ${selectedSource.StillIndex} (${selectedSource.Name})`,
			)

			// Use InputCfgIndex for inputs (>=0), use StillIndex for stills (InputCfgIndex=-1)
			let sourceIdToUse
			let sourceType

			if (selectedSource.InputCfgIndex !== undefined && selectedSource.InputCfgIndex >= 0) {
				sourceIdToUse = selectedSource.InputCfgIndex
				sourceType = 'Input'
			} else {
				sourceIdToUse = selectedSource.StillIndex !== undefined ? selectedSource.StillIndex : selectedSource.id
				sourceType = 'Still'
			}

			this.log('debug', `Using source ID: ${sourceIdToUse} (${sourceType})`)
			return sourceIdToUse
		}

		this.log('error', `Invalid source selection: ${selectedValue}`)
		return selectedValue
	}

	// Helper function to get SrcType based on InputCfgIndex
	getSourceType = (dropdownIndex) => {
		const sources = Object.values(this.eventmasterData.sources)
		if (dropdownIndex >= 0 && dropdownIndex < sources.length) {
			const selectedSource = sources[dropdownIndex]
			// 0 = Input (InputCfgIndex >= 0), 1 = Still (InputCfgIndex = -1)
			return selectedSource.InputCfgIndex !== undefined && selectedSource.InputCfgIndex >= 0 ? 0 : 1
		}
		return 0 // Default to Input if not found
	}

	// Data fetchers using new API
	async getPresetsFromEventmaster() {
		if (this.eventmaster) {
			try {
				const res = await new Promise((resolve, reject) => {
					this.eventmaster.listPresets(-1, -1, (err, result) => {
						if (err) reject(err)
						else {
							resolve(result)
						}
					})
				})
				this.eventmasterData.presets = this.convertArrayToObject(res?.response, 'presetSno')

				// Update variables to include new preset names
				this.updateDestinationVariables()
			} catch (err) {
				this.log('error', 'EventMaster Presets Error: ' + err)
			}
		}
	}

	async getSourcesFromEventmaster() {
		if (this.eventmaster) {
			try {
				const res = await new Promise((resolve, reject) => {
					this.eventmaster.listSources((err, result) => {
						if (err) reject(err)
						else resolve(result)
					})
				})
				this.eventmasterData.sources = this.convertArrayToObject(res?.response, 'Name')

				// // Debug: Show all sources for indexing troubleshooting
				// this.log('info', '=== ALL SOURCES DEBUG ===')
				// Object.values(this.eventmasterData.sources).forEach((source, index) => {
				// 	this.log('info', `Array Index: ${index} | EventMaster ID: ${source.id} | InputCfgIndex: ${source.InputCfgIndex} | StillIndex: ${source.StillIndex} | SrcType: ${source.SrcType} | Name: "${source.Name}"`)
				// })
				// this.log('info', '=== END SOURCES DEBUG ===')
			} catch (err) {
				this.log('error', 'EventMaster Sources Error: ' + err)
			}
		}
	}

	async getCuesFromEventmaster() {
		if (this.eventmaster) {
			try {
				const res = await new Promise((resolve, reject) => {
					this.eventmaster.listCues({}, (err, result) => {
						if (err) reject(err)
						else resolve(result)
					})
				})
				this.eventmasterData.cues = this.convertArrayToObject(res?.response)
			} catch (err) {
				this.log('error', 'EventMaster Cues Error: ' + err)
			}
		}
	}

	async getUserKeysFromEventmaster() {
		if (this.eventmaster) {
			try {
				const res = await new Promise((resolve, reject) => {
					this.eventmaster.listUserKeys((err, result) => {
						if (err) reject(err)
						else resolve(result)
					})
				})
				this.eventmasterData.userKeys = this.convertArrayToObject(res?.response)
			} catch (err) {
				this.log('error', 'EventMaster UserKeys Error: ' + err)
			}
		}
	}

	async getDestinationsFromEventmaster() {
		if (this.eventmaster) {
			try {
				const res = await new Promise((resolve, reject) => {
					this.eventmaster.listDestinations(0, (err, result) => {
						if (err) reject(err)
						else resolve(result)
					})
				})
				const response = res?.response || {}
				this.eventmasterData.ScreenDestinations = this.convertArrayToObject(response.ScreenDestination, 'Name')
				this.eventmasterData.AuxDestinations = this.convertArrayToObject(response.AuxDestination, 'Name')
				this.eventmasterData.SuperDestinations = this.convertArrayToObject(response.SuperDestination, 'Name')
				this.eventmasterData.SuperAuxDestinations = this.convertArrayToObject(response.SuperAux, 'Name')
			} catch (err) {
				this.log('error', 'EventMaster Destinations Error: ' + err)
			}
		}
	}

	async getPowerStatusFromEventmaster() {
		if (this.eventmaster) {
			try {
				const res = await new Promise((resolve, reject) => {
					this.eventmaster.powerStatus((err, result) => {
						if (err) reject(err)
						else resolve(result)
					})
				})
				this.applyPowerStatus(res)
			} catch (err) {
				this.log('error', 'EventMaster Power Status Error: ' + err)
			}
		}
	}

	applyPowerStatus(res) {
		// Some frames may not report power status: say so once, not on every heartbeat
		const unusable = (why) => {
			if (!this._powerStatusWarned) this.log('warn', `${why}; power status variables not updated (logged once)`)
			this._powerStatusWarned = true
		}
		if (!res || !res.response || typeof res.response !== 'object')
			return unusable('Power status response missing or malformed')
		const key = Object.keys(res.response)[0]
		const powerData = key !== undefined ? res.response[key] : undefined
		if (!powerData) return unusable('Power status response contained no power supply data')
		this._powerStatusWarned = false
		const powerVariables = {
			power_status1: this.powerStatus?.[parseInt(powerData.PowerSupply1Status)] || 'Unknown',
			power_status2: this.powerStatus?.[parseInt(powerData.PowerSupply2Status)] || 'Unknown',
		}

		// Apply change tracking for power status variables
		const changedPowerVariables = {}
		Object.entries(powerVariables).forEach(([key, value]) => {
			if (this.previousVariableValues[key] !== value) {
				changedPowerVariables[key] = value
				this.previousVariableValues[key] = value
			}
		})

		if (Object.keys(changedPowerVariables).length > 0) {
			this.setVariableValues(changedPowerVariables)
		}
	}

	async getAllDataFromEventmaster() {
		this.log('debug', `Fetching all data from EventMaster (source: ${this._lastUpdateSource || 'init'})`)
		await this.getFrameSettings()
		await this.getPresetsFromEventmaster()
		await this.getSourcesFromEventmaster()
		await this.getCuesFromEventmaster()
		await this.getDestinationsFromEventmaster()
		await this.getUserKeysFromEventmaster()
		await this.getPowerStatusFromEventmaster()

		// Update variable definitions to include destination content variables
		this.updateDestinationVariables()
	}

	/**
	 * Update variable definitions to include source monitoring variables
	 */
	updateDestinationVariables() {
		// Start with frame variables (if available) or default variables
		const variables =
			this.frameVariableDefinitions.length > 0
				? [...this.frameVariableDefinitions]
				: [
						{ variableId: 'frame_IP', name: 'Frame IP Address' },
						{ variableId: 'frame_MAC', name: 'Frame MAC Address' },
						{ variableId: 'frame_version', name: 'Frame Version' },
						{ variableId: 'frame_OSVersion', name: 'Frame OS Version' },
						{ variableId: 'power_status1', name: 'Power Supply 1 Status' },
						{ variableId: 'power_status2', name: 'Power Supply 2 Status' },
					]

		// Add source monitoring variables - show which destinations each source is active on
		if (this.eventmasterData && this.eventmasterData.sources) {
			Object.values(this.eventmasterData.sources).forEach((source) => {
				variables.push({
					variableId: `source_${source.id + 1}_name`,
					name: `Source ${source.id + 1} Name`,
				})
				variables.push({
					variableId: `source_${source.id + 1}_pgm_destinations`,
					name: `${source.Name} - PGM Destinations`,
				})
				variables.push({
					variableId: `source_${source.id + 1}_pvw_destinations`,
					name: `${source.Name} - PVW Destinations`,
				})
				variables.push({
					variableId: `source_${source.id + 1}_is_active`,
					name: `${source.Name} - Is Active (PGM or PVW)`,
				})
			})
		}

		// Add preset name variables
		if (this.eventmasterData && this.eventmasterData.presets) {
			Object.values(this.eventmasterData.presets).forEach((preset) => {
				variables.push({
					variableId: `preset_${preset.id}_name`,
					name: `Preset ${preset.presetSno || preset.id} Name`,
				})
				variables.push({
					variableId: `preset_${preset.id}_number`,
					name: `Preset ${preset.presetSno || preset.id} Number`,
				})
			})
		}

		// Add screen destination name variables
		if (this.eventmasterData && this.eventmasterData.ScreenDestinations) {
			Object.values(this.eventmasterData.ScreenDestinations).forEach((screen) => {
				variables.push({
					variableId: `screen_${screen.id}_name`,
					name: `Screen ${screen.id} Name`,
				})
			})
		}

		// Add AUX destination name variables
		if (this.eventmasterData && this.eventmasterData.AuxDestinations) {
			Object.values(this.eventmasterData.AuxDestinations).forEach((aux) => {
				variables.push({
					variableId: `aux_${aux.id}_name`,
					name: `AUX ${aux.id} Name`,
				})
			})
		}

		variables.push(
			{ variableId: 'live_updates_status', name: 'Live updates status' },
			{ variableId: 'live_updates_last', name: 'Last live update received' },
			{ variableId: 'live_updates_listener', name: 'Address the frame sends live updates to (auto or set)' },
		)

		// Only update variable definitions if they've changed
		const variableDefinitionsHash = JSON.stringify(variables)
		if (this.lastVariableDefinitionsHash !== variableDefinitionsHash) {
			this.log('debug', 'Variable definitions changed, updating...')
			this.setVariableDefinitions(variables)

			// Clear variable tracking only when definitions actually change
			this.previousVariableValues = {}
			this.lastVariableDefinitionsHash = variableDefinitionsHash
			if (this._statusVariables) this.setVariableValues(this._statusVariables)
		}

		// Auto-populate source monitoring variables.
		// Fire-and-forget, but guard the rejection so it can never become an
		// unhandled promise rejection that crashes the module.
		this.autoPopulateSourceMonitoring().catch((err) =>
			this.log('error', `Source monitoring update failed: ${err?.message || err}`),
		)
	}

	/**
	 * Read screen (listContent) and aux (listAuxContent) content into the per-destination cache.
	 * @param {{screens?: number[], auxes?: number[]}} [only] ids to read; omit to read all
	 */
	async fetchDestinationContent(only) {
		this._screenContent = this._screenContent || {}
		this._auxContent = this._auxContent || {}
		const wanted = (ids, id) => !only || (ids || []).includes(id)
		for (const dest of Object.values(this.eventmasterData?.ScreenDestinations || {})) {
			if (!wanted(only?.screens, dest.id)) continue
			try {
				const res = await new Promise((resolve, reject) => {
					this.eventmaster.listContent(parseInt(dest.id), (err, result) => (err ? reject(err) : resolve(result)))
				})
				if (res?.response) this._screenContent[dest.id] = res.response
				else this.log('warn', `No response data for screen destination ${dest.id}`)
			} catch (err) {
				this.log('error', `Could not get content for screen destination ${dest.id}: ${err}`)
			}
		}
		for (const dest of Object.values(this.eventmasterData?.AuxDestinations || {})) {
			if (!wanted(only?.auxes, dest.id)) continue
			try {
				const res = await new Promise((resolve, reject) => {
					this.eventmaster.listAuxContent(parseInt(dest.id), (err, result) => (err ? reject(err) : resolve(result)))
				})
				if (res?.response) this._auxContent[dest.id] = res.response
				else this.log('warn', `No response data for AUX destination ${dest.id}`)
			} catch (err) {
				this.log('error', `Could not get content for AUX destination ${dest.id}: ${err}`)
			}
		}
	}

	/**
	 * Auto-populate source monitoring variables by querying all destinations
	 * Shows which destinations each source is active on
	 */
	/**
	 * @param {{screens?: number[], auxes?: number[]}} [only] destinations to re-read; omit to re-read all
	 */
	async autoPopulateSourceMonitoring(only) {
		// Check if EventMaster is connected
		if (!this.eventmaster) {
			this.log('warn', 'EventMaster not connected, skipping source monitoring')
			return
		}

		// Initialize or retrieve previous variable values for change tracking
		if (!this.previousVariableValues) {
			this.previousVariableValues = {}
		}

		// Initialize source tracking objects and clear any previous data
		const sourcePgmDestinations = {}
		const sourcePvwDestinations = {}
		// Always clear all previous destination arrays for all known sources
		if (this.eventmasterData && this.eventmasterData.sources) {
			Object.values(this.eventmasterData.sources).forEach((source) => {
				sourcePgmDestinations[source.id] = []
				sourcePvwDestinations[source.id] = []
			})
		} else {
			this.log('warn', 'No sources available for monitoring')
			return
		}

		// Read content for the requested destinations (all by default) into the cache, then work out
		// tally from the cache for every destination, so a targeted read keeps the others' tally
		await this.fetchDestinationContent(only)

		for (const dest of Object.values(this.eventmasterData.ScreenDestinations || {})) {
			const content = this._screenContent?.[dest.id]
			if (!content) continue

			// Background layers: id 0 = PGM, id 1 = PVW
			for (const bg of content.BGLyr || []) {
				if (bg.LastBGSourceIndex === undefined || bg.LastBGSourceIndex === -1) continue
				const target = bg.id === 0 ? sourcePgmDestinations : bg.id === 1 ? sourcePvwDestinations : null
				if (target?.[bg.LastBGSourceIndex]) target[bg.LastBGSourceIndex].push(`Screen ${dest.Name}`)
			}

			// Layers on PGM / PVW (frozen layers excluded)
			for (const layer of content.Layers || []) {
				if (layer.LastSrcIdx === undefined || layer.LastSrcIdx === -1) continue
				if (layer.Freeze === undefined || layer.Freeze !== 0) continue
				const sourceId = layer.LastSrcIdx
				if (layer.PgmMode > 0 && sourcePgmDestinations[sourceId])
					sourcePgmDestinations[sourceId].push(`Screen ${dest.Name} L${layer.id}`)
				if (layer.PvwMode > 0 && sourcePvwDestinations[sourceId])
					sourcePvwDestinations[sourceId].push(`Screen ${dest.Name} L${layer.id}`)
			}
		}

		for (const dest of Object.values(this.eventmasterData.AuxDestinations || {})) {
			const auxContent = this._auxContent?.[dest.id]
			if (!auxContent) continue
			if (auxContent.PgmLastSrcIndex !== undefined && sourcePgmDestinations[auxContent.PgmLastSrcIndex])
				sourcePgmDestinations[auxContent.PgmLastSrcIndex].push(`AUX ${dest.Name}`)
			if (auxContent.PvwLastSrcIndex !== undefined && sourcePvwDestinations[auxContent.PvwLastSrcIndex])
				sourcePvwDestinations[auxContent.PvwLastSrcIndex].push(`AUX ${dest.Name}`)
		}

		// Set variable values for all sources
		const changedVariables = {}
		let activeSources = 0

		if (this.eventmasterData && this.eventmasterData.sources) {
			Object.values(this.eventmasterData.sources).forEach((source) => {
				const pgmDestsRaw = sourcePgmDestinations[source.id] || []
				const pvwDestsRaw = sourcePvwDestinations[source.id] || []
				const pgmDests = pgmDestsRaw.filter((dest) => dest && !dest.includes('background'))
				const pvwDests = pvwDestsRaw.filter((dest) => dest && !dest.includes('background'))
				let feedbackColor = undefined
				if (pgmDests.length > 0) {
					feedbackColor = 'red'
				} else if (pvwDests.length > 0) {
					feedbackColor = 'green'
				} else {
					feedbackColor = undefined
				}
				const isActive = pgmDests.length > 0 || pvwDests.length > 0
				const newValues = {
					[`source_${source.id + 1}_name`]: source.Name || `Source ${source.id + 1}`,
					[`source_${source.id + 1}_pgm_destinations`]: pgmDests.length > 0 ? pgmDests.join(', ') : 'Not active on PGM',
					[`source_${source.id + 1}_pvw_destinations`]: pvwDests.length > 0 ? pvwDests.join(', ') : 'Not active on PVW',
					[`source_${source.id + 1}_is_active`]: isActive ? 'Yes' : 'No',
					[`source_${source.id + 1}_tally`]: feedbackColor,
				}

				// Check for changes and only add changed variables
				Object.entries(newValues).forEach(([key, value]) => {
					if (this.previousVariableValues[key] !== value) {
						changedVariables[key] = value
						this.previousVariableValues[key] = value
					}
				})

				if (pgmDests.length > 0 || pvwDests.length > 0) {
					activeSources++
				}
			})
		}

		// Set preset name variables
		if (this.eventmasterData && this.eventmasterData.presets) {
			Object.values(this.eventmasterData.presets).forEach((preset) => {
				const newValues = {
					[`preset_${preset.id}_name`]: preset.Name ? _.unescape(preset.Name) : `Preset ${preset.id}`,
					[`preset_${preset.id}_number`]: preset.presetSno || preset.id || '?',
				}

				// Check for changes and only add changed variables
				Object.entries(newValues).forEach(([key, value]) => {
					if (this.previousVariableValues[key] !== value) {
						changedVariables[key] = value
						this.previousVariableValues[key] = value
					}
				})
			})
		}

		// Set screen destination name variables
		if (this.eventmasterData && this.eventmasterData.ScreenDestinations) {
			Object.values(this.eventmasterData.ScreenDestinations).forEach((screen) => {
				const key = `screen_${screen.id}_name`
				const value = screen.Name || `Screen ${screen.id}`

				if (this.previousVariableValues[key] !== value) {
					changedVariables[key] = value
					this.previousVariableValues[key] = value
				}
			})
		}

		// Set AUX destination name variables
		if (this.eventmasterData && this.eventmasterData.AuxDestinations) {
			Object.values(this.eventmasterData.AuxDestinations).forEach((aux) => {
				const key = `aux_${aux.id}_name`
				const value = aux.Name || `AUX ${aux.id}`

				if (this.previousVariableValues[key] !== value) {
					changedVariables[key] = value
					this.previousVariableValues[key] = value
				}
			})
		}

		// Only update variables if there are actual changes
		if (Object.keys(changedVariables).length > 0) {
			this.setVariableValues(changedVariables)
			// this.log('debug', `Updated ${Object.keys(changedVariables).length} changed variables`)
		} else {
			this.log('debug', 'No variable changes detected, skipping update')
		}

		// Update feedbacks to reflect current source activity
		this.checkFeedbacks()

		// Only log if there are actually active sources or it's been a while
		if (activeSources > 0 || !this._lastLogTime || Date.now() - this._lastLogTime > 60000) {
			this.log('debug', `Source monitoring updated: ${activeSources} sources have active destinations`)
			this._lastLogTime = Date.now()
		}
	}

	/**
	 * Helper method to find source name by ID
	 * @param {number} sourceId - The source ID to look up
	 * @returns {string} - The source name or "Unknown Source (ID)"
	 */
	findSourceNameById(sourceId) {
		if (this.eventmasterData && this.eventmasterData.sources) {
			const source = Object.values(this.eventmasterData.sources).find((src) => src.id === sourceId)
			if (source) {
				return source.Name
			}
		}
		return `Unknown Source (${sourceId})`
	}

	getActions() {
		const actions = {}

		const CHOICES_PRESETS = Object.values(this.eventmasterData.presets)
			.sort((a, b) => (a.presetSno || a.id) - (b.presetSno || b.id)) // Sort by presetSno (GUI order)
			.map((preset) => ({
				label: `${preset.presetSno || preset.id} ${_.unescape(preset.Name)}`,
				id: preset.id,
			}))
		const CHOICES_SOURCES = Object.values(this.eventmasterData.sources).map((source) => {
			const sourceType = source.InputCfgIndex !== undefined && source.InputCfgIndex >= 0 ? 'Input' : 'Still'
			return {
				label: `${source.Name} (${sourceType})`,
				id: source.id, // Use the actual EventMaster source ID directly
			}
		})
		const CHOICES_CUES = Object.values(this.eventmasterData.cues).map((cue) => ({
			label: cue.Name,
			id: cue.id,
		}))
		const CHOICES_USERKEYS = Object.values(this.eventmasterData.userKeys).map((key) => ({
			label: key.Name,
			id: key.id,
		}))
		const CHOICES_SCREENDESTINATIONS = Object.values(this.eventmasterData.ScreenDestinations)
			.sort((a, b) => a.id - b.id) // Sort by ID to ensure consistent ordering
			.map((dest) => ({
				label: dest.Name,
				id: dest.id,
			}))
		const CHOICES_AUXDESTINATIONS = Object.values(this.eventmasterData.AuxDestinations)
			.sort((a, b) => a.id - b.id) // Sort by ID to ensure consistent ordering
			.map((dest) => ({
				label: dest.Name,
				id: dest.id,
			}))
		// const CHOICES_SUPERDESTINATIONS = Object.values(this.eventmasterData.SuperDestinations).map((dest) => ({
		// 	label: dest.Name,
		// 	id: dest.id,
		// }))
		// const CHOICES_SUPERAUXS = Object.values(this.eventmasterData.SuperAux).map((dest) => ({
		// 	label: dest.Name,
		// 	id: dest.id,
		// }))

		// Recall Preset ***TESTED
		actions.recall_preset = {
			name: 'Recall Preset',
			options: [
				{
					type: 'dropdown',
					label: 'Preset',
					id: 'id',
					choices: CHOICES_PRESETS,
				},
				{
					type: 'dropdown',
					label: 'Mode',
					id: 'mode',
					choices: [
						{ id: '0', label: 'Preview' },
						{ id: '1', label: 'Program' },
					],
				},
			],
			callback: (action) => {
				const params = {
					id: action.options.id,
					type: action.options.mode,
					...(this.getAuthType() === 'operator' ? { operatorId: this.getAuthValue() } : {}),
					...(this.getAuthType() === 'super_user' ? { password: this.getAuthValue() } : {}),
				}
				this.log('debug', `Recalling Preset with params: ${JSON.stringify(params)}`)
				this.eventmaster.activatePresetById(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'recall preset response: ' + JSON.stringify(res))
				})
			},
		}

		// Recall Next Preset ***TESTED
		actions['recall_next'] = {
			name: 'Recall Next Preset',
			options: [],
			callback: () => {
				this.eventmaster.recallNextPreset((err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'recall next response: ' + JSON.stringify(res))
				})
			},
		}

		// Cut Active ***TESTED
		actions['cut_all'] = {
			name: 'Cut Active',
			options: [],
			callback: () => {
				const params = {
					...(this.getAuthType() === 'operator' ? { operatorId: this.getAuthValue() } : {}),
					...(this.getAuthType() === 'super_user' ? { password: this.getAuthValue() } : {}),
				}
				this.eventmaster.cut(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'cut all response: ' + JSON.stringify(res))
				})
			},
		}

		// Take/Trans Active ***TESTED
		actions['trans_all'] = {
			name: 'Take/Trans Active',
			options: [],
			callback: () => {
				const params = {
					...(this.getAuthType() === 'operator' ? { operatorId: this.getAuthValue() } : {}),
					...(this.getAuthType() === 'super_user' ? { password: this.getAuthValue() } : {}),
				}
				this.eventmaster.allTrans(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'trans all response: ' + JSON.stringify(res))
				})
			},
		}

		// Play Cue ***TESTED
		actions['play_cue'] = {
			name: 'Play Cue',
			options: [
				{
					type: 'dropdown',
					label: 'Cue',
					id: 'cueNumber',
					minChoicesForSearch: 5,
					choices: CHOICES_CUES,
					default: '0',
				},
			],
			callback: (action) => {
				const params = {
					id: parseInt(action.options.cueNumber),
					type: 0, // 0 for Play
				}
				this.eventmaster.activateCue(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'activateCue response: ' + JSON.stringify(res))
				})
			},
		}

		// Stop Cue ***TESTED
		actions['stop_cue'] = {
			name: 'Stop Cue',
			options: [
				{
					type: 'dropdown',
					label: 'Cue',
					id: 'cueNumber',
					minChoicesForSearch: 5,
					choices: CHOICES_CUES,
					default: '0',
				},
			],
			callback: (action) => {
				const params = {
					id: parseInt(action.options.cueNumber),
					type: 2, // 2 for Stop
				}
				this.eventmaster.activateCue(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'activateCue response: ' + JSON.stringify(res))
				})
			},
		}
		// Pause Cue
		actions['pause_cue'] = {
			name: 'Pause Cue',
			options: [
				{
					type: 'dropdown',
					label: 'Cue',
					id: 'cueNumber',
					minChoicesForSearch: 5,
					choices: CHOICES_CUES,
					default: '0',
				},
			],
			callback: (action) => {
				const params = {
					id: parseInt(action.options.cueNumber),
					type: 1, // 1 for Pause
				}
				this.eventmaster.activateCue(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'activateCue response: ' + JSON.stringify(res))
				})
			},
		}

		// Freeze/Unfreeze Source ***TESTED
		actions['frz_Source'] = {
			name: 'Freeze/Unfreeze Source',
			options: [
				{
					type: 'dropdown',
					label: 'freeze/unfreeze',
					id: 'frzType',
					choices: this.CHOICES_FREEZE,
					default: 1,
				},
				{
					type: 'dropdown',
					label: 'Source',
					id: 'frzSource',
					minChoicesForSearch: 5,
					choices: CHOICES_SOURCES,
					default: CHOICES_SOURCES.length > 0 ? CHOICES_SOURCES[0].id : 0,
				},
			],
			callback: (action) => {
				// Use the selected source ID directly (it's now the actual EventMaster source ID)
				const sourceId = parseInt(action.options.frzSource)

				const params = {
					type: 0, // 0 type is source
					id: sourceId,
					screengroup: 0, // 0 for all screengroups
					mode: parseInt(action.options.frzType), // 1 for freeze, 0 for unfreeze
				}
				this.eventmaster.freezeDestSource(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', '(un)freeze response: ' + JSON.stringify(res))
				})
			},
		}

		// Set testpattern for AUX ***TESTED
		actions['testpattern_on_AUX'] = {
			name: 'Set testpattern for AUX',
			options: [
				{
					type: 'dropdown',
					label: 'aux destination',
					id: 'auxDestination',
					choices: CHOICES_AUXDESTINATIONS,
				},
				{
					type: 'dropdown',
					label: 'Type number',
					id: 'testPattern',
					choices: this.CHOICES_TESTPATTERN,
				},
			],
			callback: (action) => {
				const params = {
					id: parseInt(action.options.auxDestination),
					TestPattern: parseInt(action.options.testPattern),
				}
				this.eventmaster.changeAuxContent(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'changeAuxContentTestPattern response: ' + JSON.stringify(res))
				})
			},
		}

		// Change AUX Content (Enhanced)
		actions['change_aux_content'] = {
			name: 'Change AUX Content',
			options: [
				{
					type: 'dropdown',
					label: 'AUX Destination',
					id: 'auxDestination',
					choices: CHOICES_AUXDESTINATIONS,
				},
				{
					type: 'textinput',
					label: 'Name (Optional)',
					id: 'auxName',
					default: '',
				},
				{
					type: 'dropdown',
					label: 'Preview Source',
					id: 'pvwSource',
					choices: [{ id: '', label: 'No Change' }, { id: -1, label: 'Clear Source' }, ...CHOICES_SOURCES],
					default: '',
				},
				{
					type: 'dropdown',
					label: 'Program Source',
					id: 'pgmSource',
					choices: [{ id: '', label: 'No Change' }, { id: -1, label: 'Clear Source' }, ...CHOICES_SOURCES],
					default: '',
				},
				{
					type: 'dropdown',
					label: 'Test Pattern',
					id: 'testPattern',
					choices: [{ id: '', label: 'No Test Pattern' }, ...this.CHOICES_TESTPATTERN],
					default: '',
				},
			],
			callback: (action) => {
				const params = {
					id: parseInt(action.options.auxDestination),
				}

				// Add optional name if provided
				if (action.options.auxName && action.options.auxName.trim() !== '') {
					params.Name = action.options.auxName.trim()
				}

				// Add preview source if selected
				if (action.options.pvwSource !== undefined && action.options.pvwSource !== '') {
					let pvwSourceIndex = parseInt(action.options.pvwSource)
					// Handle offset source IDs (convert back to real source ID)
					if (pvwSourceIndex >= 1000) {
						pvwSourceIndex = pvwSourceIndex - 1000
					}
					this.log('debug', `Setting PVW source to index: ${pvwSourceIndex}`)
					params.PvwLastSrcIndex = pvwSourceIndex
				}

				// Add program source if selected
				if (action.options.pgmSource !== undefined && action.options.pgmSource !== '') {
					let pgmSourceIndex = parseInt(action.options.pgmSource)
					// Handle offset source IDs (convert back to real source ID)
					if (pgmSourceIndex >= 1000) {
						pgmSourceIndex = pgmSourceIndex - 1000
					}
					this.log('debug', `Setting PGM source to index: ${pgmSourceIndex}`)
					params.PgmLastSrcIndex = pgmSourceIndex
				}

				// Add test pattern if selected
				if (action.options.testPattern && action.options.testPattern !== '') {
					params.TestPattern = parseInt(action.options.testPattern)
				}

				this.eventmaster.changeAuxContent(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else {
						this.log('debug', 'changeAuxContent response: ' + JSON.stringify(res))
						// Refresh source monitoring after changing AUX content
						this.autoPopulateSourceMonitoring()
					}
				})
			},
		}

		// Set testpattern for screen destinations  ***TESTED
		actions['testpattern_on_SCREEN'] = {
			name: 'Set testpattern for screen destinations',
			options: [
				{
					type: 'dropdown',
					label: 'destination',
					id: 'screenDestination',
					choices: CHOICES_SCREENDESTINATIONS,
				},
				{
					type: 'dropdown',
					label: 'Type number',
					id: 'testPattern',
					choices: this.CHOICES_TESTPATTERN,
				},
			],
			callback: (action) => {
				const params = {
					id: parseInt(action.options.screenDestination),
					TestPattern: parseInt(action.options.testPattern),
				}
				this.eventmaster.changeContent(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'changeContentTestPattern response: ' + JSON.stringify(res))
				})
			},
		}

		// Change Screen Content (Enhanced)
		actions['change_screen_content'] = {
			name: 'Change Screen Content',
			options: [
				{
					type: 'dropdown',
					label: 'Screen Destination',
					id: 'screenDestination',
					choices: CHOICES_SCREENDESTINATIONS,
				},
				{
					type: 'dropdown',
					label: 'Test Pattern',
					id: 'testPattern',
					choices: [{ id: '', label: 'No Test Pattern' }, ...this.CHOICES_TESTPATTERN],
					default: '',
				},
				{
					type: 'dropdown',
					label: 'Program Background Source',
					id: 'pgmBgSource',
					choices: [{ id: '', label: 'No Change' }, ...CHOICES_SOURCES],
					default: '',
				},
				{
					type: 'dropdown',
					label: 'Preview Background Source',
					id: 'pvwBgSource',
					choices: [{ id: '', label: 'No Change' }, ...CHOICES_SOURCES],
					default: '',
				},
				{
					type: 'checkbox',
					label: 'Show Program Background Matte',
					id: 'pgmBgMatte',
					default: false,
				},
				{
					type: 'checkbox',
					label: 'Show Preview Background Matte',
					id: 'pvwBgMatte',
					default: false,
				},
				{
					type: 'number',
					label: 'Layer ID (Optional)',
					id: 'layerId',
					default: '',
					min: 0,
				},
				{
					type: 'dropdown',
					label: 'Layer Source',
					id: 'layerSource',
					choices: [{ id: '', label: 'No Change' }, ...CHOICES_SOURCES],
					default: '',
				},
				{
					type: 'dropdown',
					label: 'Layer Mode',
					id: 'layerMode',
					choices: [
						{ id: '', label: 'No Change' },
						{ id: 'preview', label: 'Preview Only' },
						{ id: 'program', label: 'Program Only' },
						{ id: 'both', label: 'Both Preview & Program' },
					],
					default: '',
				},
				{
					type: 'number',
					label: 'Window H Position',
					id: 'winHPos',
					default: '',
					min: 0,
				},
				{
					type: 'number',
					label: 'Window V Position',
					id: 'winVPos',
					default: '',
					min: 0,
				},
				{
					type: 'number',
					label: 'Window H Size',
					id: 'winHSize',
					default: '',
					min: 1,
				},
				{
					type: 'number',
					label: 'Window V Size',
					id: 'winVSize',
					default: '',
					min: 1,
				},
			],
			callback: (action) => {
				const params = {
					id: parseInt(action.options.screenDestination),
				}

				// Add test pattern if selected
				if (action.options.testPattern && action.options.testPattern !== '') {
					params.TestPattern = parseInt(action.options.testPattern)
				}

				// Build background layers if sources are specified
				const bgLayers = []
				let hasBgChanges = false

				// Program background (id: 0)
				if (action.options.pgmBgSource !== undefined && action.options.pgmBgSource !== '') {
					const pgmBgSourceId = this.getActualSourceId(parseInt(action.options.pgmBgSource))

					bgLayers.push({
						id: 0,
						LastBGSourceIndex: pgmBgSourceId,
						BGShowMatte: action.options.pgmBgMatte ? 1 : 0,
						BGColor: [{ id: 0, Red: 0, Green: 0, Blue: 0 }],
					})
					hasBgChanges = true
				}

				// Preview background (id: 1)
				if (action.options.pvwBgSource !== undefined && action.options.pvwBgSource !== '') {
					const pvwBgSourceId = this.getActualSourceId(parseInt(action.options.pvwBgSource))

					bgLayers.push({
						id: 1,
						LastBGSourceIndex: pvwBgSourceId,
						BGShowMatte: action.options.pvwBgMatte ? 1 : 0,
						BGColor: [{ id: 0, Red: 0, Green: 0, Blue: 0 }],
					})
					hasBgChanges = true
				}

				if (hasBgChanges) {
					params.BGLyr = bgLayers
				}

				// Build layer configuration if layer settings are specified
				if (
					action.options.layerId !== '' &&
					(action.options.layerSource !== '' ||
						action.options.layerMode !== '' ||
						action.options.winHPos !== '' ||
						action.options.winVPos !== '' ||
						action.options.winHSize !== '' ||
						action.options.winVSize !== '')
				) {
					const layer = {
						id: parseInt(action.options.layerId) || 0,
					}

					// Set layer source
					if (action.options.layerSource !== undefined && action.options.layerSource !== '') {
						const layerSourceId = this.getActualSourceId(parseInt(action.options.layerSource))
						layer.LastSrcIdx = layerSourceId
					}

					// Set layer mode
					if (action.options.layerMode && action.options.layerMode !== '') {
						switch (action.options.layerMode) {
							case 'preview':
								layer.PvwMode = 1
								layer.PgmMode = 0
								break
							case 'program':
								layer.PvwMode = 0
								layer.PgmMode = 1
								break
							case 'both':
								layer.PvwMode = 1
								layer.PgmMode = 1
								break
						}
					}

					// Set window properties if any are specified
					if (
						action.options.winHPos !== '' ||
						action.options.winVPos !== '' ||
						action.options.winHSize !== '' ||
						action.options.winVSize !== ''
					) {
						layer.Window = {
							HPos: action.options.winHPos !== '' ? parseInt(action.options.winHPos) : 0,
							VPos: action.options.winVPos !== '' ? parseInt(action.options.winVPos) : 0,
							HSize: action.options.winHSize !== '' ? parseInt(action.options.winHSize) : 1920,
							VSize: action.options.winVSize !== '' ? parseInt(action.options.winVSize) : 1080,
						}
						// Default source size
						layer.Source = {
							HPos: 0,
							VPos: 0,
							HSize: 1920,
							VSize: 1080,
						}
						// Default mask (no cropping)
						layer.Mask = {
							Left: 0,
							Right: 0,
							Top: 0,
							Bottom: 0,
						}
					}

					params.Layers = [layer]
				}

				this.eventmaster.changeContent(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'changeContent response: ' + JSON.stringify(res))
				})
			},
		}

		// Reset Frame Settings
		actions['reset_frame'] = {
			name: 'Reset Frame Settings',
			options: [
				{
					type: 'dropdown',
					label: 'Reset Type',
					id: 'resetType',
					choices: [
						{ id: 0, label: 'Soft reset' },
						{ id: 1, label: 'Factory reset' },
						{ id: 2, label: 'Factory reset (save IP)' },
						{ id: 3, label: 'Factory reset (save IP/EDID)' },
						{ id: 4, label: 'Factory reset (save VPID)' },
						{ id: 5, label: 'Power Down' },
					],
					default: 0,
				},
			],
			callback: (action) => {
				this.eventmaster.resetFrameSettings(parseInt(action.options.resetType), (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'resetFrameSettings response: ' + JSON.stringify(res))
				})
			},
		}

		// Power Status ***TESTED
		// actions['power_status'] = {
		// 	name: 'Get Power Status',
		// 	options: [],
		// 	callback: () => {
		// 		this.eventmaster.powerStatus((err, res) => {
		// 			if (err) this.log('error', 'EventMaster Error: ' + err)
		// 			else {
		// 				this.log('debug', 'powerStatus response: ' + JSON.stringify(res))
		// 				const key = Object.keys(res.response)[0]
		// 				this.setVariableValues({
		// 					power_status1: this.powerStatus[parseInt(res.response[key].PowerSupply1Status)],
		// 					power_status2: this.powerStatus[parseInt(res.response[key].PowerSupply2Status)],
		// 				})
		// 			}
		// 		})
		// 	},
		// }

		// Save Preset ***TESTED
		actions['save_preset'] = {
			name: 'Save Preset',
			options: [
				{
					type: 'textinput',
					label: 'Preset Name',
					id: 'presetName',
					default: '',
				},
			],
			callback: (action) => {
				const params = {
					presetName: action.options.presetName,
					ScreenDestinations: [],
					AuxDestinations: [],
					...(this.getAuthType() === 'operator' ? { operatorId: this.getAuthValue() } : {}),
					...(this.getAuthType() === 'super_user' ? { password: this.getAuthValue() } : {}),
				}
				this.eventmaster.savePreset(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'savePreset response: ' + JSON.stringify(res))
				})
			},
		}

		// Delete Preset ***TESTED
		actions['delete_preset'] = {
			name: 'Delete Preset',
			options: [
				{
					type: 'dropdown',
					label: 'Preset',
					id: 'preset_to_delete',
					choices: CHOICES_PRESETS,
				},
			],
			callback: (action) => {
				const params = {
					id: parseInt(action.options.preset_to_delete),
					...(this.getAuthType() === 'operator' ? { operatorId: this.getAuthValue() } : {}),
					...(this.getAuthType() === 'super_user' ? { password: this.getAuthValue() } : {}),
				}
				this.eventmaster.deletePreset(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'deletePreset response: ' + JSON.stringify(res))
				})
			},
		}

		// Rename Preset ***TESTED
		actions['rename_preset'] = {
			name: 'Rename Preset',
			options: [
				{
					type: 'dropdown',
					label: 'Preset',
					id: 'preset_to_rename',
					choices: CHOICES_PRESETS,
				},
				{
					type: 'textinput',
					label: 'New Name',
					id: 'newPresetName',
					default: '',
				},
			],
			callback: (action) => {
				const params = {
					id: parseInt(action.options.preset_to_rename),
					newPresetName: action.options.newPresetName,
					...(this.getAuthType() === 'operator' ? { operatorId: this.getAuthValue() } : {}),
					...(this.getAuthType() === 'super_user' ? { password: this.getAuthValue() } : {}),
				}
				this.eventmaster.renamePreset(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'renamePreset response: ' + JSON.stringify(res))
				})
			},
		}

		// Fill Layers to Screen Destination ***TESTED
		actions['fill_hv'] = {
			name: 'Fit Layers to Screen Destination',
			options: [
				{
					type: 'dropdown',
					label: 'Screen Destination',
					id: 'screenDest',
					choices: CHOICES_SCREENDESTINATIONS,
				},
				{
					type: 'textinput',
					label: 'Layer IDs (comma separated)',
					id: 'layerIds',
					default: '',
				},
			],
			callback: (action) => {
				const layers = action.options.layerIds.split(',').map((id) => ({ id: parseInt(id.trim()) }))
				this.eventmaster.fillHV(parseInt(action.options.screenDest), layers, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'fillHV response: ' + JSON.stringify(res))
				})
			},
		}

		// Clear Layers from Screen Destination ***TESTED
		actions['clear_layers'] = {
			name: 'Clear Layers from Screen Destination',
			options: [
				{
					type: 'dropdown',
					label: 'Screen Destination',
					id: 'screenDest',
					choices: CHOICES_SCREENDESTINATIONS,
				},
				{
					type: 'textinput',
					label: 'Layer IDs (comma separated)',
					id: 'layerIds',
					default: '',
				},
			],
			callback: (action) => {
				const layers = action.options.layerIds.split(',').map((id) => ({ id: parseInt(id.trim()) }))
				this.eventmaster.clearLayers(parseInt(action.options.screenDest), layers, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'clearLayers response: ' + JSON.stringify(res))
				})
			},
		}
		// Recall User Key ***TESTED
		actions['recall_userkey'] = {
			name: 'Recall User Key',
			options: [
				{
					type: 'dropdown',
					label: 'User Key',
					id: 'userKeyId',
					choices: CHOICES_USERKEYS || [],
				},
				{
					type: 'dropdown',
					label: 'Screen Destinations',
					id: 'screenDest',
					choices: CHOICES_SCREENDESTINATIONS,
					isMulti: true,
				},
				{
					type: 'textinput',
					label: 'Layer IDs (comma separated)',
					id: 'layerIds',
					default: '',
				},
			],
			callback: (action) => {
				const params = {
					id: parseInt(action.options.userKeyId),
					ScreenDestination: [parseInt(action.options.screenDest)],
					Layer: action.options.layerIds.split(',').map((id) => parseInt(id.trim())),
					...(this.getAuthType() === 'operator' ? { operatorId: this.getAuthValue() } : {}),
					...(this.getAuthType() === 'super_user' ? { password: this.getAuthValue() } : {}),
				}
				this.eventmaster.recallUserKey(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'recallUserKey response: ' + JSON.stringify(res))
				})
			},
		}
		// actions['list_stills'] = {
		// 	name: 'List Still Stores',
		// 	options: [],
		// 	callback: () => {
		// 		this.eventmaster.listStill((err, res) => {
		// 			if (err) this.log('error', 'EventMaster Error: ' + err)
		// 			else this.log('debug', 'listStill response: ' + JSON.stringify(res))
		// 		})
		// 	},
		// }
		// actions['delete_still'] = {
		// 	name: 'Delete Still',
		// 	options: [
		// 		{
		// 			type: 'dropdown',
		// 			label: 'Still Store',
		// 			id: 'stillId',
		// 			choices: CHOICES_STILLS || [],
		// 		},
		// 	],
		// 	callback: (action) => {
		// 		this.eventmaster.deleteStill(parseInt(action.options.stillId), (err, res) => {
		// 			if (err) this.log('error', 'EventMaster Error: ' + err)
		// 			else this.log('debug', 'deleteStill response: ' + JSON.stringify(res))
		// 		})
		// 	},
		// }
		// actions['take_still'] = {
		// 	name: 'Capture Still',
		// 	options: [
		// 		{
		// 			type: 'dropdown',
		// 			label: 'Source Type',
		// 			id: 'srcType',
		// 			choices: [
		// 				{ id: 0, label: 'Input Source' },
		// 				{ id: 1, label: 'Background Source' },
		// 			],
		// 		},
		// 		{
		// 			type: 'dropdown',
		// 			label: 'Source ID',
		// 			id: 'srcId',
		// 			choices: CHOICES_SOURCES,
		// 		},
		// 		{
		// 			type: 'number',
		// 			label: 'Still Store Index',
		// 			id: 'fileId',
		// 			default: 0,
		// 		},
		// 	],
		// 	callback: (action) => {
		// 		this.eventmaster.takeStill(
		// 			parseInt(action.options.srcType),
		// 			parseInt(action.options.srcId),
		// 			parseInt(action.options.fileId),
		// 			(err, res) => {
		// 				if (err) this.log('error', 'EventMaster Error: ' + err)
		// 				else this.log('debug', 'takeStill response: ' + JSON.stringify(res))
		// 			}
		// 		)
		// 	},
		// }
		// List Operators ***TESTED
		// actions['list_operators'] = {
		// 	name: 'List Operators',
		// 	options: [],
		// 	callback: () => {
		// 		this.eventmaster.listOperators((err, res) => {
		// 			if (err) this.log('error', 'EventMaster Error: ' + err)
		// 			else this.log('debug', 'listOperators response: ' + JSON.stringify(res))
		// 		})
		// 	},
		// }

		// List MVR Presets ***NEW API
		// actions['list_mvr_presets'] = {
		// 	name: 'List MVR Presets',
		// 	options: [],
		// 	callback: () => {
		// 		this.eventmaster.listMvrPreset({ id: -1 }, (err, res) => {
		// 			if (err) this.log('error', 'EventMaster Error: ' + err)
		// 			else this.log('debug', 'listMvrPreset response: ' + JSON.stringify(res))
		// 		})
		// 	},
		// }
		// actions['getFrameSettings'] = {
		// 	name: 'Get Frame Settings',
		// 	options: [],
		// 	callback: () => {
		// 		this.eventmaster.getFrameSettings({}, (err, res) => {
		// 			if (err) this.log('error', 'EventMaster Error: ' + err)
		// 			else {
		// 				console.log('Frame Settings Action Response:', JSON.stringify(res, null, 2))
		//
		// 				// Parse the correct structure
		// 				let frameData = null
		// 				if (res.response && res.response.System && res.response.System.FrameCollection && res.response.System.FrameCollection.Frame) {
		// 					// Frame is a single object, not an array
		// 					frameData = res.response.System.FrameCollection.Frame
		// 				}
		//
		// 				if (frameData) {
		// 					const frameIP = frameData.Enet?.IP || this.config.host || 'Unknown'
		// 					const version = frameData.Version || 'Unknown'
		// 					const osVersion = frameData.OSVersion || 'Unknown'
		//
		// 					this.eventmasterData.frameIP = frameIP
		// 					this.eventmasterData.version = version
		// 					this.eventmasterData.OSVersion = osVersion
		//
		// 					// Start with basic variables
		// 					const variableValues = {
		// 						frame_IP: frameIP,
		// 						frame_version: version,
		// 						frame_OSVersion: osVersion,
		// 					}
		//
		// 					// Process card slots if they exist
		// 					if (frameData.Slot && Array.isArray(frameData.Slot)) {
		// 						frameData.Slot.forEach((slot, index) => {
		// 							if (slot.Card) {
		// 								const slotNum = index + 1
		// 								const card = slot.Card
		//
		// 								// Build health status
		// 								let healthStatus = 'OK'
		// 								if (card.OverTemp === 1 && card.FanWarn === 1) {
		// 									healthStatus = 'Over Temp + Fan Warning'
		// 								} else if (card.OverTemp === 1) {
		// 									healthStatus = 'Over Temperature'
		// 								} else if (card.FanWarn === 1) {
		// 									healthStatus = 'Fan Warning'
		// 								}
		//
		// 								// Combine all card info into a single string
		// 								const cardInfo = `${card.CardTypeLabel || 'Unknown'} - Status: ${card.CardStatusLabel || 'Unknown'} - Temp/Fan: ${healthStatus}`
		// 								variableValues[`card${slotNum}_info`] = cardInfo
		// 							}
		// 						})
		// 					}
		//
		// 					// Add SysCard information if available
		// 					if (frameData.SysCard) {
		// 						let sysHealthStatus = 'OK'
		// 						if (frameData.SysCard.OverTemp === 1 && frameData.SysCard.FanWarn === 1) {
		// 							sysHealthStatus = 'Over Temp + Fan Warning'
		// 						} else if (frameData.SysCard.OverTemp === 1) {
		// 							sysHealthStatus = 'Over Temperature'
		// 						} else if (frameData.SysCard.FanWarn === 1) {
		// 							sysHealthStatus = 'Fan Warning'
		// 						}
		//
		// 						const sysCardInfo = `${frameData.SysCard.CardTypeLabel || 'Unknown'} - Status: ${frameData.SysCard.CardStatusLabel || 'Unknown'} - Temp/Fan: ${sysHealthStatus}`
		// 						variableValues.syscard_info = sysCardInfo
		// 					}
		//
		// 					this.setVariableValues(variableValues)
		//
		// 					this.log('debug', `Frame Settings Action: IP=${frameIP}, Version=${version}, OS=${osVersion}`)
		// 				}
		// 			}
		// 		})
		// 	},
		// }

		// Activate MVR Preset ***NEW API
		actions['activate_mvr_preset'] = {
			name: 'Activate MVR Preset',
			options: [
				{
					type: 'number',
					label: 'MVR Preset ID',
					id: 'mvrPresetId',
					default: 0,
				},
			],
			callback: (action) => {
				const params = {
					id: parseInt(action.options.mvrPresetId),
				}
				this.eventmaster.activateMvrPreset(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'activateMvrPreset response: ' + JSON.stringify(res))
				})
			},
		}

		// Change MVR Layout ***NEW API/TESTED
		actions['mvr_layout_change'] = {
			name: 'Change MVR Layout',
			options: [
				{
					type: 'number',
					label: 'MVR ID',
					id: 'mvrId',
					default: 0,
				},
				{
					type: 'number',
					label: 'Layout ID',
					id: 'layoutId',
					default: 0,
				},

				{
					type: 'number',
					label: 'Frame Unit ID',
					id: 'frameUnitId',
					default: 0,
					regex: Regex.NUMBER,
				},
			],
			callback: (action) => {
				const params = {
					frameUnitId: parseInt(action.options.frameUnitId),
					mvrId: parseInt(action.options.mvrId),
					mvrLayoutId: parseInt(action.options.layoutId),
				}
				this.eventmaster.mvrLayoutChange(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'mvrLayoutChange response: ' + JSON.stringify(res))
				})
			},
		}

		// Activate Destination Group ***TESTED
		actions['activate_dest_group'] = {
			name: 'Activate Destination Group',
			options: [
				{
					type: 'textinput',
					label: 'Group ID or Name',
					id: 'groupIdOrName',
					default: '',
				},
			],
			callback: (action) => {
				const params = {
					...(isNaN(action.options.groupIdOrName)
						? { destGrpName: action.options.groupIdOrName }
						: { id: parseInt(action.options.groupIdOrName) }),
				}
				this.eventmaster.activateDestGroup(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'activateDestGroup response: ' + JSON.stringify(res))
				})
			},
		}

		// Arm/Unarm Destination ***TESTED
		actions['arm_unarm_destination'] = {
			name: 'Arm/Unarm Destination',
			options: [
				{
					type: 'dropdown',
					label: 'Destination',
					id: 'destId',
					choices: CHOICES_SCREENDESTINATIONS,
				},
				{
					type: 'dropdown',
					label: 'Arm (true) or Unarm (false)',
					id: 'arm',
					choices: [
						{ id: 1, label: 'Arm' },
						{ id: 0, label: 'Unarm' },
					],
					default: 1,
				},
			],
			callback: (action) => {
				const params = {
					ScreenDestination: [{ id: parseInt(action.options.destId) }],
					AuxDestination: [],
					arm: parseInt(action.options.arm),
				}
				this.log('debug', `Arm/Unarm Destination with params: ${JSON.stringify(params)}`)
				this.eventmaster.armUnarmDestination(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'armUnarmDestination response: ' + JSON.stringify(res))
				})
			},
		}

		// Arm/Unarm AUX Destination
		actions['arm_unarm_aux_destination'] = {
			name: 'Arm/Unarm AUX Destination',
			options: [
				{
					type: 'dropdown',
					label: 'AUX Destination',
					id: 'auxDestId',
					choices: CHOICES_AUXDESTINATIONS,
				},
				{
					type: 'dropdown',
					label: 'Arm (true) or Unarm (false)',
					id: 'arm',
					choices: [
						{ id: 1, label: 'Arm' },
						{ id: 0, label: 'Unarm' },
					],
					default: 1,
				},
			],
			callback: (action) => {
				const params = {
					ScreenDestination: [],
					AuxDestination: [{ id: parseInt(action.options.auxDestId) }],
					arm: parseInt(action.options.arm),
				}
				this.log('debug', `Arm/Unarm AUX Destination with params: ${JSON.stringify(params)}`)
				this.eventmaster.armUnarmDestination(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'armUnarmAuxDestination response: ' + JSON.stringify(res))
				})
			},
		}

		// Freeze/Unfreeze Destination ***NEW API
		actions['freeze_dest'] = {
			name: 'Freeze/Unfreeze Destination',
			options: [
				{
					type: 'dropdown',
					label: 'Destination',
					id: 'destId',
					choices: CHOICES_SCREENDESTINATIONS,
				},
				{
					type: 'dropdown',
					label: 'Freeze (true) or Unfreeze (false)',
					id: 'freeze',
					choices: this.CHOICES_FREEZE,
					default: 1,
				},
			],
			callback: (action) => {
				const params = {
					type: 2, // 2 type is destination
					id: parseInt(action.options.destId),
					screengroup: 0, // 0 for all screengroups
					mode: parseInt(action.options.freeze), // 1 for freeze, 0 for unfreeze
				}
				this.eventmaster.freezeDestSource(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', '(un)freeze response: ' + JSON.stringify(res))
				})
			},
		}

		// List Source Main Backup
		// actions['list_source_main_backup'] = {
		// 	name: 'List Source Main Backup',
		// 	options: [
		// 		{
		// 			type: 'dropdown',
		// 			label: 'Input Type',
		// 			id: 'inputType',
		// 			choices: [
		// 				{ id: -1, label: 'All (Inputs + Background)' },
		// 				{ id: 0, label: 'Inputs Only' },
		// 				{ id: 1, label: 'Background Only' },
		// 			],
		// 			default: -1,
		// 		},
		// 	],
		// 	callback: (action) => {
		// 		const params = {
		// 			inputType: parseInt(action.options.inputType),
		// 		}
		// 		this.eventmaster.listSourceMainBackup(params, (err, res) => {
		// 			if (err) this.log('error', 'EventMaster Error: ' + err)
		// 			else this.log('debug', 'listSourceMainBackup response: ' + JSON.stringify(res))
		// 		})
		// 	},
		// }

		// Activate Source Main Backup
		actions['activate_source_main_backup'] = {
			name: 'Activate Source Main Backup',
			options: [
				{
					type: 'dropdown',
					label: 'Input/Background Source',
					id: 'inputId',
					choices: CHOICES_SOURCES,
				},
				{
					type: 'dropdown',
					label: 'Backup 1 Source',
					id: 'backup1SourceId',
					choices: CHOICES_SOURCES,
				},
				{
					type: 'dropdown',
					label: 'Backup 2 Source',
					id: 'backup2SourceId',
					choices: CHOICES_SOURCES,
				},
				{
					type: 'dropdown',
					label: 'Backup 3 Source',
					id: 'backup3SourceId',
					choices: CHOICES_SOURCES,
				},
				{
					type: 'dropdown',
					label: 'Backup State',
					id: 'backupState',
					choices: [
						{ id: -1, label: 'Primary (Default)' },
						{ id: 0, label: 'Backup 1' },
						{ id: 1, label: 'Backup 2' },
						{ id: 2, label: 'Backup 3' },
					],
					default: -1,
				},
			],
			callback: (action) => {
				// Convert dropdown indices to actual EventMaster source IDs and auto-detect types
				this.log(
					'debug',
					`Source Main Backup: Raw options - inputId: ${action.options.inputId}, backup1: ${action.options.backup1SourceId}, backup2: ${action.options.backup2SourceId}, backup3: ${action.options.backup3SourceId}`,
				)

				const inputId = this.getActualSourceId(parseInt(action.options.inputId))
				const backup1SourceId = this.getActualSourceId(parseInt(action.options.backup1SourceId))
				const backup2SourceId = this.getActualSourceId(parseInt(action.options.backup2SourceId))
				const backup3SourceId = this.getActualSourceId(parseInt(action.options.backup3SourceId))

				// Auto-detect source types based on InputCfgIndex
				const backup1SrcType = this.getSourceType(parseInt(action.options.backup1SourceId))
				const backup2SrcType = this.getSourceType(parseInt(action.options.backup2SourceId))
				const backup3SrcType = this.getSourceType(parseInt(action.options.backup3SourceId))

				this.log(
					'debug',
					`Source Main Backup: Resolved IDs - inputId: ${inputId}, backup1: ${backup1SourceId} (type ${backup1SrcType}), backup2: ${backup2SourceId} (type ${backup2SrcType}), backup3: ${backup3SourceId} (type ${backup3SrcType})`,
				)

				const params = {
					inputId: inputId,
					Backup1: {
						SrcType: backup1SrcType,
						SourceId: backup1SourceId,
					},
					Backup2: {
						SrcType: backup2SrcType,
						SourceId: backup2SourceId,
					},
					Backup3: {
						SrcType: backup3SrcType,
						SourceId: backup3SourceId,
					},
					BackUpState: parseInt(action.options.backupState),
				}
				this.log('debug', 'Activating Source Main Backup with params: ' + JSON.stringify(params))
				this.eventmaster.activateSourceMainBackup(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'activateSourceMainBackup response: ' + JSON.stringify(res))
				})
			},
		}

		// Reset Source Main Backup
		actions['reset_source_main_backup'] = {
			name: 'Reset Source Main Backup',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'sourceId',
					choices: CHOICES_SOURCES,
				},
			],
			callback: (action) => {
				const dropdownIndex = parseInt(action.options.sourceId)
				const sourceId = this.getActualSourceId(dropdownIndex)

				const params = {
					id: sourceId,
				}
				this.eventmaster.resetSourceMainBackup(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'resetSourceMainBackup response: ' + JSON.stringify(res))
				})
			},
		}

		// Refresh Source Monitoring (Refresh All PGM/PVW Status)
		actions['refresh_source_monitoring'] = {
			name: 'Refresh Source Monitoring',
			options: [],
			callback: () => {
				this.autoPopulateSourceMonitoring()
					.then(() => {
						this.log('info', 'Source monitoring variables refreshed')
					})
					.catch((err) => {
						this.log('error', 'Error refreshing source monitoring: ' + err)
					})
			},
		}

		// List Screen Destination Content (Get Active PGM Source)
		// actions['list_screen_content'] = {
		// 	name: 'List Screen Destination Content',
		// 	options: [
		// 		{
		// 			type: 'dropdown',
		// 			label: 'Screen Destination',
		// 			id: 'screenId',
		// 			choices: CHOICES_SCREENDESTINATIONS,
		// 		},
		// 	],
		// 	callback: (action) => {
		// 		this.eventmaster.listContent(parseInt(action.options.screenId), (err, res) => {
		// 			if (err) {
		// 				this.log('error', 'EventMaster Error: ' + err)
		// 			} else {
		// 				this.log('debug', 'listContent response: ' + JSON.stringify(res))
		//
		// 				// Display information about this destination
		// 				if (res && res.response) {
		// 					const content = res.response
		// 					let pgmInfo = []
		// 					let pvwInfo = []
		//
		// 					// Check background layers
		// 					if (content.BGLayers && content.BGLayers.length > 0) {
		// 						const pgmBgLayer = content.BGLayers.find(layer => layer.id === 0)
		// 						if (pgmBgLayer && pgmBgLayer.LastBGSourceIndex !== undefined) {
		// 							const sourceName = this.findSourceNameById(pgmBgLayer.LastBGSourceIndex)
		// 							pgmInfo.push(`Background: ${sourceName}`)
		// 						}
		//
		// 						const pvwBgLayer = content.BGLayers.find(layer => layer.id === 1)
		// 						if (pvwBgLayer && pvwBgLayer.LastBGSourceIndex !== undefined) {
		// 							const sourceName = this.findSourceNameById(pvwBgLayer.LastBGSourceIndex)
		// 							pvwInfo.push(`Background: ${sourceName}`)
		// 						}
		// 					}
		//
		// 					// Check active layers
		// 					if (content.Layers && content.Layers.length > 0) {
		// 						content.Layers.forEach(layer => {
		// 							if (layer.LastSrcIndex !== undefined) {
		// 								const sourceName = this.findSourceNameById(layer.LastSrcIndex)
		// 								pgmInfo.push(`Layer ${layer.id}: ${sourceName}`)
		// 							}
		// 							if (layer.PvwLastSrcIndex !== undefined) {
		// 								const sourceName = this.findSourceNameById(layer.PvwLastSrcIndex)
		// 								pvwInfo.push(`Layer ${layer.id}: ${sourceName}`)
		// 							}
		// 						})
		// 					}
		//
		// 					const pgmSummary = pgmInfo.length > 0 ? pgmInfo.join(', ') : 'No PGM content'
		// 					const pvwSummary = pvwInfo.length > 0 ? pvwInfo.join(', ') : 'No PVW content'
		//
		// 					this.log('info', `Screen ${action.options.screenId} - PGM: ${pgmSummary} | PVW: ${pvwSummary}`)
		// 				}
		//
		// 				// Refresh source monitoring after checking this destination
		// 				this.autoPopulateSourceMonitoring()
		// 			}
		// 		})
		// 	},
		// }

		// List AUX Destination Content (Get Active PGM Source)
		// actions['list_aux_content'] = {
		// 	name: 'List AUX Destination Content',
		// 	options: [
		// 		{
		// 			type: 'dropdown',
		// 			label: 'AUX Destination',
		// 			id: 'auxId',
		// 			choices: CHOICES_AUXDESTINATIONS,
		// 		},
		// 	],
		// 	callback: (action) => {
		// 		this.eventmaster.listAuxContent(parseInt(action.options.auxId), (err, res) => {
		// 			if (err) {
		// 				this.log('error', 'EventMaster Error: ' + err)
		// 			} else {
		// 				this.log('debug', 'listAuxContent response: ' + JSON.stringify(res))
		//
		// 				// Display information about this AUX destination
		// 				if (res && res.response) {
		// 					const auxContent = res.response
		// 					let pgmSourceInfo = 'No PGM source'
		// 					let pvwSourceInfo = 'No PVW source'
		//
		// 					if (auxContent.PgmLastSrcIndex !== undefined) {
		// 						const sourceName = this.findSourceNameById(auxContent.PgmLastSrcIndex)
		// 						pgmSourceInfo = `${sourceName} (ID: ${auxContent.PgmLastSrcIndex})`
		// 					}
		//
		// 					if (auxContent.PvwLastSrcIndex !== undefined) {
		// 						const sourceName = this.findSourceNameById(auxContent.PvwLastSrcIndex)
		// 						pvwSourceInfo = `${sourceName} (ID: ${auxContent.PvwLastSrcIndex})`
		// 					}
		//
		// 					this.log('info', `AUX ${action.options.auxId} - PGM: ${pgmSourceInfo} | PVW: ${pvwSourceInfo}`)
		// 				}
		//
		// 				// Refresh source monitoring after checking this destination
		// 				this.autoPopulateSourceMonitoring()
		// 			}
		// 		})
		// 	},
		// }

		return actions
	}

	getFeedbacks() {
		const feedbacks = {}

		// Create destination choices for the feedback options
		const destinationChoices = [
			{ id: 'anywhere', label: 'Anywhere (Any PGM or PVW)' },
			{ id: 'anywhere_pgm', label: 'Anywhere PGM' },
			{ id: 'anywhere_pvw', label: 'Anywhere PVW' },
		]

		// Add screen destinations
		if (this.eventmasterData && this.eventmasterData.ScreenDestinations) {
			Object.values(this.eventmasterData.ScreenDestinations).forEach((screen) => {
				destinationChoices.push(
					{ id: `screen_${screen.id}_pgm`, label: `${screen.Name} PGM` },
					{ id: `screen_${screen.id}_pvw`, label: `${screen.Name} PVW` },
					{ id: `screen_${screen.id}`, label: `${screen.Name} (PGM or PVW)` },
				)
			})
		}

		// Add AUX destinations
		if (this.eventmasterData && this.eventmasterData.AuxDestinations) {
			Object.values(this.eventmasterData.AuxDestinations).forEach((aux) => {
				destinationChoices.push(
					{ id: `aux_${aux.id}_pgm`, label: `AUX ${aux.Name} PGM` },
					{ id: `aux_${aux.id}_pvw`, label: `AUX ${aux.Name} PVW` },
					{ id: `aux_${aux.id}`, label: `AUX ${aux.Name} (PGM or PVW)` },
				)
			})
		}

		// Create source choices for the feedback options
		const sourceChoices = []
		if (this.eventmasterData && this.eventmasterData.sources) {
			Object.values(this.eventmasterData.sources).forEach((source) => {
				sourceChoices.push({
					id: source.id + 1, // Convert to 1-based for display
					label: `${source.id + 1}: ${source.Name}`,
				})
			})
		}

		// Simple source active feedback for status presets
		feedbacks['source_active_simple'] = {
			type: 'boolean',
			name: 'Source Active (Simple)',
			description: 'Simple indicator if source is active anywhere, with tally state',
			defaultStyle: {
				bgcolor: 16711680, // Red background when active (0xFF0000)
				color: 16777215, // White text (0xFFFFFF)
			},
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					choices: sourceChoices,
					default: sourceChoices.length > 0 ? sourceChoices[0].id : 1,
				},
				{
					type: 'dropdown',
					label: 'Tally State',
					id: 'tallyState',
					choices: [
						{ id: 'pgm', label: 'Program' },
						{ id: 'pvw', label: 'Preview' },
					],
					default: 'pgm',
				},
			],
			callback: (feedback) => {
				const sourceNumber = parseInt(feedback.options.source)
				const tallyState = feedback.options.tallyState || 'pgm'
				const pgmActive = this.getVariableValue(`source_${sourceNumber}_pgm_destinations`)
				const pvwActive = this.getVariableValue(`source_${sourceNumber}_pvw_destinations`)
				if (tallyState === 'pgm') {
					return pgmActive && pgmActive !== 'Not active on PGM'
				} else if (tallyState === 'pvw') {
					return pvwActive && pvwActive !== 'Not active on PVW'
				}
				return false
			},
		}

		// Configurable source active feedback
		feedbacks['source_active_on_destinations'] = {
			type: 'boolean',
			name: 'Source Active on Destinations',
			description: 'Indicates if the selected source is active on the selected destinations and tally state',
			defaultStyle: {
				bgcolor: 16711680, // Red background when active (0xFF0000)
				color: 16777215, // White text (0xFFFFFF)
			},
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					choices: sourceChoices,
					default: sourceChoices.length > 0 ? sourceChoices[0].id : 1,
				},
				{
					type: 'multidropdown',
					label: 'Monitor Destinations',
					id: 'destinations',
					choices: destinationChoices,
					default: ['anywhere'],
				},
				{
					type: 'dropdown',
					label: 'Tally State',
					id: 'tallyState',
					choices: [
						{ id: 'pgm', label: 'Program' },
						{ id: 'pvw', label: 'Preview' },
					],
					default: 'pgm',
				},
			],
			callback: (feedback) => {
				const sourceNumber = parseInt(feedback.options.source)
				const destinations = feedback.options.destinations || ['anywhere']
				const tallyState = feedback.options.tallyState || 'pgm'

				// Get the source monitoring variables
				const pgmDestinations = (this.getVariableValue(`source_${sourceNumber}_pgm_destinations`) || '')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)
				const pvwDestinations = (this.getVariableValue(`source_${sourceNumber}_pvw_destinations`) || '')
					.split(',')
					.map((s) => s.trim())
					.filter(Boolean)

				for (const dest of destinations) {
					if (dest === 'anywhere') {
						if (tallyState === 'pgm' && pgmDestinations.length > 0 && pgmDestinations[0] !== 'Not active on PGM')
							return true
						if (tallyState === 'pvw' && pvwDestinations.length > 0 && pvwDestinations[0] !== 'Not active on PVW')
							return true
					} else if (dest === 'anywhere_pgm') {
						if (tallyState === 'pgm' && pgmDestinations.length > 0 && pgmDestinations[0] !== 'Not active on PGM')
							return true
					} else if (dest === 'anywhere_pvw') {
						if (tallyState === 'pvw' && pvwDestinations.length > 0 && pvwDestinations[0] !== 'Not active on PVW')
							return true
					} else if (dest.startsWith('screen_')) {
						const parts = dest.split('_')
						const screenId = parts[1]
						const mode = parts[2] // 'pgm', 'pvw', or undefined for both
						const screenName = this.eventmasterData?.ScreenDestinations?.[screenId]?.Name || `${screenId}`

						if (mode === 'pgm' && tallyState === 'pgm') {
							// Check for exact screen name match and also check for layer matches (e.g., "Screen LED MAIN L1")
							const hasScreenMatch = pgmDestinations.some(
								(pgmDest) => pgmDest === `Screen ${screenName}` || pgmDest.startsWith(`Screen ${screenName} L`),
							)
							if (hasScreenMatch) return true
						} else if (mode === 'pvw' && tallyState === 'pvw') {
							const hasScreenMatch = pvwDestinations.some(
								(pvwDest) => pvwDest === `Screen ${screenName}` || pvwDest.startsWith(`Screen ${screenName} L`),
							)
							if (hasScreenMatch) return true
						} else if (!mode) {
							// No specific mode - check both PGM and PVW
							const hasScreenMatch =
								(tallyState === 'pgm' &&
									pgmDestinations.some(
										(pgmDest) => pgmDest === `Screen ${screenName}` || pgmDest.startsWith(`Screen ${screenName} L`),
									)) ||
								(tallyState === 'pvw' &&
									pvwDestinations.some(
										(pvwDest) => pvwDest === `Screen ${screenName}` || pvwDest.startsWith(`Screen ${screenName} L`),
									))
							if (hasScreenMatch) return true
						}
					} else if (dest.startsWith('aux_')) {
						const parts = dest.split('_')
						const auxId = parts[1]
						const mode = parts[2] // 'pgm', 'pvw', or undefined for both
						const auxName = this.eventmasterData?.AuxDestinations?.[auxId]?.Name || `${auxId}`

						if (mode === 'pgm' && tallyState === 'pgm') {
							if (pgmDestinations.includes(`AUX ${auxName}`)) return true
						} else if (mode === 'pvw' && tallyState === 'pvw') {
							if (pvwDestinations.includes(`AUX ${auxName}`)) return true
						} else if (!mode) {
							// No specific mode - check both PGM and PVW based on current tally state
							if (tallyState === 'pgm' && pgmDestinations.includes(`AUX ${auxName}`)) return true
							if (tallyState === 'pvw' && pvwDestinations.includes(`AUX ${auxName}`)) return true
						}
					}
				}
				return false
			},
		}

		return feedbacks
	}
}

runEntrypoint(BarcoInstance, [])
