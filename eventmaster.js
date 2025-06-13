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
		this.getFrameSettings()
		this.getAllDataFromEventmaster().then(() => {
			this.setActionDefinitions(this.getActions())
			this.setPresetDefinitions(getPresets(this.eventmasterData))

			this.eventmasterPoller()
		})
		if (this.retry_interval) clearInterval(this.retry_interval)
	}

	getFrameSettings() {
		this.eventmaster.getFrameSettings({}, (err, res) => {
			if (err) this.log('error', 'EventMaster Error: ' + err)
			else {
				this.eventmasterData.frameIP = res.response.System.FrameCollection.Frame[0].Enet.IP
				this.eventmasterData.version = res.response.System.FrameCollection.Frame[0].Version
				this.eventmasterData.OSVersion = res.response.System.FrameCollection.Frame[0].OSVersion
				this.setVariableValues({
					frame_IP: this.eventmasterData.frameIP,
					frame_version: this.eventmasterData.version,
					frame_OSVersion: this.eventmasterData.OSVersion,
				})
			}
		})
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
				this.eventmasterData.ScreenDestinations = this.convertArrayToObject(res.response.ScreenDestination)
				this.eventmasterData.AuxDestinations = this.convertArrayToObject(res.response.AuxDestination)
				this.eventmasterData.SuperDestinations = this.convertArrayToObject(res.response.SuperDestination)
				this.eventmasterData.SuperAuxDestinations = this.convertArrayToObject(res.response.SuperAux)
			} catch (err) {
				this.log('error', 'EventMaster Destinations Error: ' + err)
			}
		}
	}

	async getPowerStatusFromEventmaster() {
		this.eventmaster.powerStatus((err, res) => {
			if (err) this.log('error', 'EventMaster Error: ' + err)
			else {
				const key = Object.keys(res.response)[0]
				this.setVariableValues({
					power_status1: this.powerStatus[parseInt(res.response[key].PowerSupply1Status)],
					power_status2: this.powerStatus[parseInt(res.response[key].PowerSupply2Status)],
				})
			}
		})
	}

	async getAllDataFromEventmaster() {
		console.log('Fetching all data from EventMaster...')
		await this.getPresetsFromEventmaster()
		await this.getSourcesFromEventmaster()
		await this.getCuesFromEventmaster()
		await this.getDestinationsFromEventmaster()
		await this.getUserKeysFromEventmaster()
		await this.getPowerStatusFromEventmaster()
	}

	getActions() {
		const actions = {}

		const CHOICES_PRESETS = Object.values(this.eventmasterData.presets).map((preset) => ({
			label: `${preset.presetSno || preset.id} ${_.unescape(preset.Name)}`,
			id: preset.id,
			sort: preset.presetSno || preset.id,
		}))
		const CHOICES_SOURCES = Object.values(this.eventmasterData.sources).map((source) => ({
			label: source.Name,
			id: source.id,
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
		const CHOICES_SCREENDESTINATIONS = Object.values(this.eventmasterData.ScreenDestinations).map((dest) => ({
			label: dest.Name,
			id: dest.id,
		}))
		const CHOICES_AUXDESTINATIONS = Object.values(this.eventmasterData.AuxDestinations).map((dest) => ({
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
						// this.log('debug', 'listMvrPreset response: ' + JSON.stringify(res))
						// const key = Object.keys(res.response.System.FrameCollection)[0]
						this.eventmasterData.frameIP = res.response.System.FrameCollection.Frame[0].Enet.IP
						this.eventmasterData.version = res.response.System.FrameCollection.Frame[0].Version
						this.eventmasterData.OSVersion = res.response.System.FrameCollection.Frame[0].OSVersion
						this.setVariableValues({
							frame_IP: this.eventmasterData.frameIP,
							frame_version: this.eventmasterData.version,
							frame_OSVersion: this.eventmasterData.OSVersion,
						})
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
					default: true,
				},
			],
			callback: (action) => {
				const params = {
					ScreenDestination: { id: parseInt(action.options.destId) },
					AuxDestination: [],
					arm: action.options.arm,
				}
				this.eventmaster.armUnarmDestination(params, (err, res) => {
					if (err) this.log('error', 'EventMaster Error: ' + err)
					else this.log('debug', 'armUnarmDestination response: ' + JSON.stringify(res))
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
		return actions
	}
}

runEntrypoint(BarcoInstance, [])
