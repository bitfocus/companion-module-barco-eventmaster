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

	self.status(self.STATE_UNKNOWN);

	debug('creating eventmaster');

	self.ok = false;
	self.retry_interval = setInterval(self.retry.bind(self), 15000);
	self.retry();

	self.actions();
};

instance.prototype.updateConfig = function(config) {
	var self = this;

	self.config = config;
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

instance.prototype.CHOICES_TYPEOFSOURCE = [
	{ label: 'Input',              id: '0' },
	{ label: 'Background',         id: '1' },
	{ label: 'Screen destination', id: '2' },
	{ label: 'Aux destination',    id: '3' }
];

instance.prototype.updateChoices = function(arguments) {
	var self = this;

	if (self.eventmaster !== undefined) {
		self.eventmaster.listPresets(-1, -1, function(obj, res) {

			if (res !== undefined) {
				for (var n in res) {
					var preset = res[n];

					self.CHOICES_PRESETS.push({ label: preset.Name, id: preset.id });
				}

				self.system.emit('instance_actions', self.id, actions);
			}

		}).on('error', function(err) {
			log('error', 'EventMaster Error: ' + err);
		});

		self.eventmaster.listSources(0, function(obj, res) {

			if (res !== undefined) {
				for (var n in res) {

					var source = res[n];

					self.CHOICES_SOURCES.push({ label: source.Name, id: source.id});
				}
			}

			self.system.emit('instance_actions', self.id, actions);

		}).on('error', function(err) {
			log('error','EventMaster Error: '+ err);
		});
	}
};

instance.prototype.actions = function(system) {
	var self = this;
	self.CHOICES_PRESETS = [];
	self.CHOICES_SOURCES = [];

	var actions = {
		'trans_all': { label: 'Take/Trans Active' },
		'cut_all': { label: 'Cut Active' },
		'recall_next': { label: 'Recall Next Preset' },
		'freeze': {
			label: 'Freeze',
			options: [{
				type: 'dropdown',
				label: 'Source',
				id: 'frzSource',
				choices: self.CHOICES_SOURCES
			}]
		},
		'unfreeze': {
			label: 'Unfreeze',
			options: [{
				type: 'dropdown',
				label: 'Source',
				id: 'unfrzSource',
				choices: self.CHOICES_SOURCES
			}]
		},
		'preset_in_pvw': {
			label: 'Preset in PVW',
			options: [{
				type: 'dropdown',
				label: 'Preset',
				id: 'preset_in_pvw',
				choices: self.CHOICES_PRESETS
			}]
		},
		'preset_in_pgm': {
			label: 'Preset in PGM',
			options: [{
				type: 'dropdown',
				label: 'Preset',
				id: 'preset_in_pgm',
				choices: self.CHOICES_PRESETS
			}]
		}
	};

	self.system.emit('instance_actions', self.id, actions);
}

instance.prototype.action = function(action) {
	var self = this;
	var id = action.action;
	var opt = action.options;

	debug('run action:', id);
	if (id == 'trans_all') {
		log('info','Trans/Take All');

		if (self.eventmaster !== undefined) {
			self.eventmaster.allTrans(function(obj, res) {
				debug('trans all response', res);
			}).on('error', function(err) {
				log('error','EventMaster Error: '+ err);
			});

		}
	}	else if (id == 'cut_all') {
		log('info','Cut All');

		if (self.eventmaster !== undefined) {
			self.eventmaster.cut(function(obj, res) {
				debug('cut all response', res);
			}).on('error', function(err) {
				log('error','EventMaster Error: '+ err);
			});
		}
	} else if (id == 'recall_next') {
		log('info','recall_next');

		if (self.eventmaster !== undefined) {
			self.eventmaster.recallNextPreset(function(obj, res) {
				debug('recall next response', res);
			}).on('error', function(err) {
				log('error','EventMaster Error: '+ err);
			});
		}
	} else if (id == 'freeze') {
		log('info', 'freeze');

		if (self.eventmaster !== undefined) {
			self.eventmaster.freezeDestSource(0, parseInt(opt.frzSource), 0, 1, function(obj, res) {
				debug('freeze all response', res);
			}).on('error', function(err) {
				log('error', 'EventMaster Error: ' + err);
			});
		}
	} else if (id == 'unfreeze') {
		log('info', 'unfreeze');

		if (self.eventmaster !== undefined) {
			self.eventmaster.freezeDestSource(0, parseInt(opt.unfrzSource), 0, 0, function(obj, res) {
				debug('unfreeze all response', res);
			}).on('error', function(err) {
				log('error', 'EventMaster Error: ' + err);
			});
		}
	} else if (id == 'preset_in_pvw') {
		if (self.eventmaster !== undefined) {
			log('info','Recall to PVW id:' + id)
			self.eventmaster.activatePresetById(parseInt(opt.preset_in_pvw), 0, function(obj, res) {
				debug('recall preset pvw response', res);
			}).on('error', function(err) {
				log('error','EventMaster Error: '+ err);
			});
		}
	} else if (id == 'preset_in_pgm') {
		if (self.eventmaster !== undefined) {
			log('info','Recall to PGM id:' + id)
			self.eventmaster.activatePresetById(parseInt(opt.preset_in_pgm), 0, function(obj, res) {
				debug('recall preset pgm response', res);
			}).on('error', function(err) {
				log('error','EventMaster Error: '+ err);
			});
		}
	}

};

instance.module_info = {
	label: 'Barco EventMaster JSON',
	id: 'eventmaster',
	version: '0.0.4'
};

instance_skel.extendedBy(instance);
exports = module.exports = instance;
