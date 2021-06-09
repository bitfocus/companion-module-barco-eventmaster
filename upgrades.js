module.exports = [
	// v0.0.* -> v0.0.4
    function (context, config, actions) {
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
	}
]