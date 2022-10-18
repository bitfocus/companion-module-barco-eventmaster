const EventMaster = require('barco-eventmaster')
const checkIp = require('check-ip')
const ping = require('ping')
const instance_skel = require('../../instance_skel')
const upgradeScripts = require('./upgrades')
const _ = require('lodash')
let debug = () => {}

class instance extends instance_skel {
	/**
	 * Create an instance of the module
	 *
	 * @param {EventEmitter} system - the brains of the operation
	 * @param {string} id - the instance ID
	 * @param {Object} config - saved user configuration parameters
	 * @since 1.0.0
	 */
	constructor(system, id, config) {
		super(system, id, config)

		this.CHOICES_PRESETS = [{ id: 0, label: 'no presets loaded yet' }]
		this.CHOICES_SOURCES = [{ id: 0, label: 'no sources loaded yet', SrcType: 0 }]
		this.CHOICES_CUES = [{ id: 0, label: 'no cues loaded yet' }]
		this.CHOICES_AUXDESTINATIONS = [{ id: 0, label: 'no auxes loaded yet' }]
		this.CHOICES_SCREENDESTINATIONS = [{ id: 0, label: 'no destinations loaded yet' }]
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

		this.ok = false
		this.retry_interval = setInterval(this.retry.bind(this), 15000)
		this.actions() // export actions
	}

	GetUpgradeScripts() {
		return [upgradeScripts]
	}

	init() {
		this.status(this.STATE_UNKNOWN)

		this.debug('creating eventmaster')

		this.retry()

		this.actions()
		this.updateChoices()
		this.initPresets()
	}

	updateConfig(config) {
		this.config = config
		this.updateChoices()
		this.initPresets()
	}

	retry() {
		if (
			this.eventmaster === undefined ||
			(this.config !== undefined && this.config.host !== undefined && this.config.host.match(/^\d+\.\d+\.\d+\.\d+$/))
		) {
			if (
				this.eventmaster === undefined ||
				(this.eventmaster.ip !== undefined && this.config.host !== this.eventmaster.ip)
			) {
				var check = checkIp(this.config.host)
				if (check.isValid === true) {
					var cfg = {
						timeout: 4,
					}
					ping.sys.probe(
						this.config.host,
						(isAlive) => {
							if (isAlive == true) {
								this.eventmaster = new EventMaster(this.config.host)
								this.status(this.STATE_OK)
							} else {
								this.status(this.STATE_ERROR, 'No ping reply from ' + this.config.host)
							}
						},
						cfg
					)
				} else {
					this.status(this.STATE_ERROR, 'Invalid IP configured')
				}
			}
		}

		this.updateChoices()
		this.initPresets()
	}

	// Return config fields for web config
	config_fields() {
		return [
			{
				type: 'text',
				id: 'info',
				width: 12,
				label: 'Information',
				value:
					'This module uses the official EventMaster JSON API. Unfortunately the JSON API is not available in the simulator, so you need to use the real deal to get this working. If the status is OK, it ONLY means that the IP configured answers on icmp ping.',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'Target IP',
				width: 6,
				default: '192.168.0.175',
				regex: this.REGEX_IP,
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
		]
	}

	// When module gets deleted
	destroy() {
		clearInterval(this.retry_interval)
		delete this.eventmaster
		debug('destroy')
	}

	updateChoices() {
		if (this.eventmaster !== undefined) {
			this.eventmaster
				.listPresets(-1, -1, (obj, res) => {
					if (res !== undefined) {
						this.CHOICES_PRESETS.length = 0

						for (var n in res) {
							var preset = res[n]
							//preset.Name.replace('&#40;', '(')
							this.CHOICES_PRESETS.push({
								label: preset.presetSno + ' ' + _.unescape(preset.Name),
								id: preset.id,
								sort: preset.presetSno,
							})
						}
					}

					this.actions()
				})
				.on('error', (err) => {
					this.log('error', 'EventMaster Error: ' + err)
				})

			this.eventmaster
				.listSources(0, (obj, res) => {
					if (res !== undefined) {
						this.CHOICES_SOURCES.length = 0

						for (var n in res) {
							var source = res[n]
							this.CHOICES_SOURCES.push({ label: source.Name, id: source.id, sourceType: source.SrcType })
						}
					}

					this.actions()
				})
				.on('error', (err) => {
					this.log('error', 'EventMaster Error: ' + err)
				})

			this.eventmaster
				.listCues(0, (obj, res) => {
					if (res !== undefined) {
						this.CHOICES_CUES.length = 0

						for (var n in res) {
							var cue = res[n]
							this.CHOICES_CUES.push({ label: cue.Name, id: cue.id })
						}
					}

					this.actions()
				})
				.on('error', (err) => {
					this.log('error', 'EventMaster Error: ' + err)
				})

			this.eventmaster
				.listDestinations(0, (obj, res) => {
					if (res !== undefined) {
						var screenDestinations = res.ScreenDestination
						var auxes = res.AuxDestination
						this.CHOICES_SCREENDESTINATIONS.length = 0
						this.CHOICES_AUXDESTINATIONS.length = 0

						for (var n in screenDestinations) {
							var dest = screenDestinations[n]
							this.CHOICES_SCREENDESTINATIONS.push({ label: dest.Name, id: dest.id })
						}

						for (var n in auxes) {
							var dest = auxes[n]
							this.CHOICES_AUXDESTINATIONS.push({ label: dest.Name, id: dest.id })
						}
					}

					this.actions()
				})
				.on('error', (err) => {
					this.log('error', 'EventMaster Error: ' + err)
				})
		}
	}

	/**
	 * Setup the actions.
	 *
	 * @param {EventEmitter} system - the brains of the operation
	 * @access public
	 * @since 1.0.0
	 */
	actions(system) {
		const actions = {}
		actions['trans_all'] = { label: 'Take/Trans Active' }
		actions['cut_all'] = { label: 'Cut Active' }
		actions['recall_next'] = { label: 'Recall Next Preset' }
		;(actions['frzSource'] = {
			label: 'Freeze/Unfreeze Source',
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
					choices: this.CHOICES_SOURCES,
					default: '0',
				},
			],
		}),
			(actions['frzScreenDest'] = {
				label: 'Freeze/Unfreeze Screen Destination',
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
						choices: this.CHOICES_SCREENDESTINATIONS,
						default: '0',
					},
				],
			}),
			(actions['frzAuxDest'] = {
				label: 'Freeze/Unfreeze Aux Destination',
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
						choices: this.CHOICES_AUXDESTINATIONS,
						default: '0',
					},
				],
			}),
			(actions['preset_in_pvw'] = {
				label: 'Preset in PVW',
				options: [
					{
						type: 'dropdown',
						label: 'Preset',
						id: 'preset_in_pvw',
						minChoicesForSearch: 5,
						choices: this.CHOICES_PRESETS.sort((a, b) => a.sort - b.sort),
						default: '0',
					},
				],
			}),
			(actions['preset_in_pgm'] = {
				label: 'Preset in PGM',
				options: [
					{
						type: 'dropdown',
						label: 'Preset',
						id: 'preset_in_pgm',
						minChoicesForSearch: 5,
						choices: this.CHOICES_PRESETS.sort((a, b) => a.sort - b.sort),
						default: '0',
					},
				],
			}),
			(actions['play_cue'] = {
				label: 'Play cue',
				options: [
					{
						type: 'dropdown',
						label: 'cue',
						id: 'cueNumber',
						minChoicesForSearch: 5,
						choices: this.CHOICES_CUES,
						default: '0',
					},
				],
			}),
			(actions['stop_cue'] = {
				label: 'Stop cue',
				options: [
					{
						type: 'dropdown',
						label: 'cue',
						id: 'cueNumber',
						minChoicesForSearch: 5,
						choices: this.CHOICES_CUES,
						default: '0',
					},
				],
			}),
			(actions['change_aux'] = {
				label: 'Change aux on destination',
				options: [
					{
						type: 'dropdown',
						label: 'Source',
						id: 'source',
						minChoicesForSearch: 5,
						choices: this.CHOICES_SOURCES,
						default: '0',
					},
					{
						type: 'dropdown',
						label: 'Destination',
						id: 'auxDestination',
						choices: this.CHOICES_AUXDESTINATIONS,
						default: '0',
					},
				],
			}),
			(actions['armUnarmDestination'] = {
				label: 'arm screen destinations',
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
						choices: this.CHOICES_SCREENDESTINATIONS,
						default: '0',
					},
				],
			}),
			(actions['armUnarmAuxDestination'] = {
				label: 'arm aux destinations',
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
						choices: this.CHOICES_AUXDESTINATIONS,
						default: '0',
					},
				],
			}) /*,
		actions['subscribe'] = {
			label: 'subscribe to SourceChanged',
			options: [{
				type: 'textinput',
				label: 'IP to send JSON to',
				id: 'ip',
				regex: this.REGEX_IP
			},{
				type: 'textinput',
				label: 'Portnumber',
				id: 'port'
			}]
		},
		actions['unsubscribe'] = {
			label: 'unsubscribe to SourceChanged',
			options: [{
				type: 'textinput',
				label: 'IP to send JSON to',
				id: 'ip',
				regex: this.REGEX_IP
			},{
				type: 'textinput',
				label: 'Portnumber',
				id: 'port'
			}]
		}*/
		;(actions['testpattern_on_AUX'] = {
			label: 'Set testpattern for AUX',
			options: [
				{
					type: 'dropdown',
					label: 'aux destination',
					id: 'auxDestination',
					choices: this.CHOICES_AUXDESTINATIONS,
				},
				{
					type: 'dropdown',
					label: 'Type number',
					id: 'testPattern',
					choices: this.CHOICES_TESTPATTERN,
				},
			],
		}),
			(actions['testpattern_on_SCREEN'] = {
				label: 'Set testpattern for screen destinations',
				options: [
					{
						type: 'dropdown',
						label: 'destination',
						id: 'screenDestination',
						choices: this.CHOICES_SCREENDESTINATIONS,
					},
					{
						type: 'dropdown',
						label: 'Type number',
						id: 'testPattern',
						choices: this.CHOICES_TESTPATTERN,
					},
				],
			}),
			(actions['activateSourceMainBackup'] = {
				label: 'Configure Main/Backup',
				options: [
					{
						type: 'dropdown',
						label: 'Source',
						id: 'source',
						choices: this.CHOICES_SOURCES,
						default: '0',
					},
					{
						type: 'dropdown',
						label: 'Backup 1',
						id: 'backup1',
						choices: this.CHOICES_SOURCES,
						default: '0',
					},
					{
						type: 'dropdown',
						label: 'Backup 2',
						id: 'backup2',
						choices: this.CHOICES_SOURCES,
						default: '0',
					},
					{
						type: 'dropdown',
						label: 'Backup 3',
						id: 'backup3',
						choices: this.CHOICES_SOURCES,
						default: '0',
					},
					{
						type: 'dropdown',
						label: 'Backup state',
						id: 'BackUpState',
						choices: [
							{ id: '-1', label: 'Primary' },
							{ id: '1', label: 'Backup 1' },
							{ id: '2', label: 'Backup 2' },
							{ id: '3', label: 'Backup 3' },
						],
						default: '-1',
					},
				],
			}),
			this.setActions(actions)
	}

	/**
	 * Executes the provided action.
	 *
	 * @param {Object} action - the action to be executed
	 * @access public
	 * @since 1.0.0
	 */
	async action(action) {
		let opt = action.options
		let user = this.config.usermode
		let password = this.config.superPassword
		let id = this.config.operatorId
		console.log(user + password + id)
		switch (action.action) {
			case 'trans_all':
				this.log('info', 'Trans/Take All')
				if (this.eventmaster !== undefined) {
					if (user == 'operator') {
						this.eventmaster
							.allTrans(user, id, (obj, res) => {
								this.debug('info', 'trans all response: ' + res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else if (user == 'super_user') {
						this.eventmaster
							.allTrans(user, password, (obj, res) => {
								this.debug('trans all response', res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else {
						this.eventmaster
							.allTrans(user, (obj, res) => {
								this.debug('trans all response', res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					}
				}
				break

			case 'cut_all':
				this.log('info', 'Cut All')

				if (this.eventmaster !== undefined) {
					if (user == 'operator') {
						this.eventmaster
							.cut(user, id, (obj, res) => {
								this.debug('cut all response', res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else if (user == 'super_user') {
						this.eventmaster
							.cut(user, password, (obj, res) => {
								this.debug('cut all response', res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else {
						this.eventmaster
							.cut(user, (obj, res) => {
								this.debug('cut all response', res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					}
				}
				break

			case 'recall_next':
				this.log('info', 'recall_next')

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.recallNextPreset((obj, res) => {
							this.debug('recall next response', res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'freeze':
				this.log('info', 'freeze')

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.freezeDestSource(0, parseInt(opt.frzSource), 0, 1, (obj, res) => {
							this.debug('freeze all response', res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'unfreeze':
				this.log('info', 'unfreeze')

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.freezeDestSource(0, parseInt(opt.unfrzSource), 0, 0, (obj, res) => {
							this.debug('unfreeze all response', res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'frzSource':
				this.log('info', '(un)freeze source')

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.freezeDestSource(0, parseInt(opt.frzSource), 0, parseInt(opt.frzType), (obj, res) => {
							this.debug('freeze all response', res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'frzScreenDest':
				this.log('info', '(un)freeze Screen Destination')

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.freezeDestSource(2, parseInt(opt.frzDest), 0, parseInt(opt.frzType), (obj, res) => {
							this.debug('freeze all response', res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'frzAuxDest':
				this.log('info', '(un)freeze Aux Destination')

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.freezeDestSource(3, parseInt(opt.frzDest), 0, parseInt(opt.frzType), (obj, res) => {
							this.debug('freeze all response', res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'preset_in_pvw':
				this.log('info', 'Recall to PVW id:' + opt.preset_in_pvw)

				if (this.eventmaster !== undefined) {
					if (user == 'operator') {
						this.eventmaster
							.activatePresetById(parseInt(opt.preset_in_pvw), 0, user, id, (obj, res) => {
								this.debug('recall preset pvw response', res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else if (user == 'super_user') {
						this.eventmaster
							.activatePresetById(parseInt(opt.preset_in_pvw), 0, user, password, (obj, res) => {
								this.debug('recall preset pvw response', res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else {
						this.eventmaster
							.activatePresetById(parseInt(opt.preset_in_pvw), 0, user, (obj, res) => {
								this.debug('recall preset pvw response', res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					}
				}
				break

			case 'preset_in_pgm':
				this.log('info', 'Recall to PGM id:' + opt.preset_in_pgm)

				if (this.eventmaster !== undefined) {
					if (user == 'operator') {
						this.eventmaster
							.activatePresetById(parseInt(opt.preset_in_pgm), 1, user, id, (obj, res) => {
								this.debug('recall preset pgm response', res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else if (user == 'super_user') {
						this.eventmaster
							.activatePresetById(parseInt(opt.preset_in_pgm), 1, user, password, (obj, res) => {
								this.debug('recall preset pgm response', res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					} else {
						this.eventmaster
							.activatePresetById(parseInt(opt.preset_in_pgm), 1, user, null, (obj, res) => {
								this.debug('recall preset pgm response', res)
							})
							.on('error', (err) => {
								this.log('error', 'EventMaster Error: ' + err)
							})
					}
				}
				break

			case 'play_cue':
				this.log('info', 'play_cue:' + opt.cueNumber)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.activateCueById(parseInt(opt.cueNumber), 0, (obj, res) => {
							this.debug('activateCue response', res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'stop_cue':
				this.log('info', 'stop_cue:' + opt.cueNumber)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.activateCueById(parseInt(opt.cueNumber), 2, (obj, res) => {
							this.debug('activateCue response', res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'change_aux':
				this.log('info', `change_aux, source: ${opt.source} destination ${opt.auxDestination}`)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.changeAuxContent(parseInt(opt.auxDestination), -1, parseInt(opt.source), (obj, res) => {
							this.debug('changeAuxContent response', res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'subscribe':
				this.log('info', `subscribe to localhost`)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.subscribe(
							opt.ip,
							opt.port,
							['SourceChanged', 'BGSourceChanged', 'ScreenDestChanged', 'AUXDestChanged'],
							(obj, res) => {
								this.debug('subscribe response', res)
							}
						)
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'unsubscribe':
				this.log('info', `unsubscribe`)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.unsubscribe(
							opt.ip,
							opt.port,
							['SourceChanged', 'BGSourceChanged', 'ScreenDestChanged', 'AUXDestChanged'],
							(obj, res) => {
								this.debug('unsubscribe response', res)
							}
						)
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'armUnarmDestination':
				this.log('info', `armUnarmDestination, arm/unarm ${opt.armUnarm}, destination ${opt.screenDestinations}`)
				if (this.eventmaster !== undefined) {
					this.eventmaster
						.armUnarmDestination(parseInt(opt.armUnarm), { id: opt.screenDestinations }, null, (obj, res) => {
							this.debug('armUnarmDestination response', res)
						})
						.on('error', (err) => {
							this.log('error', 'Eventmaster Error: ' + err)
						})
				}
				break

			case 'armUnarmAuxDestination':
				this.log('info', `armUnarmAuxDestination, arm/unarm ${opt.armUnarm}, destination ${opt.auxDestinations}`)
				if (this.eventmaster !== undefined) {
					this.eventmaster
						.armUnarmDestination(parseInt(opt.armUnarm), null, { id: opt.auxDestinations }, (obj, res) => {
							this.debug('armUnarmAuxDestination response', res)
						})
						.on('error', (err) => {
							this.log('error', 'Eventmaster Error: ' + err)
						})
				}
				break

			case 'testpattern_on_AUX':
				this.log('info', `change_testAuxPattern, id: ${opt.testPattern} destination ${opt.auxDestination}`)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.changeAuxContentTestPattern(parseInt(opt.auxDestination), parseInt(opt.testPattern), (obj, res) => {
							debug('changeAuxContentTestPattern response', res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'testpattern_on_SCREEN':
				this.log('info', `change_testPattern, id: ${opt.testPattern} destination ${opt.screenDestination}`)

				if (this.eventmaster !== undefined) {
					this.eventmaster
						.changeContentTestPattern(parseInt(opt.screenDestination), parseInt(opt.testPattern), (obj, res) => {
							debug('changeAuxContentTestPattern response', res)
						})
						.on('error', (err) => {
							this.log('error', 'EventMaster Error: ' + err)
						})
				}
				break

			case 'activateSourceMainBackup':
				this.log(
					'info',
					`activateSourceMainBackup, source: ${opt.source} backup 1 ${opt.backup1} backup 2 ${opt.backup2} backup 3 ${opt.backup3}`
				)
				let source = parseInt(opt.source)
				let backup1 = parseInt(opt.backup1)
				let backup2 = parseInt(opt.backup2)
				let backup3 = parseInt(opt.backup3)
				let BackUpState = opt.BackUpState
				let backup1_ScrType, backup2_ScrType, backup3_ScrType
				console.log(this.CHOICES_SOURCES);
					this.CHOICES_SOURCES.forEach(iterator => {
						if (backup1 === iterator.id) backup1_ScrType = iterator.SrcType
						else if (backup2 === iterator.id) backup2_ScrType = iterator.SrcType
						else if (backup3 === iterator.id) backup3_ScrType = iterator.SrcType
					})
				if (this.eventmaster !== undefined) {
					this.log('debug',`Source:${source}, 1:${backup1_ScrType}, ${backup1} 2:${backup2_ScrType}, ${backup2}, 3:${backup3_ScrType}, ${backup3}, State${BackUpState}`)
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
								debug('activateSourceMainBackup response', res)
							}
						)
						.on('error', (err) => {
							log('error', 'EventMaster Error: ' + err)
						})
				}

				break

			/* only available on software not yet published

		*/
			/* only available on software not yet published
		case 'destinationGroup':
			this.log('info', `destinationGroup: ${opt.id}`)
			if (this.eventmaster !== undefined) {
				this.eventmaster.activateDestGroup(parseInt(opt.id), (obj, res) => {
					debug('activateDestGroup response', res);
				}).on('error', (err) => {
					this.log('error','EventMaster Error: '+ err);
				});
			}
			break;
			*/
		}
	}

	initPresets(updates) {
		var presets = []

		presets.push({
			category: 'Basics',
			bank: {
				style: 'text',
				text: 'Take',
				size: '14',
				color: this.rgb(0, 0, 0),
				bgcolor: this.rgb(255, 0, 0),
			},
			actions: [
				{
					action: 'trans_all',
				},
			],
		})
		presets.push({
			category: 'Basics',
			bank: {
				style: 'text',
				text: 'Cut',
				size: '14',
				color: this.rgb(0, 0, 0),
				bgcolor: this.rgb(255, 0, 0),
			},
			actions: [
				{
					action: 'cut_all',
				},
			],
		})
		presets.push({
			category: 'Basics',
			bank: {
				style: 'text',
				text: 'Recall next',
				size: '14',
				color: this.rgb(0, 0, 0),
				bgcolor: this.rgb(235, 0, 0),
			},
			actions: [
				{
					action: 'recall_next',
				},
			],
		})
		//Load presets from eventmaster into presets from companion
		for (var preset in this.CHOICES_PRESETS) {
			presets.push({
				category: 'Presets to PVW',
				bank: {
					style: 'text',
					text: this.CHOICES_PRESETS[preset].label,
					size: '14',
					color: this.rgb(0, 0, 0),
					bgcolor: this.rgb(235, 235, 235),
				},
				actions: [
					{
						action: 'preset_in_pvw',
						options: {
							preset_in_pvw: this.CHOICES_PRESETS[preset].id,
						},
					},
				],
			})
		}

		for (var presetPGM in this.CHOICES_PRESETS) {
			presets.push({
				category: 'Presets to PGM',
				bank: {
					style: 'text',
					text: this.CHOICES_PRESETS[presetPGM].label,
					size: '14',
					color: this.rgb(255, 0, 0),
					bgcolor: this.rgb(235, 235, 235),
				},
				actions: [
					{
						action: 'preset_in_pgm',
						options: {
							preset_in_pgm: this.CHOICES_PRESETS[presetPGM].id,
						},
					},
				],
			})
		}

		//Load cues from eventmaster into presets from companion
		for (var cue in this.CHOICES_CUES) {
			presets.push({
				category: 'Cues',
				bank: {
					style: 'text',
					text: this.CHOICES_CUES[cue].label,
					size: '14',
					color: this.rgb(0, 0, 0),
					bgcolor: this.rgb(66, 244, 226),
				},
				actions: [
					{
						action: 'play_cue',
						options: {
							cueNumber: this.CHOICES_CUES[cue].id,
						},
					},
				],
			})
		}
		this.setPresetDefinitions(presets)
	}
}

exports = module.exports = instance
