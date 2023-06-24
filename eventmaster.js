const EventMaster = require('barco-eventmaster')
// const upgradeScripts = require('./upgrades')
const _ = require('lodash')
const { InstanceBase, InstanceStatus, Regex, combineRgb, runEntrypoint } = require('@companion-module/base')
const ping = require('ping')

class BarcoInstance extends InstanceBase {
	/**
	 * Create an instance of the module
	 *
	 * @param {EventEmitter} system - the brains of the operation
	 * @param {string} id - the instance ID
	 * @param {Object} config - saved user configuration parameters
	 * @since 1.0.0
	 */
	constructor(internal) {
		super(internal)
	}

	GetUpgradeScripts() {
		return [upgradeScripts]
	}

	async init(config) {
		this.config = config
		this.eventmasterData = {
			presets: { 0: { id: 0, Name: 'no presets loaded yet' } },
			sources: { 0: { id: 0, Name: 'no sources loaded yet', SrcType: 0 } },
			cues: { 0: { id: 0, Name: 'no cues loaded yet' } },
			auxDestinations: { 0: { id: 0, Name: 'no auxes loaded yet' } },
			screenDestinations: { 0: { id: 0, Name: 'no destinations loaded yet' } },
		}
		this.CHOICES_FREEZE = [
			{ label: 'Freeze', id: '1' },
			{ label: 'Unfreeze', id: '0' },
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

		this.updateStatus(InstanceStatus.UnknownWarning)
		this.connection()

		this.log(`debug`, 'creating eventmaster')
	}

	async configUpdated(config) {
		this.config = config
		this.connection()
	}

	/**
	 * Connection
	 */
	connection() {
		// Check for ability to ping the machine
		if (this.config) {
			ping.promise.probe(this.config.host).then((res) => {
				if (res.alive) {
					this.log(`debug`, 'ping ok')
					this.initEventmaster()
				} else {
					// If ping fails, retry every 5 seconds
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

	/**
	 * Init Eventmaster
	 */
	initEventmaster() {
		this.eventmaster = new EventMaster(this.config.host)
		this.updateStatus(InstanceStatus.Ok)
		this.getAllDataFromEventmaster().then(() => {
			this.setActionDefinitions(this.getActions())
			this.setPresetDefinitions(this.getPresets())
			this.eventmasterPoller()
		})
		if (this.retry_interval) clearInterval(this.retry_interval)
	}

	/**
	 * Create pollers for fetching data from Eventmaster
	 */
	eventmasterPoller() {
		if (this.config) {
			if (this.config.pollingInterval === 0) {
				if (this.polling_interval) clearInterval(this.polling_interval)
			} else {
				this.polling_interval = setInterval(
					() => {
						this.getAllDataFromEventmaster().then(() => {
							this.setActionDefinitions(this.getActions())
							this.setPresetDefinitions(this.getPresets())
						})
					},
					Math.ceil(this.config.pollingInterval * 1000) || 5000
				)
			}
		}
	}

	/**
	 * Return config fields for web config
	 * @returns config fields for web config
	 */
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
				type: 'dropdown',
				id: 'usermode',
				label: 'Multiuser Mode',
				width: 6,
				default: 'userSingle',
				choices: [
					{ id: 'userSingle', label: 'Single User' },
					{ id: 'operator', label: 'Multiuser Normal Operator' },
					{ id: 'super_user', label: 'Multiuser Super Operator ' },
				],
			},
			{
				type: 'textinput',
				id: 'superPassword',
				label: 'Multiuser Super Operator Password',
				width: 6,
				default: '',
			},
			{
				type: 'textinput',
				id: 'operatorId',
				label: 'Multiuser Operator Id (number)',
				width: 6,
				default: '0',
			},
			{
				type: 'number',
				id: 'pollingInterval',
				label: 'Polling Interval (in seconds) for presets and actions (type 0 to disable)',
				width: 6,
				default: 5,
			},
		]
	}

	/**
	 * When module gets deleted
	 */
	async destroy() {
		if (this.retry_interval) clearInterval(this.retry_interval)
		if (this.polling_interval) clearInterval(this.polling_interval)
		delete this.eventmaster
		this.log(`debug`, 'destroy')
	}

	/**
	 * Converting a data array into an object
	 * @param {*} array
	 * @param {*} key
	 * @returns Object
	 */
	convertArrayToObject = (array, key) => {
		const initialValue = {}
		return array.reduce((obj, item) => {
			return {
				...obj,
				[item[key]]: item,
			}
		}, initialValue)
	}

	/**
	 * Load all needed data from Eventmaster
	 */
	// Presets
	async getPresetsFromEventmaster() {
		if (this.eventmaster !== undefined) {
			// List of presets
			const Presets = new Promise((resolve, reject) => {
				this.eventmaster
					.listPresets(-1, -1, (obj, res) => {
						if (res !== undefined) {
							this.eventmasterData.presets = this.convertArrayToObject(res, 'id')
						}
						resolve()
					})
					.on('error', (err) => {
						reject(err)
					})
			})
			await Presets.catch((err) => {
				this.log('error', 'EventMaster Presets Error: ' + err)
			})
		}
	}
	// Sources
	async getSourcesFromEventmaster() {
		if (this.eventmaster !== undefined) {
			// List of sources
			const Sources = new Promise((resolve, reject) => {
				this.eventmaster
					.listSources(0, (obj, res) => {
						if (res !== undefined) {
							this.eventmasterData.sources = this.convertArrayToObject(res, 'id')
						}
						resolve()
					})
					.on('error', (err) => {
						reject(err)
					})
			})
			await Sources.catch((err) => {
				this.log('error', 'EventMaster Sources Error: ' + err)
			})
		}
	}
	// Cues
	async getCuesFromEventmaster() {
		if (this.eventmaster !== undefined) {
			// List of Cues
			const Cues = new Promise((resolve, reject) => {
				this.eventmaster
					.listCues(0, (obj, res) => {
						if (res !== undefined) {
							this.eventmasterData.cues = this.convertArrayToObject(res, 'id')
						}
						resolve()
					})
					.on('error', (err) => {
						reject(err)
					})
			})
			await Cues.catch((err) => {
				this.log('error', 'EventMaster Cues Error: ' + err)
			})
		}
	}
	// Destination
	async getDestinationsFromEventmaster() {
		if (this.eventmaster !== undefined) {
			// List of destinations
			const Destinations = new Promise((resolve, reject) => {
				this.eventmaster
					.listDestinations(0, (obj, res) => {
						if (res !== undefined) {
							this.eventmasterData.screenDestinations = this.convertArrayToObject(res.ScreenDestination, 'id')
							this.eventmasterData.auxes = this.convertArrayToObject(res.AuxDestination, 'id')
						}
						resolve()
					})
					.on('error', (err) => {
						reject(err)
					})
			})

			await Destinations.catch((err) => {
				this.log('error', 'EventMaster Destinations Error: ' + err)
			})
		}
	}
	async getAllDataFromEventmaster() {
		await this.getPresetsFromEventmaster().catch((err) => {
			this.log('error', err)
		})
		await this.getSourcesFromEventmaster().catch((err) => {
			this.log('error', err)
		})
		await this.getCuesFromEventmaster().catch((err) => {
			this.log('error', err)
		})
		await this.getDestinationsFromEventmaster().catch((err) => {
			this.log('error', err)
		})
	}
	/**
	 * Get all the actions
	 * @returns actions
	 */
	getActions() {
		// Needed for user level stuff
		const user = this.config.usermode
		const password = this.config.superPassword
		const id = this.config.operatorId
		// this.log('debug'`${user}, ${password}, ${id}`)
		const actions = {} // main array

		// Load all preset data
		let CHOICES_PRESETS = []
		Object.keys(this.eventmasterData.presets).forEach((key) => {
			// console.log(key, this.eventmasterData.presets[key])
			CHOICES_PRESETS.push({
				label: this.eventmasterData.presets[key].presetSno + ' ' + _.unescape(this.eventmasterData.presets[key].Name),
				id: this.eventmasterData.presets[key].id,
				sort: this.eventmasterData.presets[key].presetSno,
			})
		})
		let CHOICES_SOURCES = []
		Object.keys(this.eventmasterData.sources).forEach((key) => {
			// console.log(key, this.eventmasterData.presets[key])
			CHOICES_SOURCES.push({
				label: this.eventmasterData.sources[key].Name,
				id: this.eventmasterData.sources[key].id,
				InputCfgIndex: this.eventmasterData.sources[key].InputCfgIndex,
				SrcType: this.eventmasterData.sources[key].SrcType,
				StillIndex: this.eventmasterData.sources[key].StillIndex,
			})
		})
		let CHOICES_CUES = []
		Object.keys(this.eventmasterData.cues).forEach((key) => {
			// console.log(key, this.eventmasterData.presets[key])
			CHOICES_CUES.push({
				label: this.eventmasterData.cues[key].Name,
				id: this.eventmasterData.cues[key].id,
			})
		})

		let CHOICES_SCREENDESTINATIONS = []
		Object.keys(this.eventmasterData.screenDestinations).forEach((key) => {
			// console.log(key, this.eventmasterData.presets[key])
			CHOICES_SCREENDESTINATIONS.push({
				label: this.eventmasterData.screenDestinations[key].Name,
				id: this.eventmasterData.screenDestinations[key].id,
			})
		})

		let CHOICES_AUXDESTINATIONS = []
		Object.keys(this.eventmasterData.auxDestinations).forEach((key) => {
			// console.log(key, this.eventmasterData.presets[key])
			CHOICES_AUXDESTINATIONS.push({
				label: this.eventmasterData.auxDestinations[key].Name,
				id: this.eventmasterData.auxDestinations[key].id,
			})
		})

		actions['preset_in_pvw'] = {
			name: 'Preset in PVW',
			options: [
				{
					type: 'dropdown',
					label: 'Preset',
					id: 'preset_in_pvw',
					minChoicesForSearch: 5,
					choices: CHOICES_PRESETS.sort((a, b) => a.sort - b.sort),
					default: '0',
				},
			],
			callback: (action) => {
				this.log('info', 'Recall to PVW id:' + action.options.preset_in_pvw)

				if (this.eventmaster !== undefined) {
					if (user == 'operator') {
						this.eventmaster
							.activatePresetById(parseInt(action.options.preset_in_pvw), 0, user, id, (obj, res) => {
								this.log('debug', 'recall preset pvw response' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else if (user == 'super_user') {
						this.eventmaster
							.activatePresetById(parseInt(action.options.preset_in_pvw), 0, user, password, (obj, res) => {
								this.log('debug', 'recall preset pvw response' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else {
						this.eventmaster
							.activatePresetById(parseInt(action.options.preset_in_pvw), 0, user, (obj, res) => {
								this.log('debug', 'recall preset pvw response' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					}
				}
			},
		}
		actions['preset_in_pgm'] = {
			name: 'Preset in PGM',
			options: [
				{
					type: 'dropdown',
					label: 'Preset',
					id: 'preset_in_pgm',
					minChoicesForSearch: 5,
					choices: CHOICES_PRESETS.sort((a, b) => a.sort - b.sort),
					default: '0',
				},
			],
			callback: (action) => {
				this.log('info', 'Recall to PGM id:' + action.options.preset_in_pgm)

				if (this.eventmaster !== undefined) {
					if (user == 'operator') {
						this.eventmaster
							.activatePresetById(parseInt(action.options.preset_in_pgm), 1, user, id, (obj, res) => {
								this.log('debug', 'recall preset pgm response' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else if (user == 'super_user') {
						this.eventmaster
							.activatePresetById(parseInt(action.options.preset_in_pgm), 1, user, password, (obj, res) => {
								this.log('debug', 'recall preset pgm response' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else {
						this.eventmaster
							.activatePresetById(parseInt(action.options.preset_in_pgm), 1, user, null, (obj, res) => {
								this.log('debug', 'recall preset pgm response' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					}
				}
			},
		}

		actions['trans_all'] = {
			name: 'Take/Trans Active',
			options: [],
			callback: () => {
				this.log('info', 'Trans/Take All')
				if (this.eventmaster !== undefined) {
					if (user == 'operator') {
						this.eventmaster
							.allTrans(user, id, (obj, res) => {
								this.log('debug', 'trans all response: ' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else if (user == 'super_user') {
						this.eventmaster
							.allTrans(user, password, (obj, res) => {
								this.log('debug', 'trans all response' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else {
						this.eventmaster
							.allTrans(user, (obj, res) => {
								this.log('debug', 'trans all response' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					}
				}
			},
		}
		actions['cut_all'] = {
			name: 'Cut Active',
			options: [],
			callback: () => {
				this.log('info', 'Cut All')

				if (this.eventmaster !== undefined) {
					if (user == 'operator') {
						this.eventmaster
							.cut(user, id, (obj, res) => {
								this.log('debug', 'cut all response' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else if (user == 'super_user') {
						this.eventmaster
							.cut(user, password, (obj, res) => {
								this.log('debug', 'cut all response' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else {
						this.eventmaster
							.cut(user, (obj, res) => {
								this.log('debug', 'cut all response' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					}
				}
			},
		}
		actions['recall_next'] = {
			name: 'Recall Next Preset',
			options: [],
			callback: () => {
				this.log('info', 'recall_next')

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.recallNextPreset((obj, res) => {
							this.log('debug', 'recall next response' + res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
		actions['frzSource'] = {
			name: 'Freeze/Unfreeze Source',
			options: [
				{
					type: 'dropdown',
					label: 'freeze/unfreeze',
					id: 'frzType',
					choices: this.CHOICES_FREEZE,
					default: '1',
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
				this.log('info', '(un)freeze')

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.freezeDestSource(
							0,
							parseInt(action.options.frzSource),
							0,
							parseInt(action.options.frzType),
							(obj, res) => {
								this.log('debug', '(un)freeze all response' + res)
							}
						)
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
		actions['frzScreenDest'] = {
			name: 'Freeze/Unfreeze Screen Destination',
			options: [
				{
					type: 'dropdown',
					label: 'freeze/unfreeze',
					id: 'frzType',
					choices: this.CHOICES_FREEZE,
					default: '1',
				},
				{
					type: 'dropdown',
					label: 'Screen Destination',
					id: 'frzDest',
					choices: CHOICES_SCREENDESTINATIONS,
					default: '0',
				},
			],
			callback: (action) => {
				this.log('info', '(un)freeze Screen Destination')

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.freezeDestSource(2, parseInt(action.options.frzDest), 0, parseInt(action.options.frzType), (obj, res) => {
							this.log('debug', 'freeze all response' + res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
		actions['frzAuxDest'] = {
			name: 'Freeze/Unfreeze Aux Destination',
			options: [
				{
					type: 'dropdown',
					label: 'freeze/unfreeze',
					id: 'frzType',
					choices: this.CHOICES_FREEZE,
					default: '1',
				},
				{
					type: 'dropdown',
					label: 'Aux Destination',
					id: 'frzDest',
					choices: CHOICES_AUXDESTINATIONS,
					default: '0',
				},
			],
			callback: (action) => {
				this.log('info', '(un)freeze Aux Destination')

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.freezeDestSource(3, parseInt(action.options.frzDest), 0, parseInt(action.options.frzType), (obj, res) => {
							this.log('debug', 'freeze all response' + res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}

		actions['play_cue'] = {
			name: 'Play cue',
			options: [
				{
					type: 'dropdown',
					label: 'cue',
					id: 'cueNumber',
					minChoicesForSearch: 5,
					choices: CHOICES_CUES,
					default: '0',
				},
			],
			callback: (action) => {
				this.log('info', 'play_cue:' + action.options.cueNumber)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.activateCueById(parseInt(action.options.cueNumber), 0, (obj, res) => {
							this.log('debug', 'activateCue response' + res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
		actions['stop_cue'] = {
			name: 'Stop cue',
			options: [
				{
					type: 'dropdown',
					label: 'cue',
					id: 'cueNumber',
					minChoicesForSearch: 5,
					choices: CHOICES_CUES,
					default: '0',
				},
			],
			callback: (action) => {
				this.log('info', 'stop_cue:' + action.options.cueNumber)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.activateCueById(parseInt(action.options.cueNumber), 2, (obj, res) => {
							this.log('debug', 'activateCue response' + res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
		actions['change_aux'] = {
			name: 'Change aux on destination',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					minChoicesForSearch: 5,
					choices: CHOICES_SOURCES,
					default: '0',
				},
				{
					type: 'dropdown',
					label: 'Destination',
					id: 'auxDestination',
					choices: CHOICES_AUXDESTINATIONS,
					default: '0',
				},
			],
			callback: (action) => {
				this.log('info', `change_aux, source: ${action.options.source} destination ${action.options.auxDestination}`)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.changeAuxContent(
							parseInt(action.options.auxDestination),
							-1,
							parseInt(action.options.source),
							(obj, res) => {
								this.log('debug', 'changeAuxContent response' + res)
							}
						)
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
		actions['armUnarmDestination'] = {
			name: 'arm screen destinations',
			options: [
				{
					type: 'dropdown',
					label: 'arm/un-arm',
					id: 'armUnarm',
					choices: [
						{ label: 'arm', id: 1 },
						{ label: 'disarm', id: 0 },
					],
					default: '1',
				},
				{
					type: 'dropdown',
					label: 'destination',
					id: 'screenDestinations',
					choices: CHOICES_SCREENDESTINATIONS,
					default: '0',
				},
			],
			callback: (action) => {
				this.log(
					'info',
					`armUnarmDestination, arm/unarm ${action.options.armUnarm}, destination ${action.options.screenDestinations}`
				)
				if (this.eventmaster !== undefined) {
					this.eventmaster
						.armUnarmDestination(
							parseInt(action.options.armUnarm),
							{ id: action.options.screenDestinations },
							null,
							(obj, res) => {
								this.log('debug', 'armUnarmDestination response' + res)
							}
						)
						.on('error', (err) => {
							this.log('error', 'Eventmaster Error: ' + err)
						})
				}
			},
		}
		actions['armUnarmAuxDestination'] = {
			name: 'arm aux destinations',
			options: [
				{
					type: 'dropdown',
					label: 'arm/un-arm',
					id: 'armUnarm',
					choices: [
						{ label: 'arm', id: 1 },
						{ label: 'disarm', id: 0 },
					],
					default: '1',
				},
				{
					type: 'dropdown',
					label: 'destination',
					id: 'auxDestinations',
					choices: CHOICES_AUXDESTINATIONS,
					default: '0',
				},
			],
			callback: (action) => {
				this.log(
					'info',
					`armUnarmAuxDestination, arm/unarm ${action.options.armUnarm}, destination ${action.options.auxDestinations}`
				)
				if (this.eventmaster !== undefined) {
					this.eventmaster
						.armUnarmDestination(
							parseInt(action.options.armUnarm),
							null,
							{ id: action.options.auxDestinations },
							(obj, res) => {
								this.log('debug', 'armUnarmAuxDestination response' + res)
							}
						)
						.on('error', (err) => {
							this.log('error', 'Eventmaster Error: ' + err)
						})
				}
			},
		}
		actions['subscribe'] = {
			label: 'subscribe to SourceChanged',
			options: [
				{
					type: 'textinput',
					label: 'IP to send JSON to',
					id: 'ip',
					regex: this.REGEX_IP,
				},
				{
					type: 'textinput',
					label: 'Portnumber',
					id: 'port',
				},
			],
			callback: (action) => {
				this.log('info', `subscribe to localhost`)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.subscribe(
							action.options.ip,
							action.options.port,
							['SourceChanged', 'BGSourceChanged', 'ScreenDestChanged', 'AUXDestChanged'],
							(obj, res) => {
								this.log('debug', 'subscribe response' + res)
							}
						)
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
		actions['unsubscribe'] = {
			label: 'unsubscribe to SourceChanged',
			options: [
				{
					type: 'textinput',
					label: 'IP to send JSON to',
					id: 'ip',
					regex: this.REGEX_IP,
				},
				{
					type: 'textinput',
					label: 'Portnumber',
					id: 'port',
				},
			],
			callback: (action) => {
				this.log('info', `unsubscribe`)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.unsubscribe(
							action.options.ip,
							action.options.port,
							['SourceChanged', 'BGSourceChanged', 'ScreenDestChanged', 'AUXDestChanged'],
							(obj, res) => {
								this.log('debug', 'unsubscribe response' + res)
							}
						)
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
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
				this.log(
					'info',
					`change_testAuxPattern, id: ${action.options.testPattern} destination ${action.options.auxDestination}`
				)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.changeAuxContentTestPattern(
							parseInt(action.options.auxDestination),
							parseInt(action.options.testPattern),
							(obj, res) => {
								debug('changeAuxContentTestPattern response' + res)
							}
						)
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
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
				this.log(
					'info',
					`change_testPattern, id: ${action.options.testPattern} destination ${action.options.screenDestination}`
				)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.changeContentTestPattern(
							parseInt(action.options.screenDestination),
							parseInt(action.options.testPattern),
							(obj, res) => {
								debug('changeAuxContentTestPattern response' + res)
							}
						)
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
		actions['activateSourceMainBackup'] = {
			name: 'Configure Main/Backup',
			options: [
				{
					type: 'dropdown',
					label: 'Source',
					id: 'source',
					choices: CHOICES_SOURCES,
					default: '0',
				},
				{
					type: 'dropdown',
					label: 'Backup 1',
					id: 'backup1',
					choices: CHOICES_SOURCES,
					default: '0',
				},
				{
					type: 'dropdown',
					label: 'Backup 2',
					id: 'backup2',
					choices: CHOICES_SOURCES,
					default: '0',
				},
				{
					type: 'dropdown',
					label: 'Backup 3',
					id: 'backup3',
					choices: CHOICES_SOURCES,
					default: '0',
				},
				{
					type: 'dropdown',
					label: 'Backup state',
					id: 'BackUpState',
					choices: [
						{ id: '-1', label: 'Primary' },
						{ id: '0', label: 'Backup 1' },
						{ id: '1', label: 'Backup 2' },
						{ id: '2', label: 'Backup 3' },
					],
					default: '-1',
				},
			],
			callback: (action) => {
				let source = parseInt(action.options.source)
				let backup1 = parseInt(action.options.backup1)
				let backup2 = parseInt(action.options.backup2)
				let backup3 = parseInt(action.options.backup3)
				let BackUpState = parseInt(action.options.BackUpState)
				let backup1_ScrType = 0
				let backup2_ScrType = 0
				let backup3_ScrType = 0
				let source_InputCfgIndex = 0
				let backup1_InputCfgIndex = 0
				let backup2_InputCfgIndex = 0
				let backup3_InputCfgIndex = 0
				console.log(CHOICES_SOURCES)
				CHOICES_SOURCES.forEach((iterator) => {
					if (source === iterator.id) {
						source_InputCfgIndex = iterator.InputCfgIndex
					}
					if (backup1 === iterator.id) {
						backup1_ScrType = iterator.SrcType
						if (backup1_ScrType === 1) {
							backup1_InputCfgIndex = iterator.StillIndex
						} else {
							backup1_InputCfgIndex = iterator.InputCfgIndex
						}
					}
					if (backup2 === iterator.id) {
						backup2_ScrType = iterator.SrcType
						if (backup2_ScrType === 1) {
							backup2_InputCfgIndex = iterator.StillIndex
						} else {
							backup2_InputCfgIndex = iterator.InputCfgIndex
						}
					}
					if (backup3 === iterator.id) {
						backup3_ScrType = iterator.SrcType
						if (backup3_ScrType === 1) {
							backup3_InputCfgIndex = iterator.StillIndex
						} else {
							backup3_InputCfgIndex = iterator.InputCfgIndex
						}
					}
				})
				if (this.eventmaster !== undefined) {
					this.log(
						'debug',
						`activateSourceMainBackup: Source:${source_InputCfgIndex}, BU1Type:${backup1_ScrType}, BU1${backup1_InputCfgIndex} BU2Type:${backup2_ScrType}, BU2${backup2_InputCfgIndex}, BU3Type:${backup3_ScrType}, BU3${backup3_InputCfgIndex}, State:${BackUpState}`
					)
					this.eventmaster
						.activateSourceMainBackup(
							source,
							backup1_ScrType,
							backup1,
							backup2_ScrType,
							backup2,
							backup3_ScrType,
							backup3,
							BackUpState,
							(obj, res) => {
								debug('activateSourceMainBackup response' + res)
							}
						)
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
		actions['destinationGroup'] = {
			name: 'Activate Destination Group (Count from 0)',
			options: [
				{
					type: 'textinput',
					label: 'id of destination',
					id: 'id',
					default: '0',
				},
			],
			callback: (action) => {
				this.log('info', `destinationGroup: ${action.options.id}`)
				if (this.eventmaster !== undefined) {
					this.eventmaster
						.activateDestGroup(parseInt(action.options.id), (obj, res) => {
							this.log('debug', 'activateDestGroup response ' + res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
			},
		}
		return actions
	}
	/**
	 * Get all the presets
	 * @returns presets
	 */
	getPresets() {
		const presets = {} // main array

		presets['Take'] = {
			type: 'button',
			category: 'Basics',
			style: {
				text: 'Take',
				size: '14',
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 0, 0),
			},
			steps: [
				{
					down: [
						{
							actionId: 'trans_all',
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets['Cut'] = {
			type: 'button',
			category: 'Basics',
			style: {
				text: 'Cut',
				size: '14',
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 0, 0),
			},
			steps: [
				{
					down: [
						{
							actionId: 'cut_all',
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets['Recall_next'] = {
			type: 'button',
			category: 'Basics',
			style: {
				text: 'Recall next',
				size: '14',
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(235, 0, 0),
			},
			steps: [
				{
					down: [
						{
							actionId: 'recall_next',
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		//Load presets from eventmaster into presets from companion
		Object.keys(this.eventmasterData.presets).forEach((key) => {
			presets[`PVW_${this.eventmasterData.presets[key].id}`] = {
				type: 'button',
				category: 'Presets to PVW',
				style: {
					text: this.eventmasterData.presets[key].presetSno + ' ' + _.unescape(this.eventmasterData.presets[key].Name),
					size: '14',
					color: combineRgb(0, 0, 0),
					bgcolor: combineRgb(235, 235, 235),
				},
				steps: [
					{
						down: [
							{
								actionId: 'preset_in_pvw',
								options: {
									preset_in_pvw: this.eventmasterData.presets[key].id,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}
			presets[`PGM_${this.eventmasterData.presets[key].id}`] = {
				type: 'button',
				category: 'Presets to PGM',
				style: {
					text: this.eventmasterData.presets[key].presetSno + ' ' + _.unescape(this.eventmasterData.presets[key].Name),
					size: '14',
					color: combineRgb(255, 0, 0),
					bgcolor: combineRgb(235, 235, 235),
				},
				steps: [
					{
						down: [
							{
								actionId: 'preset_in_pgm',
								options: {
									preset_in_pgm: this.eventmasterData.presets[key].id,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}
		})

		Object.keys(this.eventmasterData.cues).forEach((key) => {
			this.log('debug', `Cue_${this.eventmasterData.cues[key].Name}_${key}`)
			presets[`Cue_${this.eventmasterData.cues[key].id}`] = {
				type: 'button',
				category: 'Cues',
				style: {
					text: this.eventmasterData.cues[key].Name,
					size: '14',
					color: combineRgb(0, 0, 0),
					bgcolor: combineRgb(66, 244, 226),
				},
				steps: [
					{
						down: [
							{
								actionId: 'play_cue',
								options: {
									cueNumber: this.eventmasterData.cues[key].id,
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}
		})

		return presets
	}
}

runEntrypoint(BarcoInstance, [])
