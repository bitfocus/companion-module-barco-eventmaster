const { testPattern } = require('./images')
const { combineRgb } = require('@companion-module/base')
const _ = require('lodash')

/**
 * Get all the presets
 * @returns presets
 */
module.exports = function getPresets(eventmasterData, log) {
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
	eventmasterData.presets = _.sortBy(eventmasterData.presets, 'presetSno')
	Object.keys(eventmasterData.presets).forEach((key) => {
		presets[`PVW_${eventmasterData.presets[key].id}`] = {
			type: 'button',
			category: 'Presets to PVW',
			name: `$(eventmaster:preset_${eventmasterData.presets[key].id}_number) $(eventmaster:preset_${eventmasterData.presets[key].id}_name)`,
			style: {
				text: `$(eventmaster:preset_${eventmasterData.presets[key].id}_number)\\n$(eventmaster:preset_${eventmasterData.presets[key].id}_name)`,
				size: '14',
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(235, 235, 235),
			},
			steps: [
				{
					down: [
						{
							actionId: 'recall_preset',
							options: {
								mode: '0', // 0 = PVW, 1 = PGM
								id: eventmasterData.presets[key].id,
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`PGM_${eventmasterData.presets[key].id}`] = {
			type: 'button',
			category: 'Presets to PGM',
			name: `$(eventmaster:preset_${eventmasterData.presets[key].id}_number) $(eventmaster:preset_${eventmasterData.presets[key].id}_name)`,
			style: {
				text: `$(eventmaster:preset_${eventmasterData.presets[key].id}_number)\\n$(eventmaster:preset_${eventmasterData.presets[key].id}_name)`,
				size: '14',
				color: combineRgb(255, 0, 0),
				bgcolor: combineRgb(235, 235, 235),
			},
			steps: [
				{
					down: [
						{
							actionId: 'recall_preset',
							options: {
								mode: '1', // 0 = PVW, 1 = PGM
								id: eventmasterData.presets[key].id,
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
	})
	Object.keys(eventmasterData.cues).forEach((key) => {
		presets[`Cue_${eventmasterData.cues[key].id}`] = {
			type: 'button',
			category: 'Cues',
			style: {
				text: eventmasterData.cues[key].Name,
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
								cueNumber: eventmasterData.cues[key].id,
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
	})
	// Create presets for all screen destinations
	Object.keys(eventmasterData.ScreenDestinations).forEach((key) => {
		presets[`test_pattern_Off_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.off,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '0',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_hor_ramp_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.horizontal_ramp,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '1',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_ver_ramp_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.vertical_ramp,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '2',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_100_bars_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.bars100,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '3',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_16x16_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.hatch16x16,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '4',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_32x32_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.hatch32x32,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '5',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_Burst_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.burst,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '6',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_75_bars_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.bars75,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '7',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_50_gray_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.gray50,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '8',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_hor_steps_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.horizontal_steps,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '9',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_ver_steps_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.vertical_steps,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '10',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_white_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.white,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '11',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_black_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.black,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '12',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_SMPTE_bars_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.SMPTE_bars,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '13',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_h_alignment_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.h_align,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '14',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_v_alignment_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.v_align,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '15',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_hv_alignment_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.hv_align,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '16',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_circle_alignment_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.circle_align,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '17',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_red_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.red,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '18',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_green_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.green,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '19',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_blue_screen_aux_${eventmasterData.ScreenDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.ScreenDestinations[key].Name}`,
			style: {
				png64: testPattern.blue,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_SCREEN',
							options: {
								screenDestination: `${eventmasterData.ScreenDestinations[key].id}`,
								testPattern: '20',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
	})
	// Create presets for all aux destinations
	Object.keys(eventmasterData.AuxDestinations).forEach((key) => {
		presets[`test_pattern_Off_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.off,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								screenDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '0',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_hor_ramp_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.horizontal_ramp,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '1',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_ver_ramp_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.vertical_ramp,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '2',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_100_bars_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.bars100,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '3',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_16x16_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.hatch16x16,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '4',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_32x32_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.hatch32x32,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '5',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_Burst_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.burst,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '6',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_75_bars_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.bars75,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '7',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_50_gray_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.gray50,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '8',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_hor_steps_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.horizontal_steps,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '9',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_ver_steps_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.vertical_steps,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '10',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_white_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.white,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '11',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_black_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.black,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '12',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_SMPTE_bars_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.SMPTE_bars,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '13',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_h_alignment_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.h_align,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '14',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_v_alignment_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.v_align,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '15',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_hv_alignment_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.hv_align,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '16',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_circle_alignment_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.circle_align,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '17',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_red_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.red,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '18',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_green_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.green,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '19',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
		presets[`test_pattern_blue_${eventmasterData.AuxDestinations[key].id}`] = {
			type: 'button',
			category: `Test patterns for ${eventmasterData.AuxDestinations[key].Name}`,
			style: {
				png64: testPattern.blue,
			},
			steps: [
				{
					down: [
						{
							actionId: 'testpattern_on_AUX',
							options: {
								auxDestination: `${eventmasterData.AuxDestinations[key].id}`,
								testPattern: '20',
							},
						},
					],
					up: [],
				},
			],
			feedbacks: [],
		}
	})

	// Add AUX source presets for each AUX destination
	if (eventmasterData.AuxDestinations && eventmasterData.sources) {
		Object.keys(eventmasterData.AuxDestinations).forEach((auxKey) => {
			const aux = eventmasterData.AuxDestinations[auxKey]
			const auxId = aux.id
			const auxName = aux.Name

			// Create source presets for this AUX destination
			Object.keys(eventmasterData.sources).forEach((sourceKey) => {
				const source = eventmasterData.sources[sourceKey]
				const sourceId = source.id
				const sourceNumber = sourceId + 1 // Convert to 1-based for display

				// Preset for setting this source to AUX PGM
				presets[`aux_${auxId}_pgm_source_${sourceNumber}`] = {
					type: 'button',
					category: `AUX ${auxName} - PGM Sources`,
					name: `$(eventmaster:source_${sourceNumber}_name)`,
					style: {
						text: `$(eventmaster:source_${sourceNumber}_name)`,
						size: '14',
						color: combineRgb(255, 255, 255),
						bgcolor: combineRgb(0, 0, 0),
					},
					steps: [
						{
							down: [
								{
									actionId: 'change_aux_content',
									options: {
										auxDestination: auxId,
										pgmSource: sourceId + 1000, // Use offset ID for dropdown
										pvwSource: '', // No change to PVW
										testPattern: '', // No test pattern
										auxName: '', // Don't change name
									},
								},
							],
							up: [],
						},
					],
					feedbacks: [
						{
							feedbackId: 'source_active_on_destinations',
							options: {
								source: sourceNumber,
								destinations: [`aux_${auxId}_pgm`]
							},
							style: {
								bgcolor: combineRgb(255, 0, 0), // Red when active on this AUX PGM
								color: combineRgb(255, 255, 255), // White text
							},
						},
					],
				}

				// Preset for setting this source to AUX PVW
				presets[`aux_${auxId}_pvw_source_${sourceNumber}`] = {
					type: 'button',
					category: `AUX ${auxName} - PVW Sources`,
					name: `$(eventmaster:source_${sourceNumber}_name)`,
					style: {
						text: `$(eventmaster:source_${sourceNumber}_name)`,
						size: '14',
						color: combineRgb(255, 255, 255),
						bgcolor: combineRgb(0, 102, 0), // Dark green for PVW
					},
					steps: [
						{
							down: [
								{
									actionId: 'change_aux_content',
									options: {
										auxDestination: auxId,
										pgmSource: '', // No change to PGM
										pvwSource: sourceId + 1000, // Use offset ID for dropdown
										testPattern: '', // No test pattern
										auxName: '', // Don't change name
									},
								},
							],
							up: [],
						},
					],
					feedbacks: [
						{
							feedbackId: 'source_active_on_destinations',
							options: {
								source: sourceNumber,
								destinations: [`aux_${auxId}_pvw`]
							},
							style: {
								bgcolor: combineRgb(0, 255, 0), // Green when active on this AUX PVW
								color: combineRgb(0, 0, 0), // Black text for contrast
							},
						},
					],
				}
			})

			// Add a "Clear" preset for each AUX destination
			presets[`aux_${auxId}_clear_pgm`] = {
				type: 'button',
				category: `AUX ${auxName} - PGM Sources`,
				name: 'Clear PGM',
				style: {
					text: 'Clear\\nPGM',
					size: '14',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(100, 100, 100), // Dark gray
				},
				steps: [
					{
						down: [
							{
								actionId: 'change_aux_content',
								options: {
									auxDestination: auxId,
									pgmSource: -1, // Clear source (set to -1)
									pvwSource: '', // No change to PVW
									testPattern: '', // No test pattern
									auxName: '', // Don't change name
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}

			presets[`aux_${auxId}_clear_pvw`] = {
				type: 'button',
				category: `AUX ${auxName} - PVW Sources`,
				name: 'Clear PVW',
				style: {
					text: 'Clear\\nPVW',
					size: '14',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(100, 100, 100), // Dark gray
				},
				steps: [
					{
						down: [
							{
								actionId: 'change_aux_content',
								options: {
									auxDestination: auxId,
									pgmSource: '', // No change to PGM
									pvwSource: -1, // Clear source (set to -1)
									testPattern: '', // No test pattern
									auxName: '', // Don't change name
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}
		})
	}

	// Add Arm/Unarm presets for Screen Destinations
	if (eventmasterData.ScreenDestinations) {
		Object.keys(eventmasterData.ScreenDestinations).forEach((key) => {
			const screen = eventmasterData.ScreenDestinations[key]
			const screenId = screen.id
			const screenName = screen.Name

			// Arm preset
			presets[`screen_${screenId}_arm`] = {
				type: 'button',
				category: `Arm/Unarm Destinations`,
				name: `Arm $(eventmaster:screen_${screenId}_name)`,
				style: {
					text: `ARM\\n$(eventmaster:screen_${screenId}_name)`,
					size: '14',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 128, 0), // Green for arm
				},
				steps: [
					{
						down: [
							{
								actionId: 'arm_unarm_destination',
								options: {
									destId: screenId,
									arm: 1, // 1 = Arm
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}

			// Unarm preset
			presets[`screen_${screenId}_unarm`] = {
				type: 'button',
				category: `Arm/Unarm Destinations`,
				name: `Unarm $(eventmaster:screen_${screenId}_name)`,
				style: {
					text: `UNARM\\n$(eventmaster:screen_${screenId}_name)`,
					size: '14',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(128, 0, 0), // Red for unarm
				},
				steps: [
					{
						down: [
							{
								actionId: 'arm_unarm_destination',
								options: {
									destId: screenId,
									arm: 0, // 0 = Unarm
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}
		})
	}

	// Add Arm/Unarm presets for AUX Destinations
	if (eventmasterData.AuxDestinations) {
		Object.keys(eventmasterData.AuxDestinations).forEach((key) => {
			const aux = eventmasterData.AuxDestinations[key]
			const auxId = aux.id
			const auxName = aux.Name

			// Arm preset
			presets[`aux_${auxId}_arm`] = {
				type: 'button',
				category: `Arm/Unarm Destinations`,
				name: `Arm $(eventmaster:aux_${auxId}_name)`,
				style: {
					text: `ARM\\n$(eventmaster:aux_${auxId}_name)`,
					size: '14',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 128, 0), // Green for arm
				},
				steps: [
					{
						down: [
							{
								actionId: 'arm_unarm_aux_destination',
								options: {
									auxDestId: auxId,
									arm: 1, // 1 = Arm
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}

			// Unarm preset
			presets[`aux_${auxId}_unarm`] = {
				type: 'button',
				category: `Arm/Unarm Destinations`,
				name: `Unarm $(eventmaster:aux_${auxId}_name)`,
				style: {
					text: `UNARM\\n$(eventmaster:aux_${auxId}_name)`,
					size: '14',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(128, 0, 0), // Red for unarm
				},
				steps: [
					{
						down: [
							{
								actionId: 'arm_unarm_aux_destination',
								options: {
									auxDestId: auxId,
									arm: 0, // 0 = Unarm
								},
							},
						],
						up: [],
					},
				],
				feedbacks: [],
			}
		})
	}

	// Create source feedback presets - status indicators only, no actions
	if (eventmasterData && eventmasterData.sources && Object.keys(eventmasterData.sources).length > 0) {
		Object.keys(eventmasterData.sources).forEach((sourceKey) => {
			const source = eventmasterData.sources[sourceKey]
			const sourceNumber = source.id + 1 // Convert to 1-based numbering
			
			presets[`source_${sourceNumber}_feedback`] = {
				type: 'button',
				category: 'Sources Feedback (simple)',
				name: `$(eventmaster:source_${sourceNumber}_name)`,
				style: {
					text: `$(eventmaster:source_${sourceNumber}_name)`,
					size: '14',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(64, 64, 64), // Default gray
				},
				steps: [
					{
						down: [], // No action when pressed
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'source_active_simple',
						options: {
							source: sourceNumber,
							tallyState: 'pvw' // Only indicate PVW status
						},
						style: {
							bgcolor: combineRgb(0, 255, 0), // Green when active
						},
					},
					{
						feedbackId: 'source_active_simple',
						options: {
							source: sourceNumber,
							tallyState: 'pgm' // Only indicate PGM status
						},
						style: {
							bgcolor: combineRgb(255, 0, 0), // Red when active
						},
					},
				],
			}

			presets[`source_${sourceNumber}_feedback_advanced`] = {
				type: 'button',
				category: 'Sources Feedback (advanced)',
				name: `$(eventmaster:source_${sourceNumber}_name)`,
				style: {
					text: `$(eventmaster:source_${sourceNumber}_name)`,
					size: '14',
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(64, 64, 64), // Default gray
				},
				steps: [
					{
						down: [], // No action when pressed
						up: [],
					},
				],
				feedbacks: [
					{
						feedbackId: 'source_active_on_destinations',
						options: {
							source: sourceNumber,
							tallyState: 'pvw', // Only indicate PVW status
							destinations: ['anywhere'] // All destinations
						},
						style: {
							bgcolor: combineRgb(0, 255, 0), // Green when active
							color: combineRgb(0, 0, 0), // Black text for contrast
						},
					},
					{
						feedbackId: 'source_active_on_destinations',
						options: {
							source: sourceNumber,
							tallyState: 'pgm', // Only indicate PGM status
							destinations: ['anywhere'] // All destinations
						},
						style: {
							bgcolor: combineRgb(255, 0, 0), // Red when active
							color: combineRgb(255, 255, 255), // White text for contrast
						},
					},
				],
			}
		})
	}

	return presets
}
