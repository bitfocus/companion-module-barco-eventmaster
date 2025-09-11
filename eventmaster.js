const EventMaster = require('barco-eventmaster')
const { InstanceBase, InstanceStatus, Regex, runEntrypoint } = require('@companion-module/base')
const ping = require('ping')
const getPresets = require('./presets')
const _ = require('lodash')

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
		this.setVariableDefinitions([
			{ variableId: 'frame_IP', name: 'Frame IP Address' },
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
		this.connection()
		this.log(`debug`, 'creating eventmaster')
	}

	async configUpdated(config) {
		this.config = config
		this.connection()
	}

	connection() {
		if (this.config) {
			ping.promise.probe(this.config.host).then((res) => {
				if (res.alive) {
					this.log(`debug`, 'ping ok')
					this.initEventmaster()
				} else {
					this.log(`debug`, 'ping failed')
					this.updateStatus(InstanceStatus.Connecting, 'No ping response')
					this.retry_interval = setInterval(() => {
						ping.promise.probe(this.config.host).then((res) => {
							if (res.alive) {
								this.log(`debug`, 'ping ok')
								this.initEventmaster()
							} else {
								this.log(`debug`, 'ping failed')
								this.updateStatus(InstanceStatus.Connecting, 'No ping response')
							}
						})
					}, 5000)
				}
			})
		}
	}

	// initEventmasterListener() {
		
	// 	// Start server to receive notifications
	// 	this.eventmaster.startNotificationServer(3004, (notification) => {
	// 		if(notification.result.method === 'notification' && notification.result.notificationType === 'ScreenDestChanged') {
	// 			const update = JSON.stringify(notification.result.change.update)
	// 			// this.log('info', `Screen Destination Changed: ${update}`)
	// 		}
	// 	})
		
	// 	this.eventmaster.listContent({id: 1 }, (err, res) => {
	// 		if (err) {
	// 			this.log('error', 'EventMaster Error: ' + err)
	// 		} else {
	// 			this.log('info', `Screen Destination Changed result: ${JSON.stringify(res)}`)
	// 		}
	// 	})

	// 	// Subscribe to notifications
	// 	this.eventmaster.unsubscribe("172.16.25.235", 3004, ['ScreenDestChanged', 'AUXDestChanged'], (err, result) => {
	// 		if (err) {
	// 			console.error('Subscribe error:', err)
	// 		} else {
	// 			console.log('Subscribed:', result)
	// 		}
	// 	})
	// 	// Subscribe to notifications
	// 	this.eventmaster.subscribe("172.16.25.235", 3004, ['ScreenDestChanged', 'AUXDestChanged'], (err, result) => {
	// 		if (err) {
	// 			console.error('Subscribe error:', err)
	// 		} else {
	// 			console.log('Subscribed:', result)
	// 		}
	// 	})
	// }

	initEventmaster() {
		console.log('Connecting to EventMaster at', this.config.host)
		this.eventmaster = new EventMaster(this.config.host)
		console.log('EventMaster instance created:', this.eventmaster)
		// this.initEventmasterListener()
		this.updateStatus(InstanceStatus.Ok)
		this.getAllDataFromEventmaster().then(() => {
			this.setActionDefinitions(this.getActions())
			this.setFeedbackDefinitions(this.getFeedbacks())
			this.setPresetDefinitions(getPresets(this.eventmasterData))

			this.eventmasterPoller()
		})
		if (this.retry_interval) clearInterval(this.retry_interval)
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
				if (res.response && res.response.System && res.response.System.FrameCollection && res.response.System.FrameCollection.Frame) {
					// Frame is a single object, not an array
					frameData = res.response.System.FrameCollection.Frame
				}
				
				if (frameData) {
					// Extract the basic frame data
					const frameIP = frameData.Enet?.IP || this.config.host || 'Unknown'
					const version = frameData.Version || 'Unknown'
					const osVersion = frameData.OSVersion || 'Unknown'
					
					this.eventmasterData.frameIP = frameIP
					this.eventmasterData.version = version
					this.eventmasterData.OSVersion = osVersion
					
					// Start with basic variables
					const variableValues = {
						frame_IP: frameIP,
						frame_version: version,
						frame_OSVersion: osVersion,
					}
					
					// Build dynamic variable definitions including card slots
					const variableDefinitions = [
						{ variableId: 'frame_IP', name: 'Frame IP Address' },
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
								variableDefinitions.push(
									{ variableId: `card${slotNum}_info`, name: `Card ${slotNum} Information` }
								)
								
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
						variableDefinitions.push(
							{ variableId: 'syscard_info', name: 'System Card Information' }
						)
						
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
					
					// Update variable definitions dynamically
					this.setVariableDefinitions(variableDefinitions)
					
					// Set all variable values
					this.setVariableValues(variableValues)
					
					this.log('debug', `Frame Settings Updated: IP=${frameIP}, Version=${version}, OS=${osVersion}`)
					if (frameData.Slot) {
						this.log('debug', `Found ${frameData.Slot.length} card slots`)
					}
				} else {
					this.log('warning', 'Frame settings data structure not recognized')
				}
			} catch (err) {
				this.log('error', 'EventMaster Frame Settings Error: ' + err)
				// Set fallback values
				this.setVariableValues({
					frame_IP: this.config.host || 'Unknown',
					frame_version: 'Error fetching',
					frame_OSVersion: 'Error fetching',
				})
			}
		}
	}
	// Polling function to keep data updated
	eventmasterPoller() {
		if (this.config) {
			if (this.config.pollingInterval === 0) {
				if (this.polling_interval) clearInterval(this.polling_interval)
			} else {
				this.polling_interval = setInterval(
					() => {
						this.getAllDataFromEventmaster().then(() => {
							this.setActionDefinitions(this.getActions())
							this.setFeedbackDefinitions(this.getFeedbacks())
							this.setPresetDefinitions(getPresets(this.eventmasterData))
						})
					},
					Math.ceil(this.config.pollingInterval * 1000) || 15000
				)
			}
		}
	}

	getConfigFields() {
		return [
			{
				type: 'static-text',
				id: 'info',
				width: 12,
				label: 'Information',
				value:
					'This module uses the official EventMaster JSON API. If the status is OK, it ONLY means that the IP configured answers on icmp ping. The module will update presets and actions every 15 seconds ',
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
				label: 'Polling Interval (in seconds) for presets and actions (type 0 to disable)',
				width: 6,
				default: 15,
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
				this.eventmasterData.presets = this.convertArrayToObject(res.response, 'presetSno')
				
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
				this.eventmasterData.sources = this.convertArrayToObject(res.response, 'Name')
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
				this.eventmasterData.cues = this.convertArrayToObject(res.response)
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
				this.eventmasterData.userKeys = this.convertArrayToObject(res.response)
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
				this.eventmasterData.ScreenDestinations = this.convertArrayToObject(res.response.ScreenDestination, 'Name')
				this.eventmasterData.AuxDestinations = this.convertArrayToObject(res.response.AuxDestination, 'Name')
				this.eventmasterData.SuperDestinations = this.convertArrayToObject(res.response.SuperDestination, 'Name')
				this.eventmasterData.SuperAuxDestinations = this.convertArrayToObject(res.response.SuperAux, 'Name')
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
				const key = Object.keys(res.response)[0]
				this.setVariableValues({
					power_status1: this.powerStatus[parseInt(res.response[key].PowerSupply1Status)],
					power_status2: this.powerStatus[parseInt(res.response[key].PowerSupply2Status)],
				})
			} catch (err) {
				this.log('error', 'EventMaster Power Status Error: ' + err)
			}
		}
	}

	async getAllDataFromEventmaster() {
		console.log('Fetching all data from EventMaster...')
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
		const variables = this.frameVariableDefinitions.length > 0 
			? [...this.frameVariableDefinitions] 
			: [
				{ variableId: 'frame_IP', name: 'Frame IP Address' },
				{ variableId: 'frame_version', name: 'Frame Version' },
				{ variableId: 'frame_OSVersion', name: 'Frame OS Version' },
				{ variableId: 'power_status1', name: 'Power Supply 1 Status' },
				{ variableId: 'power_status2', name: 'Power Supply 2 Status' },
			]

		// Add source monitoring variables - show which destinations each source is active on
		if (this.eventmasterData && this.eventmasterData.sources) {
			Object.values(this.eventmasterData.sources).forEach(source => {
				variables.push({ 
					variableId: `source_${source.id + 1}_name`, 
					name: `Source ${source.id + 1} Name` 
				})
				variables.push({ 
					variableId: `source_${source.id + 1}_pgm_destinations`, 
					name: `${source.Name} - PGM Destinations` 
				})
				variables.push({ 
					variableId: `source_${source.id + 1}_pvw_destinations`, 
					name: `${source.Name} - PVW Destinations` 
				})
				variables.push({ 
					variableId: `source_${source.id + 1}_is_active`, 
					name: `${source.Name} - Is Active (PGM or PVW)` 
				})
			})
		}

		// Add preset name variables
		if (this.eventmasterData && this.eventmasterData.presets) {
			Object.values(this.eventmasterData.presets).forEach(preset => {
				variables.push({ 
					variableId: `preset_${preset.id}_name`, 
					name: `Preset ${preset.presetSno || preset.id} Name` 
				})
				variables.push({ 
					variableId: `preset_${preset.id}_number`, 
					name: `Preset ${preset.presetSno || preset.id} Number` 
				})
			})
		}

		// Add screen destination name variables
		if (this.eventmasterData && this.eventmasterData.ScreenDestinations) {
			Object.values(this.eventmasterData.ScreenDestinations).forEach(screen => {
				variables.push({ 
					variableId: `screen_${screen.id}_name`, 
					name: `Screen ${screen.id} Name` 
				})
			})
		}

		// Add AUX destination name variables
		if (this.eventmasterData && this.eventmasterData.AuxDestinations) {
			Object.values(this.eventmasterData.AuxDestinations).forEach(aux => {
				variables.push({ 
					variableId: `aux_${aux.id}_name`, 
					name: `AUX ${aux.id} Name` 
				})
			})
		}

		this.setVariableDefinitions(variables)
		
		// Clear variable tracking since setVariableDefinitions resets all values
		this.previousVariableValues = {}
		
		// Auto-populate source monitoring variables
		this.autoPopulateSourceMonitoring()
	}

	/**
	 * Auto-populate source monitoring variables by querying all destinations
	 * Shows which destinations each source is active on
	 */
	async autoPopulateSourceMonitoring() {
		this.log('debug', 'Starting source monitoring auto-population...')
		
		// Check if EventMaster is connected
		if (!this.eventmaster) {
			this.log('warning', 'EventMaster not connected, skipping source monitoring')
			return
		}
		
		// Initialize or retrieve previous variable values for change tracking
		if (!this.previousVariableValues) {
			this.previousVariableValues = {}
		}
		
		// Initialize source tracking objects
		const sourcePgmDestinations = {}
		const sourcePvwDestinations = {}
		
		// Initialize all sources with empty arrays
		if (this.eventmasterData && this.eventmasterData.sources) {
			Object.values(this.eventmasterData.sources).forEach(source => {
				sourcePgmDestinations[source.id] = []
				sourcePvwDestinations[source.id] = []
			})
			// this.log('debug', `Initialized tracking for ${Object.keys(sourcePgmDestinations).length} sources`)
		} else {
			this.log('warning', 'No sources available for monitoring')
			return
		}

		// Query all screen destinations to see what sources are active
		if (this.eventmasterData && this.eventmasterData.ScreenDestinations) {
			this.log('debug', `Querying ${Object.keys(this.eventmasterData.ScreenDestinations).length} screen destinations...`)
			
			for (const dest of Object.values(this.eventmasterData.ScreenDestinations)) {
				try {
					// this.log('debug', `Querying screen destination ${dest.id} (${dest.Name})...`)
					
					const res = await new Promise((resolve, reject) => {
						this.eventmaster.listContent(parseInt(dest.id), (err, result) => {
							if (err) reject(err)
							else resolve(result)
						})
					})
					
					if (res && res.response) {
						const content = res.response
						// Removed excessive debug logging for cleaner output
						
						// Check background layers for PGM (id 0 = PGM background)
						if (content.BGLyr && content.BGLyr.length > 0) {
							// this.log('debug', `Screen ${dest.id} has ${content.BGLyr.length} background layers`)
							
							const pgmBgLayer = content.BGLyr.find(layer => layer.id === 0)
							if (pgmBgLayer && pgmBgLayer.LastBGSourceIndex !== undefined && pgmBgLayer.LastBGSourceIndex !== -1) {
								const sourceId = pgmBgLayer.LastBGSourceIndex
								if (sourcePgmDestinations[sourceId]) {
									sourcePgmDestinations[sourceId].push(`Screen ${dest.Name}`)
									this.log('debug', `Screen ${dest.Name}: PGM background = Source ${sourceId + 1}`)
								}
							}
							
							// Check for PVW background (id 1 = PVW background)
							const pvwBgLayer = content.BGLyr.find(layer => layer.id === 1)
							if (pvwBgLayer && pvwBgLayer.LastBGSourceIndex !== undefined && pvwBgLayer.LastBGSourceIndex !== -1) {
								const sourceId = pvwBgLayer.LastBGSourceIndex
								if (sourcePvwDestinations[sourceId]) {
									sourcePvwDestinations[sourceId].push(`Screen ${dest.Name}`)
									this.log('debug', `Screen ${dest.Name}: PVW background = Source ${sourceId + 1}`)
								}
							}
						}
						
						// Check active layers
						if (content.Layers && content.Layers.length > 0) {
							// this.log('debug', `Screen ${dest.id} has ${content.Layers.length} layers`)
							
							content.Layers.forEach(layer => {
								// Check if layer is on PGM
								if (layer.PgmMode !== undefined && layer.PgmMode > 0 && 
									layer.SrcIdx !== undefined && layer.SrcIdx !== -1 && 
									layer.Freeze !== undefined && layer.Freeze === 0) {
									
									const sourceId = layer.SrcIdx
									if (sourcePgmDestinations[sourceId]) {
										sourcePgmDestinations[sourceId].push(`Screen ${dest.Name} L${layer.id}`)
										this.log('debug', `Screen ${dest.Name} Layer ${layer.id}: ACTIVE PGM = Source ${sourceId + 1}`)
									}
								}
								
								// Check if layer is on PVW
								if (layer.PvwMode !== undefined && layer.PvwMode > 0 && 
									layer.SrcIdx !== undefined && layer.SrcIdx !== -1 && 
									layer.Freeze !== undefined && layer.Freeze === 0) {
									
									const sourceId = layer.SrcIdx
									if (sourcePvwDestinations[sourceId]) {
										sourcePvwDestinations[sourceId].push(`Screen ${dest.Name} L${layer.id}`)
										this.log('debug', `Screen ${dest.Name} Layer ${layer.id}: ACTIVE PVW = Source ${sourceId + 1}`)
									}
								}
								
								// Only log inactive layers if you need detailed debugging
								// if ((layer.PgmMode === 0 && layer.PvwMode === 0) || layer.Freeze > 0) {
								//     this.log('debug', `Screen ${dest.Name} Layer ${layer.id}: INACTIVE (PgmMode: ${layer.PgmMode}, PvwMode: ${layer.PvwMode}, Freeze: ${layer.Freeze}) - Source: ${layer.SrcIdx + 1}`)
								// }
							})
						}
					} else {
						this.log('warning', `No response data for screen destination ${dest.id}`)
					}
				} catch (err) {
					this.log('error', `Could not get content for screen destination ${dest.id}: ${err}`)
				}
			}
		}

		// Query all AUX destinations
		if (this.eventmasterData && this.eventmasterData.AuxDestinations) {
			// this.log('debug', `Querying ${Object.keys(this.eventmasterData.AuxDestinations).length} AUX destinations...`)
			
			for (const dest of Object.values(this.eventmasterData.AuxDestinations)) {
				try {
					// this.log('debug', `Querying AUX destination ${dest.id} (${dest.Name})...`)
					
					const res = await new Promise((resolve, reject) => {
						this.eventmaster.listAuxContent(parseInt(dest.id), (err, result) => {
							if (err) reject(err)
							else resolve(result)
						})
					})
					
					if (res && res.response) {
						const auxContent = res.response
						// this.log('debug', `AUX ${dest.id} content structure: ${JSON.stringify(Object.keys(auxContent))}`)
						
						// Check PGM source
						if (auxContent.PgmLastSrcIndex !== undefined) {
							const sourceId = auxContent.PgmLastSrcIndex
							if (sourcePgmDestinations[sourceId]) {
								sourcePgmDestinations[sourceId].push(`AUX ${dest.Name}`)
								// this.log('debug', `AUX ${dest.Name}: PGM = Source ${sourceId}`)
							}
						}
						
						// Check PVW source
						if (auxContent.PvwLastSrcIndex !== undefined) {
							const sourceId = auxContent.PvwLastSrcIndex
							if (sourcePvwDestinations[sourceId]) {
								sourcePvwDestinations[sourceId].push(`AUX ${dest.Name}`)
								// this.log('debug', `AUX ${dest.Name}: PVW = Source ${sourceId}`)
							}
						}
					} else {
						this.log('warning', `No response data for AUX destination ${dest.id}`)
					}
				} catch (err) {
					this.log('error', `Could not get content for AUX destination ${dest.id}: ${err}`)
				}
			}
		}

		// Set variable values for all sources
		const variableValues = {}
		const changedVariables = {}
		let activeSources = 0
		
		if (this.eventmasterData && this.eventmasterData.sources) {
			Object.values(this.eventmasterData.sources).forEach(source => {
				const pgmDests = sourcePgmDestinations[source.id] || []
				const pvwDests = sourcePvwDestinations[source.id] || []
				const isActive = pgmDests.length > 0 || pvwDests.length > 0
				
				// Calculate new values
				const newValues = {
					[`source_${source.id + 1}_name`]: source.Name || `Source ${source.id + 1}`,
					[`source_${source.id + 1}_pgm_destinations`]: pgmDests.length > 0 
						? pgmDests.join(', ') 
						: 'Not active on PGM',
					[`source_${source.id + 1}_pvw_destinations`]: pvwDests.length > 0 
						? pvwDests.join(', ') 
						: 'Not active on PVW',
					[`source_${source.id + 1}_is_active`]: isActive ? 'Yes' : 'No'
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
					// Only log active sources to reduce noise
					// this.log('debug', `Source ${source.id + 1} (${source.Name}): PGM=[${pgmDests.join(', ')}], PVW=[${pvwDests.join(', ')}] - Active: ${isActive ? 'Yes' : 'No'}`)
				}
			})
		}
		
		// Set preset name variables
		if (this.eventmasterData && this.eventmasterData.presets) {
			Object.values(this.eventmasterData.presets).forEach(preset => {
				const newValues = {
					[`preset_${preset.id}_name`]: preset.Name ? _.unescape(preset.Name) : `Preset ${preset.id}`,
					[`preset_${preset.id}_number`]: preset.presetSno || preset.id || '?'
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
			Object.values(this.eventmasterData.ScreenDestinations).forEach(screen => {
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
			Object.values(this.eventmasterData.AuxDestinations).forEach(aux => {
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
			this.log('debug', `Updated ${Object.keys(changedVariables).length} changed variables`)
		} else {
			this.log('debug', 'No variable changes detected, skipping update')
		}
		
		// Update feedbacks to reflect current source activity
		this.checkFeedbacks()
		
		this.log('info', `Source monitoring updated: ${activeSources} sources have active destinations`)
	}

	/**
	 * Helper method to find source name by ID
	 * @param {number} sourceId - The source ID to look up
	 * @returns {string} - The source name or "Unknown Source (ID)"
	 */
	findSourceNameById(sourceId) {
		if (this.eventmasterData && this.eventmasterData.sources) {
			const source = Object.values(this.eventmasterData.sources).find(src => src.id === sourceId)
			if (source) {
				return source.Name
			}
		}
		return `Unknown Source (${sourceId})`
	}

	getActions() {
		const actions = {}

		const CHOICES_PRESETS = Object.values(this.eventmasterData.presets)
			.sort((a, b) => (a.presetSno || a.id) - (b.presetSno || b.id))  // Sort by presetSno (GUI order)
			.map((preset) => ({
				label: `${preset.presetSno || preset.id} ${_.unescape(preset.Name)}`,
				id: preset.id,
			}))
		const CHOICES_SOURCES = Object.values(this.eventmasterData.sources).map((source) => ({
			label: source.Name,
			id: source.id + 1000, // Offset to avoid conflict with 0, -1, and empty string
			actualSourceId: source.id, // Keep the real source ID for later use
			InputCfgIndex: source.InputCfgIndex,
			SrcType: source.SrcType,
			StillIndex: source.StillIndex,
		}))
		const CHOICES_CUES = Object.values(this.eventmasterData.cues).map((cue) => ({
			label: cue.Name,
			id: cue.id,
		}))
		const CHOICES_USERKEYS = Object.values(this.eventmasterData.userKeys).map((key) => ({
			label: key.Name,
			id: key.id,
		}))
		const CHOICES_SCREENDESTINATIONS = Object.values(this.eventmasterData.ScreenDestinations)
			.sort((a, b) => a.id - b.id)  // Sort by ID to ensure consistent ordering
			.map((dest) => ({
				label: dest.Name,
				id: dest.id,
			}))
		const CHOICES_AUXDESTINATIONS = Object.values(this.eventmasterData.AuxDestinations)
			.sort((a, b) => a.id - b.id)  // Sort by ID to ensure consistent ordering
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
				console.log('Recalling Preset with params:', params)
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
					default: '0',
				},
			],
			callback: (action) => {
				const params = {
					type: 0, // 0 type is source
					id: parseInt(action.options.frzSource),
					Screengroup: 0, // 0 for all screengroups
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
					choices: [
						{ id: '', label: 'No Change' }, 
						{ id: -1, label: 'Clear Source' },
						...CHOICES_SOURCES
					],
					default: '',
				},
				{
					type: 'dropdown',
					label: 'Program Source',
					id: 'pgmSource',
					choices: [
						{ id: '', label: 'No Change' }, 
						{ id: -1, label: 'Clear Source' },
						...CHOICES_SOURCES
					],
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

				this.log('debug', `changeAuxContent params: ${JSON.stringify(params)}`)
				
				// Debug: log available source indices
				if (this.eventmasterData && this.eventmasterData.sources) {
					const sourceIds = Object.values(this.eventmasterData.sources).map(s => s.id)
					this.log('debug', `Available source indices: ${JSON.stringify(sourceIds)}`)
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
				if (action.options.pgmBgSource && action.options.pgmBgSource !== '') {
					bgLayers.push({
						id: 0,
						LastBGSourceIndex: parseInt(action.options.pgmBgSource),
						BGShowMatte: action.options.pgmBgMatte ? 1 : 0,
						BGColor: [{ id: 0, Red: 0, Green: 0, Blue: 0 }],
					})
					hasBgChanges = true
				}

				// Preview background (id: 1)
				if (action.options.pvwBgSource && action.options.pvwBgSource !== '') {
					bgLayers.push({
						id: 1,
						LastBGSourceIndex: parseInt(action.options.pvwBgSource),
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
					(action.options.layerSource !== '' || action.options.layerMode !== '' || 
					 action.options.winHPos !== '' || action.options.winVPos !== '' ||
					 action.options.winHSize !== '' || action.options.winVSize !== '')
				) {
					const layer = {
						id: parseInt(action.options.layerId) || 0,
					}

					// Set layer source
					if (action.options.layerSource && action.options.layerSource !== '') {
						layer.LastSrcIdx = parseInt(action.options.layerSource)
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
						action.options.winHPos !== '' || action.options.winVPos !== '' ||
						action.options.winHSize !== '' || action.options.winVSize !== ''
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
		actions['power_status'] = {
			name: 'Get Power Status',
			options: [],
			callback: () => {
				this.eventmaster.powerStatus((err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else {
						this.log('debug', 'powerStatus response: ' + JSON.stringify(res))
						const key = Object.keys(res.response)[0]
						this.setVariableValues({
							power_status1: this.powerStatus[parseInt(res.response[key].PowerSupply1Status)],
							power_status2: this.powerStatus[parseInt(res.response[key].PowerSupply2Status)],
						})
					}
				})
			},
		}

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
		actions['list_operators'] = {
			name: 'List Operators',
			options: [],
			callback: () => {
				this.eventmaster.listOperators((err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'listOperators response: ' + JSON.stringify(res))
				})
			},
		}

		// List MVR Presets ***NEW API
		actions['list_mvr_presets'] = {
			name: 'List MVR Presets',
			options: [],
			callback: () => {
				this.eventmaster.listMvrPreset({ id: -1 }, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'listMvrPreset response: ' + JSON.stringify(res))
				})
			},
		}
		actions['getFrameSettings'] = {
			name: 'Get Frame Settings',
			options: [],
			callback: () => {
				this.eventmaster.getFrameSettings({}, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else {
						console.log('Frame Settings Action Response:', JSON.stringify(res, null, 2))
						
						// Parse the correct structure
						let frameData = null
						if (res.response && res.response.System && res.response.System.FrameCollection && res.response.System.FrameCollection.Frame) {
							// Frame is a single object, not an array
							frameData = res.response.System.FrameCollection.Frame
						}
						
						if (frameData) {
							const frameIP = frameData.Enet?.IP || this.config.host || 'Unknown'
							const version = frameData.Version || 'Unknown'
							const osVersion = frameData.OSVersion || 'Unknown'
							
							this.eventmasterData.frameIP = frameIP
							this.eventmasterData.version = version
							this.eventmasterData.OSVersion = osVersion
							
							// Start with basic variables
							const variableValues = {
								frame_IP: frameIP,
								frame_version: version,
								frame_OSVersion: osVersion,
							}
							
							// Process card slots if they exist
							if (frameData.Slot && Array.isArray(frameData.Slot)) {
								frameData.Slot.forEach((slot, index) => {
									if (slot.Card) {
										const slotNum = index + 1
										const card = slot.Card
										
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
							
							// Add SysCard information if available
							if (frameData.SysCard) {
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
							
							this.setVariableValues(variableValues)
							
							this.log('debug', `Frame Settings Action: IP=${frameIP}, Version=${version}, OS=${osVersion}`)
						}
					}
				})
			},
		}

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
				console.log('Arm/Unarm Destination with params:', JSON.stringify(params))
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
				console.log('Arm/Unarm AUX Destination with params:', JSON.stringify(params))
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
		actions['list_source_main_backup'] = {
			name: 'List Source Main Backup',
			options: [
				{
					type: 'dropdown',
					label: 'Input Type',
					id: 'inputType',
					choices: [
						{ id: -1, label: 'All (Inputs + Background)' },
						{ id: 0, label: 'Inputs Only' },
						{ id: 1, label: 'Background Only' },
					],
					default: -1,
				},
			],
			callback: (action) => {
				const params = {
					inputType: parseInt(action.options.inputType),
				}
				this.eventmaster.listSourceMainBackup(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'listSourceMainBackup response: ' + JSON.stringify(res))
				})
			},
		}

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
					label: 'Backup 1 Source Type',
					id: 'backup1SrcType',
					choices: [
						{ id: 0, label: 'Input' },
						{ id: 1, label: 'Still' },
					],
					default: 0,
				},
				{
					type: 'dropdown',
					label: 'Backup 1 Source',
					id: 'backup1SourceId',
					choices: CHOICES_SOURCES,
				},
				{
					type: 'dropdown',
					label: 'Backup 2 Source Type',
					id: 'backup2SrcType',
					choices: [
						{ id: 0, label: 'Input' },
						{ id: 1, label: 'Still' },
					],
					default: 0,
				},
				{
					type: 'dropdown',
					label: 'Backup 2 Source',
					id: 'backup2SourceId',
					choices: CHOICES_SOURCES,
				},
				{
					type: 'dropdown',
					label: 'Backup 3 Source Type',
					id: 'backup3SrcType',
					choices: [
						{ id: 0, label: 'Input' },
						{ id: 1, label: 'Still' },
					],
					default: 0,
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
						{ id: 1, label: 'Backup 1' },
						{ id: 2, label: 'Backup 2' },
						{ id: 3, label: 'Backup 3' },
					],
					default: -1,
				},
			],
			callback: (action) => {
				const params = {
					inputId: parseInt(action.options.inputId),
					Backup1: {
						SrcType: parseInt(action.options.backup1SrcType),
						SourceId: parseInt(action.options.backup1SourceId),
					},
					Backup2: {
						SrcType: parseInt(action.options.backup2SrcType),
						SourceId: parseInt(action.options.backup2SourceId),
					},
					Backup3: {
						SrcType: parseInt(action.options.backup3SrcType),
						SourceId: parseInt(action.options.backup3SourceId),
					},
					BackUpState: parseInt(action.options.backupState),
				}
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
				const params = {
					id: parseInt(action.options.sourceId),
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
				this.autoPopulateSourceMonitoring().then(() => {
					this.log('info', 'Source monitoring variables refreshed')
				}).catch(err => {
					this.log('error', 'Error refreshing source monitoring: ' + err)
				})
			},
		}

		// List Screen Destination Content (Get Active PGM Source)
		actions['list_screen_content'] = {
			name: 'List Screen Destination Content',
			options: [
				{
					type: 'dropdown',
					label: 'Screen Destination',
					id: 'screenId',
					choices: CHOICES_SCREENDESTINATIONS,
				},
			],
			callback: (action) => {
				this.eventmaster.listContent(parseInt(action.options.screenId), (err, res) => {
					if (err) {
						this.log('error', 'EventMaster Error: ' + err)
					} else {
						this.log('debug', 'listContent response: ' + JSON.stringify(res))
						
						// Display information about this destination
						if (res && res.response) {
							const content = res.response
							let pgmInfo = []
							let pvwInfo = []
							
							// Check background layers
							if (content.BGLayers && content.BGLayers.length > 0) {
								const pgmBgLayer = content.BGLayers.find(layer => layer.id === 0)
								if (pgmBgLayer && pgmBgLayer.LastBGSourceIndex !== undefined) {
									const sourceName = this.findSourceNameById(pgmBgLayer.LastBGSourceIndex)
									pgmInfo.push(`Background: ${sourceName}`)
								}
								
								const pvwBgLayer = content.BGLayers.find(layer => layer.id === 1)
								if (pvwBgLayer && pvwBgLayer.LastBGSourceIndex !== undefined) {
									const sourceName = this.findSourceNameById(pvwBgLayer.LastBGSourceIndex)
									pvwInfo.push(`Background: ${sourceName}`)
								}
							}
							
							// Check active layers
							if (content.Layers && content.Layers.length > 0) {
								content.Layers.forEach(layer => {
									if (layer.LastSrcIndex !== undefined) {
										const sourceName = this.findSourceNameById(layer.LastSrcIndex)
										pgmInfo.push(`Layer ${layer.id}: ${sourceName}`)
									}
									if (layer.PvwLastSrcIndex !== undefined) {
										const sourceName = this.findSourceNameById(layer.PvwLastSrcIndex)
										pvwInfo.push(`Layer ${layer.id}: ${sourceName}`)
									}
								})
							}
							
							const pgmSummary = pgmInfo.length > 0 ? pgmInfo.join(', ') : 'No PGM content'
							const pvwSummary = pvwInfo.length > 0 ? pvwInfo.join(', ') : 'No PVW content'
							
							this.log('info', `Screen ${action.options.screenId} - PGM: ${pgmSummary} | PVW: ${pvwSummary}`)
						}
						
						// Refresh source monitoring after checking this destination
						this.autoPopulateSourceMonitoring()
					}
				})
			},
		}

		// List AUX Destination Content (Get Active PGM Source)
		actions['list_aux_content'] = {
			name: 'List AUX Destination Content',
			options: [
				{
					type: 'dropdown',
					label: 'AUX Destination',
					id: 'auxId',
					choices: CHOICES_AUXDESTINATIONS,
				},
			],
			callback: (action) => {
				this.eventmaster.listAuxContent(parseInt(action.options.auxId), (err, res) => {
					if (err) {
						this.log('error', 'EventMaster Error: ' + err)
					} else {
						this.log('debug', 'listAuxContent response: ' + JSON.stringify(res))
						
						// Display information about this AUX destination
						if (res && res.response) {
							const auxContent = res.response
							let pgmSourceInfo = 'No PGM source'
							let pvwSourceInfo = 'No PVW source'
							
							if (auxContent.PgmLastSrcIndex !== undefined) {
								const sourceName = this.findSourceNameById(auxContent.PgmLastSrcIndex)
								pgmSourceInfo = `${sourceName} (ID: ${auxContent.PgmLastSrcIndex})`
							}
							
							if (auxContent.PvwLastSrcIndex !== undefined) {
								const sourceName = this.findSourceNameById(auxContent.PvwLastSrcIndex)
								pvwSourceInfo = `${sourceName} (ID: ${auxContent.PvwLastSrcIndex})`
							}
							
							this.log('info', `AUX ${action.options.auxId} - PGM: ${pgmSourceInfo} | PVW: ${pvwSourceInfo}`)
						}
						
						// Refresh source monitoring after checking this destination
						this.autoPopulateSourceMonitoring()
					}
				})
			},
		}

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
			Object.values(this.eventmasterData.ScreenDestinations).forEach(screen => {
				destinationChoices.push(
					{ id: `screen_${screen.id}_pgm`, label: `${screen.Name} PGM` },
					{ id: `screen_${screen.id}_pvw`, label: `${screen.Name} PVW` },
					{ id: `screen_${screen.id}`, label: `${screen.Name} (PGM or PVW)` }
				)
			})
		}

		// Add AUX destinations
		if (this.eventmasterData && this.eventmasterData.AuxDestinations) {
			Object.values(this.eventmasterData.AuxDestinations).forEach(aux => {
				destinationChoices.push(
					{ id: `aux_${aux.id}_pgm`, label: `AUX ${aux.Name} PGM` },
					{ id: `aux_${aux.id}_pvw`, label: `AUX ${aux.Name} PVW` },
					{ id: `aux_${aux.id}`, label: `AUX ${aux.Name} (PGM or PVW)` }
				)
			})
		}

		// Create source choices for the feedback options
		const sourceChoices = []
		if (this.eventmasterData && this.eventmasterData.sources) {
			Object.values(this.eventmasterData.sources).forEach(source => {
				sourceChoices.push({
					id: source.id + 1, // Convert to 1-based for display
					label: `${source.id + 1}: ${source.Name}`
				})
			})
		}

		// Simple source active feedback for status presets
		feedbacks['source_active_simple'] = {
			type: 'boolean',
			name: 'Source Active (Simple)',
			description: 'Simple indicator if source is active anywhere',
			defaultStyle: {
				bgcolor: 16711680, // Red background when active (0xFF0000)
				color: 16777215 // White text (0xFFFFFF)
			},
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					choices: sourceChoices,
					default: sourceChoices.length > 0 ? sourceChoices[0].id : 1
				}
			],
			callback: (feedback) => {
				const sourceNumber = parseInt(feedback.options.source)
				const isActive = this.getVariableValue(`source_${sourceNumber}_is_active`)
				return isActive === 'Yes'
			}
		}

		// Configurable source active feedback
		feedbacks['source_active_on_destinations'] = {
			type: 'boolean',
			name: 'Source Active on Destinations',
			description: 'Indicates if the selected source is active on the selected destinations',
			defaultStyle: {
				bgcolor: 16711680, // Red background when active (0xFF0000)
				color: 16777215 // White text (0xFFFFFF)
			},
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					choices: sourceChoices,
					default: sourceChoices.length > 0 ? sourceChoices[0].id : 1
				},
				{
					type: 'multidropdown',
					label: 'Monitor Destinations',
					id: 'destinations',
					choices: destinationChoices,
					default: ['anywhere']
				}
			],
			callback: (feedback) => {
				const sourceNumber = parseInt(feedback.options.source)
				const destinations = feedback.options.destinations || ['anywhere']
				
				// Get the source monitoring variables
				const pgmDestinations = this.getVariableValue(`source_${sourceNumber}_pgm_destinations`) || ''
				const pvwDestinations = this.getVariableValue(`source_${sourceNumber}_pvw_destinations`) || ''
				
				// Check each selected destination
				for (const dest of destinations) {
					if (dest === 'anywhere') {
						// Check if source is active anywhere
						const isActive = this.getVariableValue(`source_${sourceNumber}_is_active`)
						if (isActive === 'Yes') return true
					} else if (dest === 'anywhere_pgm') {
						// Check if source is active on any PGM
						if (pgmDestinations && pgmDestinations !== 'Not active on PGM') return true
					} else if (dest === 'anywhere_pvw') {
						// Check if source is active on any PVW
						if (pvwDestinations && pvwDestinations !== 'Not active on PVW') return true
					} else if (dest.startsWith('screen_')) {
						// Check specific screen destination
						const parts = dest.split('_')
						const screenId = parts[1]
						const mode = parts[2] // 'pgm', 'pvw', or undefined for both
						
						if (mode === 'pgm') {
							if (pgmDestinations.includes(`Screen `) && pgmDestinations.includes(`${screenId}`)) return true
						} else if (mode === 'pvw') {
							if (pvwDestinations.includes(`Screen `) && pvwDestinations.includes(`${screenId}`)) return true
						} else {
							// Check both PGM and PVW
							if ((pgmDestinations.includes(`Screen `) && pgmDestinations.includes(`${screenId}`)) ||
								(pvwDestinations.includes(`Screen `) && pvwDestinations.includes(`${screenId}`))) return true
						}
					} else if (dest.startsWith('aux_')) {
						// Check specific AUX destination
						const parts = dest.split('_')
						const auxId = parts[1]
						const mode = parts[2] // 'pgm', 'pvw', or undefined for both
						
						// Find the AUX name
						const aux = this.eventmasterData?.AuxDestinations ? 
							Object.values(this.eventmasterData.AuxDestinations).find(a => a.id == auxId) : null
						const auxName = aux ? aux.Name : `AUX ${auxId}`
						
						if (mode === 'pgm') {
							if (pgmDestinations.includes(`AUX ${auxName}`)) return true
						} else if (mode === 'pvw') {
							if (pvwDestinations.includes(`AUX ${auxName}`)) return true
						} else {
							// Check both PGM and PVW
							if (pgmDestinations.includes(`AUX ${auxName}`) || pvwDestinations.includes(`AUX ${auxName}`)) return true
						}
					}
				}
				
				return false
			}
		}

		return feedbacks
	}
}

runEntrypoint(BarcoInstance, [])
