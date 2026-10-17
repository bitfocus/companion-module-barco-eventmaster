module.exports = [
	// The aux test pattern Off preset set screenDestination, but testpattern_on_AUX reads auxDestination,
	// so buttons made from it sent no aux id. Move the value across on existing buttons.
	function fixAuxTestPatternDestination(_context, props) {
		const updatedActions = []
		for (const action of props.actions) {
			if (action.actionId !== 'testpattern_on_AUX') continue
			if (action.options.auxDestination !== undefined || action.options.screenDestination === undefined) continue
			action.options.auxDestination = action.options.screenDestination
			delete action.options.screenDestination
			updatedActions.push(action)
		}
		return { updatedConfig: null, updatedActions, updatedFeedbacks: [] }
	},
]
