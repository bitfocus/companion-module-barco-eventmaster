var EventMaster   = require('barco-eventmaster');
var checkIp       = require('check-ip');
var ping          = require('ping');
var instance_skel = require('../../instance_skel');
var debug;
var log;

function instance(system, id, config) {
	var self = this;

	// super-constructor
	instance_skel.apply(this, arguments);

	// v0.0.* -> v0.0.4
	self.addUpgradeScript(function (config, actions) {
		// Presets were actions instead of choices
		var changed = false;

		for (var k in actions) {
			var action = actions[k];

			var actionid = action.action;
			var match;

			if (match = actionid.match(/^recall_preset_pvw_id_(\d+)/)) {
				if (action.options === undefined) {
					action.options = {};
				}
				action.options.preset_in_pvw = match[1];
				action.action = 'preset_in_pvw';
				action.label = self.id + ':' + action.action;

				changed = true;
			}

			if (match = actionid.match(/^recall_preset_pgm_id_(\d+)/)) {
				if (action.options === undefined) {
					action.options = {};
				}
				action.options.preset_in_pgm = match[1];
				action.action = 'preset_in_pgm';
				action.label = self.id + ':' + action.action;

				changed = true;
			}
		}

		return changed;
	});

	return self;
}

instance.prototype.init = function() {
	var self = this;

	debug = self.debug;
	log = self.log;

	self.CHOICES_PRESETS = [];
	self.CHOICES_SOURCES = [];
	self.CHOICES_CUES = [];
	self.CHOICES_AUXDESTINATIONS = [];
	self.CHOICES_SCREENDESTINATIONS = [];
	self.CHOICES_FREEZE = [
		{ label: 'Freeze', id: '1'},
		{ label: 'Unfreeze', id: '0'}
	];
	self.CHOICES_TESTPATTERN = [
		{ label: 'Pattern 1', id: '1'},
		{ label: 'Pattern 2', id: '2'},
		{ label: 'Pattern 3', id: '3'}
	];

	self.status(self.STATE_UNKNOWN);

	debug('creating eventmaster');

	self.ok = false;
	self.retry_interval = setInterval(self.retry.bind(self), 15000);
	self.retry();

	self.actions();
	self.updateChoices();
	self.initPresets();
};

instance.prototype.updateConfig = function(config) {
	var self = this;
	self.config = config;
	self.updateChoices();
	self.initPresets();
};

instance.prototype.retry = function() {
	var self = this;

	if (self.eventmaster === undefined || (self.config !== undefined && self.config
			.host !== undefined && self.config.host.match(/^\d+\.\d+\.\d+\.\d+$/))) {
		if (self.eventmaster === undefined || (self.eventmaster.ip !== undefined &&
				self.config.host !== self.eventmaster.ip)) {

			var check = checkIp(self.config.host);
			if (check.isValid === true) {
				var cfg = {
					timeout: 4,
				};
				ping.sys.probe(self.config.host, function(isAlive) {
					if (isAlive == true) {
						self.eventmaster = new EventMaster(self.config.host);
						self.status(self.STATE_OK);
					} else {
						self.status(self.STATE_ERROR, 'No ping reply from ' + self.config.host);
					}
				}, cfg);
			} else {
				self.status(self.STATE_ERROR, 'Invalid IP configured');
			}
		}
	}

	self.updateChoices();
	self.initPresets();
}

// Return config fields for web config
instance.prototype.config_fields = function() {
	var self = this;
	return [{
		type: 'text',
		id: 'info',
		width: 12,
		label: 'Information',
		value: 'This module uses the official EventMaster JSON API. Unfortunately the JSON API is not available in the simulator, so you need to use the real deal to get this working. If the status is OK, it ONLY means that the IP configured answers on icmp ping.'
	}, {
		type: 'textinput',
		id: 'host',
		label: 'Target IP',
		width: 6,
		default: '192.168.0.175',
		regex: self.REGEX_IP
	}]
};

// When module gets deleted
instance.prototype.destroy = function() {
	var self = this;
	clearInterval(self.retry_interval);
	delete self.eventmaster;
	debug("destroy");;
};

function htmlDecode(input) {
	var doc = newDOMParser().parseFromString(input, "text/html");
	return doc.documentElement.textContent;
}

instance.prototype.updateChoices = function(arguments) {
	var self = this;


	if (self.eventmaster !== undefined) {

		self.eventmaster.listPresets(-1, -1, function(obj, res) {

			if (res !== undefined) {
				self.CHOICES_PRESETS.length = 0;

				for (var n in res) {
					var preset = res[n];
					//preset.Name.replace('&#40;', '(')
					self.CHOICES_PRESETS.push({ label: preset.presetSno + " " + preset.Name, id: preset.id, sort: preset.presetSno });
				}
			}

			self.actions();
		}).on('error', function(err) {
			log('error', 'EventMaster Error: ' + err);
		});

		self.eventmaster.listSources(0, function(obj, res) {

			if (res !== undefined) {
				self.CHOICES_SOURCES.length = 0;

				for (var n in res) {

					var source = res[n];

					self.CHOICES_SOURCES.push({ label: source.Name, id: source.id});
				}
			}

			self.actions();
		}).on('error', function(err) {
			log('error','EventMaster Error: '+ err);
		});

		self.eventmaster.listCues(function(obj, res) {

			if (res !== undefined) {
				self.CHOICES_CUES.length = 0;

				for (var n in res) {

					var cue = res[n];

					self.CHOICES_CUES.push({ label: cue.Name, id: cue.id});
				}
			}

			self.actions();
		}).on('error', function(err) {
			log('error','EventMaster Error: '+ err);
		});

		self.eventmaster.listDestinations(0, function(obj, res) {

			if (res !== undefined) {
				var screenDestinations = res.ScreenDestination;
				var auxes = res.AuxDestination;

				self.CHOICES_SCREENDESTINATIONS.length = 0;
				self.CHOICES_AUXDESTINATIONS.length = 0;

				for (var n in screenDestinations) {

					var dest = screenDestinations[n];
					self.CHOICES_SCREENDESTINATIONS.push({ label: dest.Name, id: dest.id });
				}

				for (var n in auxes) {

					var dest = auxes[n];
					self.CHOICES_AUXDESTINATIONS.push({ label: dest.Name, id: dest.id });
				}
			}

			self.actions();
		}).on('error', function(err) {
			log('error','EventMaster Error: '+ err);
		});
	}
};

instance.prototype.actions = function(system) {
	var self = this;

	var actions = {
		'trans_all': { label: 'Take/Trans Active' },
		'cut_all': { label: 'Cut Active' },
		'recall_next': { label: 'Recall Next Preset' },
		'frzSource': {
			label: 'Freeze/Unfreeze Source',
			options: [{
				type: 'dropdown',
				label: 'freeze/unfreeze',
				id: 'frzType',
				choices: self.CHOICES_FREEZE,
				default: '1'
			},{
				type: 'dropdown',
				label: 'Source',
				id: 'frzSource',
				minChoicesForSearch: 5,
				choices: self.CHOICES_SOURCES
			}]
		},
		'frzScreenDest': {
			label: 'Freeze/Unfreeze Screen Destination',
			options: [{
				type: 'dropdown',
				label: 'freeze/unfreeze',
				id: 'frzType',
				choices: self.CHOICES_FREEZE,
				default: '1'
			},{
				type: 'dropdown',
				label: 'Screen Destination',
				id: 'frzDest',
				choices: self.CHOICES_SCREENDESTINATIONS
			}]
		},
		'frzAuxDest': {
			label: 'Freeze/Unfreeze Aux Destination',
			options: [{
				type: 'dropdown',
				label: 'freeze/unfreeze',
				id: 'frzType',
				choices: self.CHOICES_FREEZE,
				default: '1'
			},{
				type: 'dropdown',
				label: 'Aux Destination',
				id: 'frzDest',
				choices: self.CHOICES_AUXDESTINATIONS
			}]
		},
		'preset_in_pvw': {
			label: 'Preset in PVW',
			options: [{
				type: 'dropdown',
				label: 'Preset',
				id: 'preset_in_pvw',
				minChoicesForSearch: 5,
				choices: self.CHOICES_PRESETS.sort((a,b) => a.sort - b.sort),
			}]
		},
		'preset_in_pgm': {
			label: 'Preset in PGM',
			options: [{
				type: 'dropdown',
				label: 'Preset',
				id: 'preset_in_pgm',
				minChoicesForSearch: 5,
				choices: self.CHOICES_PRESETS.sort((a,b) => a.sort - b.sort),
			}]
		},
		'play_cue': {
			label: 'Play cue',
			options: [{
				type: 'dropdown',
				label: 'cue',
				id: 'cueNumber',
				minChoicesForSearch: 5,
				choices: self.CHOICES_CUES
			}]
		},
		'stop_cue': {
			label: 'Stop cue',
			options: [{
				type: 'dropdown',
				label: 'cue',
				id: 'cueNumber',
				minChoicesForSearch: 5,
				choices: self.CHOICES_CUES
			}]
		},
		'change_aux': {
			label: 'Change aux on destination',
			options: [{
				type: 'dropdown',
				label: 'Source',
				id: 'source',
				minChoicesForSearch: 5,
				choices: self.CHOICES_SOURCES
			},{
				type: 'dropdown',
				label: 'Destination',
				id: 'auxDestination',
				choices: self.CHOICES_AUXDESTINATIONS
			}]
		}/*,
		'subscribe': {
			label: 'subscribe to SourceChanged',
			options: [{
				type: 'textinput',
				label: 'IP to send JSON to',
				id: 'ip',
				regex: self.REGEX_IP
			},{
				type: 'textinput',
				label: 'Portnumber',
				id: 'port'
			}]
		},
		'unsubscribe': {
			label: 'unsubscribe to SourceChanged',
			options: [{
				type: 'textinput',
				label: 'IP to send JSON to',
				id: 'ip',
				regex: self.REGEX_IP
			},{
				type: 'textinput',
				label: 'Portnumber',
				id: 'port'
			}]
		}*/
		/* only available on software not yet published/tested
		'testpattern_on_AUX': {
			label: 'Set testpattern for AUX',
			options: [{
				type: 'dropdown',
				label: 'aux destination',
				id: 'auxDestination',
				choices: self.CHOICES_AUXDESTINATIONS
			},{
				type: 'dropdown',
				label: 'Type number',
				id: 'testPattern',
				choices: self.CHOICES_TESTPATTERN
			}]
		},
		'testpattern_on_SCREEN': {
			label: 'Set testpattern for screen destinations',
			options: [{
				type: 'dropdown',
				label: 'destination',
				id: 'screenDestination',
				choices: self.CHOICES_SCREENDESTINATIONS
			},{
				type: 'dropdown',
				label: 'Type number',
				id: 'testPattern',
				choices: self.CHOICES_TESTPATTERN
			}]
		},
		'armUnarmDestination': {
			label: 'arm destinations',
			options: [{
				type: 'dropdown',
				label: 'arm/un-arm',
				id: 'armUnarm',
				choices: [{ label: 'arm', id: 1},{ label: 'disarm', id: 0}]
			},{
				type: 'dropdown',
				label: 'destination',
				id: 'screenDestination',
				choices: self.CHOICES_SCREENDESTINATIONS
			}]
		} */
	};

	self.setActions(actions);
}

instance.prototype.action = function(action) {
	var self = this;
	var id = action.action;
	var opt = action.options;

	debug('run action:', id);
	switch(id) {

		case 'trans_all':
			log('info','Trans/Take All');

			if (self.eventmaster !== undefined) {
				self.eventmaster.allTrans(function(obj, res) {
					debug('trans all response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;

		case 'cut_all':
			log('info','Cut All');

			if (self.eventmaster !== undefined) {
				self.eventmaster.cut(function(obj, res) {
					debug('cut all response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;

		case 'recall_next':
			log('info','recall_next');

			if (self.eventmaster !== undefined) {
				self.eventmaster.recallNextPreset(function(obj, res) {
					debug('recall next response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;

		case 'freeze':
			log('info', 'freeze');

			if (self.eventmaster !== undefined) {
				self.eventmaster.freezeDestSource(0, parseInt(opt.frzSource), 0, 1, function(obj, res) {
					debug('freeze all response', res);
				}).on('error', function(err) {
					log('error', 'EventMaster Error: ' + err);
				});
			}
			break;

		case 'unfreeze':
			log('info', 'unfreeze');

			if (self.eventmaster !== undefined) {
				self.eventmaster.freezeDestSource(0, parseInt(opt.unfrzSource), 0, 0, function(obj, res) {
					debug('unfreeze all response', res);
				}).on('error', function(err) {
					log('error', 'EventMaster Error: ' + err);
				});
			}
			break;

		case 'frzSource':
			log('info', '(un)freeze source');

			if (self.eventmaster !== undefined) {
				self.eventmaster.freezeDestSource(0, parseInt(opt.frzSource), 0, parseInt(opt.frzType), function(obj, res) {
					debug('freeze all response', res);
				}).on('error', function(err) {
					log('error', 'EventMaster Error: ' + err);
				});
			}
			break;

			case 'frzScreenDest':
				log('info', '(un)freeze Screen Destination');

				if (self.eventmaster !== undefined) {
					self.eventmaster.freezeDestSource(2, parseInt(opt.frzDest), 0, parseInt(opt.frzType), function(obj, res) {
						debug('freeze all response', res);
					}).on('error', function(err) {
						log('error', 'EventMaster Error: ' + err);
					});
				}
				break;

		case 'frzAuxDest':
			log('info', '(un)freeze Aux Destination');

			if (self.eventmaster !== undefined) {
				self.eventmaster.freezeDestSource(3, parseInt(opt.frzDest), 0, parseInt(opt.frzType), function(obj, res) {
					debug('freeze all response', res);
				}).on('error', function(err) {
					log('error', 'EventMaster Error: ' + err);
				});
			}
			break;
		case 'preset_in_pvw':
			log('info','Recall to PVW id:' + opt.preset_in_pvw);

			if (self.eventmaster !== undefined) {
				self.eventmaster.activatePresetById(parseInt(opt.preset_in_pvw), 0, function(obj, res) {
					debug('recall preset pvw response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;

		case 'preset_in_pgm':
			log('info','Recall to PGM id:' + opt.preset_in_pgm);

			if (self.eventmaster !== undefined) {
				self.eventmaster.activatePresetById(parseInt(opt.preset_in_pgm), 1, function(obj, res) {
					debug('recall preset pgm response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;

		case 'play_cue':
			log('info','play_cue:' + opt.cueNumber);

			if (self.eventmaster !== undefined) {
				self.eventmaster.activateCueById(parseInt(opt.cueNumber), 0, function(obj, res) {
					debug('activateCue response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;

		case 'stop_cue':
			log('info','stop_cue:' + opt.cueNumber);

			if (self.eventmaster !== undefined) {
				self.eventmaster.activateCueById(parseInt(opt.cueNumber), 2, function(obj, res) {
					debug('activateCue response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;

		case 'change_aux':
			log('info', `change_aux, source: ${opt.source} destination ${opt.auxDestination}`);

			if (self.eventmaster !== undefined) {
				self.eventmaster.changeAuxContent(parseInt(opt.auxDestination), -1, parseInt(opt.source), function(obj, res) {
					debug('changeAuxContent response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;

		case 'subscribe':
			log('info', `subscribe to localhost`);

			if (self.eventmaster !== undefined) {
				self.eventmaster.subscribe(opt.ip, opt.port, ["SourceChanged","BGSourceChanged", "ScreenDestChanged", "AUXDestChanged"], function(obj, res) {
					debug('subscribe response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;

		case 'unsubscribe':
			log('info', `unsubscribe`);

			if (self.eventmaster !== undefined) {
				self.eventmaster.unsubscribe(opt.ip, opt.port, ["SourceChanged","BGSourceChanged", "ScreenDestChanged", "AUXDestChanged"], function(obj, res) {
					debug('unsubscribe response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;

		/* only available on software not yet published
		case 'testpattern_on_AUX':
			log('info', `change_testAuxPattern, id: ${opt.testPattern} destination ${opt.auxDestination}`);

			if (self.eventmaster !== undefined) {
				self.eventmaster.changeAuxContentTestPattern(parseInt(opt.auxDestination), parseInt(opt.testPattern), function(obj, res) {
					debug('changeAuxContentTestPattern response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;

		case 'testpattern_on_SCREEN':
			log('info', `change_testPattern, id: ${opt.testPattern} destination ${opt.screenDestination}`);

			if (self.eventmaster !== undefined) {
				self.eventmaster.changeContentTestPattern(parseInt(opt.screenDestination), parseInt(opt.testPattern), function(obj, res) {
					debug('changeAuxContentTestPattern response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;
		*/
		/* only available on software not yet published
		case 'armUnarmDestination':
			log('info', `armUnarmDestination, arm/unarm ${opt.armUnarm}`);
			const testArray = [{Name: 'Dest1', id: 1},{Name: 'Dest2', id: 2}];
			if (self.eventmaster !== undefined) {
				//self.eventmaster.armUnarmDestination(parseInt(opt.armUnarm), screenDestinations, auxDestinations, function(obj, res) {
				self.eventmaster.armUnarmDestination(parseInt(opt.armUnarm), testArray, {}, function(obj, res) {
					debug('armUnarmDestination response', res);
				}).on('error', function(err) {
					log('error','Eventmaster Error: '+err);
				});
			}
			break;
		*/
		/* only available on software not yet published
		case 'destinationGroup':
			log('info', `destinationGroup: ${opt.id}`)
			if (self.eventmaster !== undefined) {
				self.eventmaster.activateDestGroup(parseInt(opt.id), function(obj, res) {
					debug('activateDestGroup response', res);
				}).on('error', function(err) {
					log('error','EventMaster Error: '+ err);
				});
			}
			break;
			*/
	}
};

instance.prototype.initPresets = function (updates) {
	var self = this;
	var presets = [];

	presets.push({
		category: 'Basics',
		bank: {
			style: 'text',
			text: 'Take',
			size: '14',
			color: self.rgb(0,0,0),
			bgcolor: self.rgb(255,0,0)
		},
		actions: [
			{
				action: 'trans_all'
			}
		]
	})
	presets.push({
		category: 'Basics',
		bank: {
			style: 'text',
			text: 'Cut',
			size: '14',
			color: self.rgb(0,0,0),
			bgcolor: self.rgb(255,0,0)
		},
		actions: [
			{
				action: 'cut_all'
			}
		]
	})
	presets.push({
		category: 'Basics',
		bank: {
			style: 'text',
			text: 'Recall next',
			size: '14',
			color: self.rgb(0,0,0),
			bgcolor: self.rgb(235,0,0)
		},
		actions: [
			{
				action: 'recall_next'
			}
		]
	})
	//Load presets from eventmaster into presets from companion
	for (var preset in self.CHOICES_PRESETS) {
			presets.push({
				category: 'Presets to PVW',
				bank: {
					style: 'text',
					text: self.CHOICES_PRESETS[preset].label,
					size: '14',
					color: self.rgb(0,0,0),
					bgcolor: self.rgb(235,235,235)
				},
				actions: [
				{
					action: 'preset_in_pvw',
					options: {
						preset_in_pvw: self.CHOICES_PRESETS[preset].id
					}
				}]
			})
	}

	for (var presetPGM in self.CHOICES_PRESETS) {
			presets.push({
				category: 'Presets to PGM',
				bank: {
					style: 'text',
					text: self.CHOICES_PRESETS[presetPGM].label,
					size: '14',
					color: self.rgb(255,0,0),
					bgcolor: self.rgb(235,235,235)
				},
				actions: [
				{
					action: 'preset_in_pgm',
					options: {
						preset_in_pgm: self.CHOICES_PRESETS[presetPGM].id
					}
				}]
			})
	}

	//Load cues from eventmaster into presets from companion
	for (var cue in self.CHOICES_CUES) {
			presets.push({
				category: 'Cues',
				bank: {
					style: 'text',
					text: self.CHOICES_CUES[cue].label,
					size: '14',
					color: self.rgb(0,0,0),
					bgcolor: self.rgb(66,244,226)
				},
				actions: [
				{
					action: 'play_cue',
					options: {
						cueNumber: self.CHOICES_CUES[cue].id
					}
				}]
			})
	}
	self.setPresetDefinitions(presets);
};

instance_skel.extendedBy(instance);
exports = module.exports = instance;
