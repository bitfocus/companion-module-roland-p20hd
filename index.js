// Roland-P20HD

const { InstanceBase, Regex, combineRgb, runEntrypoint, TCPHelper } = require('@companion-module/base')
const UpgradeScripts = require('./upgrades')


class p20hdInstance extends InstanceBase {
	constructor(internal) {
		super(internal)

		this.CONTROL_STX = '\u0002'
		this.CONTROL_ACK = '\u0006'

		this.cmdPipe = []
		this.pollTimer = undefined

		this.lastReturnedCommand = ''
		
		this.auth = {
			sendUserId: false,
			sendPassword: false,
			accepted: false
		}

		this.data = {
			project_open: false,
			recording: false,
			playing: false,
			playback_speed: 0,
			set_playback_speed: 0,
			playback_range: '',
			in_point: false,
			audio_level: -80.1,
			in_config: 1,
			out_config: 0,
			selected_playlist: -1,
			selected_playlist_length: 0,
			selected_number: -1,
			cued_playlist: -1,
			cued_number: -1,
			audio_clips: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			audio_index: 0,
			audio_next: true,
			still_images: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
			still_index: 0,
			still_next: true,
		}

		this.pollCommands = ['QPJ', 'QMD', 'QRC', 'QPL', 'QSP', 'QSR', 'QMI', 'QIS', 'QOS', 'QAL', 'QPS', 'QCS', 'QPQ', 'QCQ', 'QAX', 'QSX', 'QNC']

	}

	async destroy() {
		if (this.socket !== undefined) {
			this.sendCommand('QIT') //close socket
			this.socket.destroy()
		}

		if (this.pollTimer !== undefined) {
			clearInterval(this.pollTimer)
			delete this.pollTimer
		}
	}

	async init(config) {
		this.updateStatus('connecting')
		this.configUpdated(config)
	}

	async configUpdated(config) {
		// polling is running and polling has been de-selected by config change
		if (this.pollTimer !== undefined) {
			clearInterval(this.pollTimer)
			delete this.pollTimer
		}
		this.config = config
		
		this.initActions()
		this.initFeedbacks()
		this.initVariables()
		this.initPresets()

		this.init_tcp()
	}

	init_tcp() {
		let pipeline = ''

		if (this.socket !== undefined) {
			this.socket.destroy()
			delete this.socket
		}

		if (this.config.port === undefined) {
			this.config.port = 8023
		}

		if (this.config.host) {
			this.socket = new TCPHelper(this.config.host, this.config.port)

			this.socket.on('status_change', (status, message) => {
				this.updateStatus(status, message)
			})

			this.socket.on('error', (err) => {
				this.log('error', 'Network error: ' + err.message)
				this.updateStatus('connection_failure', 'Unable to connect')
				clearInterval(this.pollTimer);
				this.socket.destroy()
				this.socket == null
			})

			this.socket.on('connect', () => {
				this.cmdPipe = []
				this.initLoginUser();
			})

			this.socket.on('data', (receivebuffer) => {
				pipeline = receivebuffer.toString('utf8')

				// Every response will end with ACK, NACK or ';'

				if (pipeline.includes(this.CONTROL_NACK)) { // When NACK is received
					this.log('error', `Command ${this.lastReturnedCommand} was not accepted by the device`)
					if (this.lastReturnedCommand.indexOf('PSS') > -1) {
						this.log('error', `The password was probably wrong`);
					}

					if (this.socket !== undefined) {
						this.sendCommand('QIT') //close socket
						this.socket.destroy()
					}
			
					if (this.pollTimer !== undefined) {
						clearInterval(this.pollTimer)
						delete this.pollTimer
					}
				}
				else if (pipeline.includes(this.CONTROL_ACK)) { // When ACK is received
					if (this.auth.sendUserId && !this.auth.accepted) { //if the userid was sent, but connection isn't authenticated, send the password
						this.initLoginPassword();
						this.sendCommand('VER');
					}
				}
				else if (pipeline.includes('VER') && this.auth.sendPassword && !this.auth.accepted) { //if the pipeline contains the version string, the password command was sent and authentication is not accepted, we are now accepted
					this.auth.accepted = true
					console.log("User ID and Password Accepted")
					this.initCommunication();
				}

				this.lastReturnedCommand = this.cmdPipeNext() //returns the last command and runs the next one

				if (pipeline.length == 1) pipeline = ''
				
				if (pipeline.includes(';')) { // We already processed ACK and NACK, so if there are any commands left, they will end with ;
					let allResponses = pipeline.split(';'); // If multiple commands are received, we can split the pipeline to get individual commands

					allResponses.forEach((response) => {
						if (response.length > 0 && response.includes(':')) {
							this.processResponse(response)
						}
					});
				}
							
			})
		}
	}

	cmdPipeNext() {
		let return_cmd;
		if (this.cmdPipe.length > 0) {
			return_cmd = this.cmdPipe.shift()
		}

		if(this.cmdPipe.length > 0) {
			this.socket.send(this.CONTROL_STX + this.cmdPipe[0] + ';')
			
			if (this.cmdPipe[0].includes('PSS:')) {
				console.log(this.cmdPipe)
				return_cmd = this.cmdPipe.shift()
				console.log(this.cmdPipe)

				if(this.cmdPipe.length > 0) {
					this.socket.send(this.CONTROL_STX + this.cmdPipe[0] + ';')
				}
			}
		}

		return return_cmd
	}

	initLoginUser() {
		this.auth.sendUserId = true
		this.sendCommand(`USR:${this.config.userId}`); //send username
	}

	initLoginPassword() {
		this.auth.sendPassword = true
		this.sendCommand(`PSS:${this.config.password}`); //send password
	}

	initCommunication() {
		if (this.communicationInitiated !== true) {
			this.initPolling()
			this.updateStatus('ok')

			this.communicationInitiated = true;
		}		
	}

	processResponse(response) {
		response = response.split(':')
		let category = response[0].slice(1)
		let args = response[1].split(',')

		const errorMessage = (errcode) => {
			let errstring = ''
			switch (errcode) {
				case '0':
					errstring = '(Syntax Error)'
					break
				case '4':
					errstring = '(Invalid Function Error)'
					break
				case '5':
					errstring = '(Out of Range Error)'
					break
				default:
					errstring = '(UNKNOWN Error)'
					break
			}
			this.log('error', 'ERR: ' + errstring + ' - Command = ' + this.lastReturnedCommand)
		}
 
		switch (category) {
			case 'VER': //version
				this.setVariableValues({
					product: args[0],
					version: args[1]
				})
				break
			case 'QPJ': //check for open project
				this.data.project_open = parseInt(args[0]) == 1 ? true : false
				this.setVariableValues({
					project_open: this.data.project_open
				})
				break
			case 'QMD': //get project recording/playback mode
				this.setVariableValues({
					project_mode: parseInt(args[0]) == 0 ? 'Resolution' : 'Frame Rate'
				})
				break
			case 'QRC': //get recording status
				this.data.recording = parseInt(args[0]) == 1 ? true : false
				this.setVariableValues({
					recording: this.data.recording
				})
				if (this.data.recording) {
					this.setVariableValues({
						// recording_label: '&#9209;'
						recording_label: 'Stop'
					})
				}
				else {
					this.setVariableValues({
						// recording_label: '&#9210;'
						recording_label: 'Rec'
					})
				}
				break
			case 'QPL': //get playback status
				let playing = parseInt(args[0]) == 0 ? false : true
				if (!playing && this.data.playing) {
				}
				this.data.playing = parseInt(args[0]) == 0 ? false : true
				this.setVariableValues({
					playing: this.data.playing
				})
				break
			case 'QSP': //get playback speed
				this.data.playback_speed = parseInt(args[0])
				this.setVariableValues({
					playback_speed: this.data.playback_speed
				})
				break
			case 'QSR': //get playback range
				this.data.playback_range = parseInt(args[0])
				this.setVariableValues({
					playback_range: parseInt(args[0]) == 1 ? 'Lit' : 'Unlit'
				})
				break
			case 'QMI': //get in point status
				this.data.in_point = parseInt(args[0]) == 1 ? true : false
				this.setVariableValues({
					in_point: this.data.in_point
				})
				break
			case 'QIS': //get input selection status
				this.data.in_config = parseInt(args[0])
				let inputStatus = ''
				
				if (this.data.in_config == 1) {
					inputStatus = 'Live 1'
				}
				else if (this.data.in_config == 2) {
					inputStatus = 'Live 2'
				}
				else if (this.data.in_config == 3) {
					inputStatus = 'PinP'
				}
				else if (this.data.in_config == 4) {
					inputStatus = 'Split'
				}

				this.setVariableValues({
					input_selection_status: inputStatus
				})
				break
			case 'QOS': //get output selection status
			this.data.out_config = parseInt(args[0])
				this.setVariableValues({
					output_selection_status: this.data.out_config == 1 ? 'Live' : 'Replay'
				})
				break
			case 'QAL': //get audio level
				this.data.audio_level = parseInt(args[0]) / 10
				if (this.data.audio_level == -80.1) {
					this.setVariableValues({
						audio_level: '-INF'
					})
				}
				else {
					this.setVariableValues({
						audio_level: this.data.audio_level
					})
				}

				break
			case 'QPS': //get playlist containing currently selected clip
				this.data.selected_playlist = parseInt(args[0])
				if (this.data.selected_playlist == 0) {
					this.setVariableValues({
						selected_clip_playlist: 'Clip List'
					})
				}
				else {
					this.setVariableValues({
						selected_clip_playlist: 'Palette ' + this.data.selected_playlist
					})
				}
				break
			case 'QCS': //get number of currently selected clip
				this.data.selected_number = parseInt(args[0])
				this.setVariableValues({
					selected_clip_number: this.data.selected_number
				})
				break
			case 'QPQ': //get playlist containing cued-up clip
				this.data.cued_playlist = parseInt(args[0])
				if (this.data.cued_playlist == 0) {
					this.setVariableValues({
						cued_clip_playlist: 'Clip List'
					})
				}
				else {
					this.setVariableValues({
						cued_clip_playlist: 'Palette ' + this.data.cued_playlist
					})
				}
				break
			case 'QCQ': //get number of currently queued clip
				this.data.cued_number = parseInt(args[0])
				this.setVariableValues({
					cued_clip_number: this.data.cued_number
				})
				break
			case 'QCX': //this command returns very specific information and is not required for general feedback
				break
			case 'QAX': //get availability of audio clip at asked position (we are iterating over all 16 position one at a time)
				this.data.audio_clips[this.data.audio_index] = parseInt(args[0])
				this.data.audio_index += 1
				if (this.data.audio_index > 15) {this.data.audio_index = 0}
				this.data.audio_next = true
				break
			case 'QSX': //get availability of still image at asked position (we are iterating over all 16 position one at a time)
				this.data.still_images[this.data.still_index] = parseInt(args[0])
				this.data.still_index += 1
				if (this.data.still_index > 15) {this.data.still_index = 0}
				this.data.still_next = true
				break
			case 'QNC': //get total amount of clips in playlist of selected clip
				this.data.selected_playlist_length = parseInt(args[0])
				this.setVariableValues({
					selected_clip_playlist_length: this.data.selected_playlist_length
				})
				break
			case 'ERR': //no need to log errors during normal operation
				// errorMessage(args[0])
			break
		}

		this.checkFeedbacks()
	}
	sendCommand(cmd) {
		if (cmd !== undefined) {
			if (this.socket !== undefined && this.socket.isConnected) {
				this.cmdPipe.push(cmd)

				if(this.cmdPipe.length === 1) {
					this.socket.send(this.CONTROL_STX + cmd + ';')
				}
			} else {
				this.log('error', 'Network error: Connection to Device not opened.')
				clearInterval(this.pollTimer);
			}
		}
	}

	initPolling() {
		if (this.pollTimer === undefined && this.config.pollInterval > 0) {
			this.pollTimer = setInterval(() => {
				this.sendPollCommands(this.pollCommands)
			}, this.config.pollInterval)
		}
	}

	sendPollCommands(pollCmds=[]) {
		if (this.socket !== undefined && this.socket.isConnected) {
			let cmdStr;
			pollCmds.forEach((cmd) => {
				if (cmd == 'QAX' && this.data.audio_next) { //catch QAX command to add parameter
					cmd = cmd + ':' + (this.data.audio_index + 1)
					this.data.audio_next = false
				}
				else if (cmd == 'QSX' && this.data.still_next) { //catch QSX command to add parameter
					cmd = cmd + ':' + (this.data.still_index + 1)
					this.data.still_next = false
				}
				else if (cmd == 'QNC' && this.data.selected_playlist >= 0 && this.data.selected_playlist <= 8) { //catch QNC command to add parameter
					cmd = cmd + ':' + this.data.selected_playlist
				}
				else if (['QAX', 'QSX', 'QNC'].includes(cmd)) {
					return
				}
				if (cmdStr == undefined) {
					cmdStr = this.CONTROL_STX + cmd + ';';
				}
				else {
					cmdStr = cmdStr + this.CONTROL_STX + cmd + ';'; //chain all poll commands together to only make a single request for all
				}
			});
			if (pollCmds.length > 0) {
				this.socket.send(cmdStr);
			}
			else {
				console.log('No commands for polling!')
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
				value: 'This module will connect to a Roland P-20HD Video Replay Device',
			},
			{
				type: 'textinput',
				id: 'host',
				label: 'IP Address',
				width: 6,
				default: '169.254.9.184',
				regex: Regex.IP,
			},
			{
				type: 'number',
				id: 'pollInterval',
				label: 'Polling Interval (ms), set to 0 to disable polling',
				min: 50,
				max: 1000,
				default: 100,
				width: 3,
			},
			{
				type: 'textinput',
				id: 'userId',
				label: 'User ID',
				width: 6,
				default: 'AAAA',
			},
			{
				type: 'textinput',
				id: 'password',
				label: 'Password',
				width: 6,
				default: 'AAAAAAAA',
			},
		]
	}

	initActions() {
		let actions = {
			recording: {
				name: 'Start/Stop Recording',
				options: [
					{
						type: 'dropdown',
						label: 'Mode',
						id: 'mode',
						default: 'TOG',
						choices: [
							{'id': 'TOG', 'label': 'Toggle'},
							{'id': 'REC', 'label': 'Start'},
							{'id': 'RES', 'label': 'Stop'}
						]
					},
				],
				callback: async (event) => {
					if (event.options.mode == 'TOG') {
						if (this.data.recording) {
							this.sendCommand('RES')
						}
						else {
							this.sendCommand('REC')
						}
					}
					else {
						this.sendCommand(event.options.mode)
					}
				},
			},
			playback: {
				name: 'Play/Pause',
				options: [
					{
						type: 'dropdown',
						label: 'Mode',
						id: 'mode',
						default: 'TOG',
						choices: [
							{'id': 'TOG', 'label': 'Toggle'},
							{'id': 'PLY', 'label': 'Play'},
							{'id': 'PUS', 'label': 'Pause'}
						]
					}
				],
				callback: async (event) => {
					if (event.options.mode == 'TOG') {
						if (this.data.playing) {
							this.sendCommand('PUS')
						}
						else {
							this.sendCommand('PLY')
						}
					}
					else {
						this.sendCommand(event.options.mode)
					}
				}, 
			},
			jog: {
				name: 'Jog',
				options: [
					{
						type: 'dropdown',
						label: 'Direction',
						id: 'direction',
						default: 1,
						choices: [
							{id: 1, label: 'Forward'},
							{id: -1, label: 'Reverse'}
						]
					}
				],
				callback: async (event) => {
					this.sendCommand('JOG:' + event.options.direction)
				},
			},
			shuttle: {
				name: 'Shuttle',
				options: [
					{
						type: 'dropdown',
						label: 'Direction',
						id: 'direction',
						default: 'for',
						choices: [
							{id: 'for', label: 'Forward'},
							{id: 'rev', label: 'Reverse'}
						]
					},
					{
						type: 'dropdown',
						label: 'Speed',
						id: 'speed',
						default: 1,
						choices: [
							{ id: 1, label: 'x1'},
							{ id: 2, label: 'x2'},
							{ id: 3, label: 'x4'},
							{ id: 4, label: 'x8'},
							{ id: 5, label: 'x16'},
							{ id: 6, label: 'x32'},
							{ id: 7, label: 'x64'},
							{ id: 8, label: 'x128'},
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('SHT:' + event.options.direction.replace('for', '').replace('rev', '-') + event.options.speed)
				},
			},
			playback_speed: {
				name: 'Set Playback Speed',
				options: [
					{
						id: 'mode',
						type: 'dropdown',
						label: 'Mode',
						default: 'set',
						choices: [
							{id: 'set', label: 'Set'},
							{id: 'inc', label: 'Increase'},
							{id: 'dec', label: 'Decrease'}
						]
					},
					{
						id: 'speed',
						type: 'number',
						label: 'Speed',
						default: 100,
						min: 0,
						max: 100
					},
					{
						id: 'play',
						type: 'checkbox',
						label: 'Try auto play',
						default: false,
					},
					{
						id: 'limit',
						type: 'checkbox',
						label: 'Limit to max 99% to prevent output lag',
						default: false,
					}
				],
				callback: async (event) => {
					let newSpeed = event.options.speed
					if (event.options.mode == 'inc') {
						newSpeed += this.data.playback_speed
						if (newSpeed > 100) {
							newSpeed = 100
						}
					}
					else  if (event.options.mode == 'dec') {
						newSpeed = this.data.playback_speed - newSpeed
						if (newSpeed < 0) {
							newSpeed = 0
						}
					}
					else if (event.options.play && !this.data.playing) {
						this.data.set_playback_speed = 0
						this.sendCommand('SPC:0')
					}
					if (event.options.limit && newSpeed > 99) {
						newSpeed = 99
					}
					if (event.options.speed == this.data.set_playback_speed) {
						this.sendCommand('SPC:' + (newSpeed - 1))
					}
					this.data.set_playback_speed = newSpeed
					this.sendCommand('SPC:' + newSpeed)
				}
			},
			speed_range: {
				name: 'Speed Range ON/OFF',
				options: [
					{
						type: 'dropdown',
						label: 'State',
						id: 'state',
						default: '0',
						choices: [
							{ id: '0',  label: 'ON'},
							{ id: '1',  label: 'OFF'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('SPR:' + event.options.state)
				},
			},
			keyframes: {
				name: 'Set IN/OUT Point',
				options: [
					{
						type: 'dropdown',
						label: 'Type',
						id: 'type',
						default: 'MIN',
						choices: [
							{id: 'MIN',  label: 'IN Point'},
							{id: 'MOT',  label: 'OUT Point'}
						]
					},
					{
						type: 'dropdown',
						label: 'Source',
						id: 'source',
						default: 0,
						choices: [
							{ id: 0,  label: 'Replay'},
							{ id: 1,  label: 'Live'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand(event.options.type + ':' + event.options.source)
				},
			},
			clip_create: {
				name: 'Create Clip',
				options: [
					{
						type: 'dropdown',
						label: 'Setting',
						id: 'setting',
						default: -1,
						choices: [
							{id: -1, label: 'From Selected Output'},
							{id: 0, label: 'From Replay'},
							{id: 1, label: 'From Live'}
						]
					},
				],
				callback: async (event) => {
					let setting = event.options.setting
					if (setting == -1) {
						setting = this.data.out_config
					}
					this.sendCommand('MCL:' + setting)
				},
			},
			clip_actions: {
				name: 'Clip Actions',
				options: [
					{
						type: 'dropdown',
						label: 'Action',
						id: 'action',
						default: 'CLS',
						choices: [
							{id: 'CLS', label: 'Select'},
							{id: 'CLQ', label: 'Cue Up'},
							{id: 'CLD', label: 'Delete'},
						]
					},
					{
						type: 'number',
						label: 'Number (0 = selected clip | -1 = last clip in playlist)',
						id: 'number',
						default: 1,
						min: -1,
						max: 512,
					},
				],
				callback: async (event) => {
					if (event.options.number == -1) {
						this.sendCommand(event.options.action + ':' + this.data.selected_playlist_length)
					}
					else if (event.options.number == 0) {
						this.sendCommand(event.options.action + ':' + this.data.selected_number)
					}
					else {
						this.sendCommand(event.options.action + ':' + event.options.number)
					}
				},
			},
			play_clip: {
				name: 'Play Selected Clip',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('APC')
				},
			},
			bookmarks: {
				name: 'Create/Delete Bookmarks',
				options: [
					{
						type: 'dropdown',
						label: 'Action',
						id: 'action',
						default: 0,
						choices: [
							{id: 0, label: 'Set New Bookmark'},
							{id: 1, label: 'Delete Bookmark'}
						]
					},
					{
						type: 'dropdown',
						label: 'Timeline (only necessary if Action = "Set New Bookmark")',
						id: 'timeline',
						default: 0,
						choices: [
							{id: 0, label: 'Replay'},
							{id: 1, label: 'Live'}
						]
					},
				],
				callback: async (event) => {
					if (event.options.action == 0) {
						this.sendCommand('BMK:' + event.options.timeline)
					}
					else {
						this.sendCommand('DMK')
					}
				},
			},
			switch_input: {
				name: 'Switch Input',
				options: [
					{
						type: 'dropdown',
						label: 'Setting',
						id: 'setting',
						default: 1,
						choices: [
							{ id: 1,  label: 'Live 1'},
							{ id: 2,  label: 'Live 2'},
							{ id: 3,  label: 'PinP'},
							{ id: 4,  label: 'Split'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('SLI:' + event.options.setting)
				},
			},
			switch_output: {
				name: 'Switch Output',
				options: [
					{
						type: 'dropdown',
						label: 'Setting',
						id: 'setting',
						default: 0,
						choices: [
							{id: 0,  label: 'Replay'},
							{id: 1,  label: 'Live'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('SLO:' + event.options.setting)
				},
			},
			timeline: {
				name: 'Jump to Markers in Timeline',
				options: [
					{
						type: 'dropdown',
						label: 'Setting',
						id: 'setting',
						default: 'JNB',
						choices: [
							{id: 'JNB', label: 'Next Bookmark'},
							{id: 'JPB', label: 'Previous Bookmark'},
							{id: 'JTP', label: 'Beginning'},
							{id: 'JED', label: 'End'},
						]
					}
				],
				callback: (event) => {
					this.sendCommand(event.options.setting)
				}
			},
			playlist_select: {
				name: 'Select Playlist',
				options: [
					{
						type: 'dropdown',
						label: 'Playlist',
						id: 'playlist',
						default: 0,
						choices: [
							{id: 0,  label: 'Clip List'},
							{id: 1,  label: 'Palette 1'},
							{id: 2,  label: 'Palette 2'},
							{id: 3,  label: 'Palette 3'},
							{id: 4,  label: 'Palette 4'},
							{id: 5,  label: 'Palette 5'},
							{id: 6,  label: 'Palette 6'},
							{id: 7,  label: 'Palette 7'},
							{id: 8,  label: 'Palette 8'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('PLS:' + event.options.playlist)
				},
			},
			playlist_autoplay: {
				name: 'Start/Stop Autoplay of selected Playlist',
				options: [
					{
						type: 'dropdown',
						label: 'Mode',
						id: 'mode',
						default: 'TOG',
						choices: [
							{'id': 'TOG', 'label': 'Toggle'},
							{'id': 'APL:', 'label': 'Start'},
							{'id': 'SAP', 'label': 'Stop'}
						]
					},
					{
						type: 'number',
						label: 'Start (0 = selected clip, -1 = last clip)',
						id: 'number',
						default: 1,
						min: -1,
						max: 512
					},
				],
				callback: async (event) => {
					let start = event.options.mode
					let number = event.options.number
					if (start == 'TOG') {
						if (this.data.playing) {
							start = 'SAP'
						}
						else {
							start = 'APL'
						}
					}
					if (number == -1) {
						number = this.data.selected_playlist_length
					}
					else if (number == 0) {
						number = this.data.selected_number
					}
					if (start == 'SAP') {
						this.sendCommand('SAP')
					}
					else {
						this.sendCommand('APL:' + number)
					}
				},
			},
			palette_add: {
				name: 'Add Current Clip to Palette',
				options: [
					{
						type: 'dropdown',
						label: 'Palette',
						id: 'palette',
						default: 1,
						choices: [
							{id: 1,  label: 'Palette 1'},
							{id: 2,  label: 'Palette 2'},
							{id: 3,  label: 'Palette 3'},
							{id: 4,  label: 'Palette 4'},
							{id: 5,  label: 'Palette 5'},
							{id: 6,  label: 'Palette 6'},
							{id: 7,  label: 'Palette 7'},
							{id: 8,  label: 'Palette 8'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('ATP:' + event.options.palette)
				},
			},
			stillimages: {
				name: 'Start/Stop Still Image',
				options: [
					{
						type: 'dropdown',
						label: 'Still Image',
						id: 'still',
						default: 0,
						choices: [
							{id: 0,  label: 'Stop All'},
							{id: 1,  label: 'Start Still Image 1'},
							{id: 2,  label: 'Start Still Image 2'},
							{id: 3,  label: 'Start Still Image 3'},
							{id: 4,  label: 'Start Still Image 4'},
							{id: 5,  label: 'Start Still Image 5'},
							{id: 6,  label: 'Start Still Image 6'},
							{id: 7,  label: 'Start Still Image 7'},
							{id: 8,  label: 'Start Still Image 8'},
							{id: 9,  label: 'Start Still Image 9'},
							{id: 10,  label: 'Start Still Image 10'},
							{id: 11,  label: 'Start Still Image 11'},
							{id: 12,  label: 'Start Still Image 12'},
							{id: 13,  label: 'Start Still Image 13'},
							{id: 14,  label: 'Start Still Image 14'},
							{id: 15,  label: 'Start Still Image 15'},
							{id: 16,  label: 'Start Still Image 16'},
						]
					}
				],
				callback: async (event) => {
					if (event.options.still == 0) {
						this.sendCommand('STS')
					}
					else {
						this.sendCommand('STP:' + event.options.still)
					}
				}
			},
			audioclips: {
				name: 'Start/Stop Audio Clip',
				options: [
					{
						type: 'dropdown',
						label: 'Audio Clip',
						id: 'clip',
						default: 0,
						choices: [
							{id: 0,  label: 'Stop All'},
							{id: 1,  label: 'Audio Clip 1'},
							{id: 2,  label: 'Audio Clip 2'},
							{id: 3,  label: 'Audio Clip 3'},
							{id: 4,  label: 'Audio Clip 4'},
							{id: 5,  label: 'Audio Clip 5'},
							{id: 6,  label: 'Audio Clip 6'},
							{id: 7,  label: 'Audio Clip 7'},
							{id: 8,  label: 'Audio Clip 8'},
							{id: 9,  label: 'Audio Clip 9'},
							{id: 10,  label: 'Audio Clip 10'},
							{id: 11,  label: 'Audio Clip 11'},
							{id: 12,  label: 'Audio Clip 12'},
							{id: 13,  label: 'Audio Clip 13'},
							{id: 14,  label: 'Audio Clip 14'},
							{id: 15,  label: 'Audio Clip 15'},
							{id: 16,  label: 'Audio Clip 16'},
						]
					},
				],
				callback: async (event) => {
					if (event.options.clip == 0) {
						this.sendCommand('AUS')
					}
					else {
						this.sendCommand('AUP:' + event.options.clip)
					}
				},
			},
			audio_level: {
				name: 'Audio Level',
				options: [
					{
						id: 'mode',
						type: 'dropdown',
						label: 'Mode',
						default: 'set',
						choices: [
							{id: 'set', label: 'Set'},
							{id: 'inc', label: 'Increase'},
							{id: 'dec', label: 'Decrease'}
						]
					},
					{
						id: 'level',
						type: 'number',
						label: 'Audio Level (-INF = -80.1)',
						default: 0.0,
						min: -80.1,
						max: 90.1,
						steps: 0.1
					}
				],
				callback: async (event) => {
					let newLevel = this.data.audio_level
					if (event.options.mode == 'inc') {
						newLevel += event.options.level
					}
					else if (event.options.mode == 'dec') {
						newLevel -= event.options.level
					}
					if (newLevel > 10.0) {
						newLevel = 10.0
					}
					else if (newLevel < -80.1) {
						newLevel = -80.1
					}
					this.sendCommand('VOL:' + newLevel * 10)
				},
			},
			active_sensing: {
				name: 'Request Active Sensing',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('ACS')
				},
			},
			shutdown: {
				name: 'Shut down this Unit',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('EXT')
				},
			},
		}
		this.setActionDefinitions(actions)
	}

	initFeedbacks() {
		let feedbacks = {
			project_open: {
				type: 'boolean',
				name: 'Unit has an Open Project',
				description: 'Show feedback for Open Project state',
				options: [
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 255)
				},
				callback: (event) => {
					if (this.data.project_open == true) {
						return true
					}
					return false
				},
			},
			recording: {
				type: 'boolean',
				name: 'Unit is Recording',
				description: 'Show feedback for recording state',
				options: [
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(255, 0, 0)
				},
				callback: (event) => {
					if (this.data.recording) {
						return true
					}
					return false
				},
			},
			playing: {
				type: 'boolean',
				name: 'Unit is Playing',
				description: 'Show feedback for playback state',
				options: [
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(255, 0, 0)
				},
				callback: (event) => {
					if (this.data.playing) {
						return true
					}
					return false
				},
			},
			playback_range: {
				type: 'boolean',
				name: 'SPEED RANGE is enabled',
				description: 'Show feedback if SPEED RANGE is enabled',
				options: [
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(255, 0, 0)
				},
				callback: (event) => {
					if (this.data.playback_range == true) {
						return true
					}
					return false
				},
			},
			in_point: {
				type: 'boolean',
				name: 'In Point is Set',
				description: 'Show feedback for In Point Set state',
				options: [
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(255, 0, 0)
				},
				callback: (event) => {
					if (this.data.in_point) {
						return true
					}
					return false
				},
			},
			in_out_config: {
				type: 'boolean',
				name: 'Unit in/out config',
				description: 'Show feedback for input/output config',
				options: [
					{
						id: 'in',
						type: 'dropdown',
						label: 'Input',
						default: 1,
						choices: [
							{id: -1, label: 'Ignore'},
							{id: 1, label: 'Live 1'},
							{id: 2, label: 'Live 2'},
							{id: 3, label: 'PinP'},
							{id: 4, label: 'Split'}
						]
					},
					{
						id: 'out',
						type: 'dropdown',
						label: 'Output',
						default: '0',
						choices: [
							{id: -1, label: 'Ignore'},
							{id: 0, label: 'Replay'},
							{id: 1, label: 'Live'},
						]
					}
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(255, 0, 0)
				},
				callback: (event) => {
					if (event.options.in == -1) {
						if (event.options.out == this.data.out_config) {
							return true
						}
					}
					else if (event.options.out == -1) {
						if (event.options.in == this.data.in_config) {
							return true
						}
					}
					else if (event.options.in == this.data.in_config && event.options.out == this.data.out_config) {
						return true
					}
					return false
				}
			},
			clip_selected: {
				type: 'boolean',
				name: 'Clip is selected',
				description: 'Show feedback if a clip from a playlist is selected',
				options: [
					{
						id: 'playlist',
						type: 'dropdown',
						label: 'Playlist',
						default: -1,
						choices: [
							{id: -1, label: 'Selected'},
							{id: 0, label: 'Clip List'},
							{id: 1, label: 'Palette 1'},
							{id: 2, label: 'Palette 2'},
							{id: 3, label: 'Palette 3'},
							{id: 4, label: 'Palette 4'},
							{id: 5, label: 'Palette 5'},
							{id: 6, label: 'Palette 6'},
							{id: 7, label: 'Palette 7'},
							{id: 8, label: 'Palette 8'},
						]
					},
					{
						id: 'number',
						type: 'number',
						label: 'Number (0 = selected clip | -1 = last clip in playlist)',
						default: 1,
						min: -1,
						max: 512
					}
				],
				defaultStyle: {
					color: combineRgb(0, 0, 0),
					bgcolor: combineRgb(0, 255, 0)
				},
				callback: (event) => {
					let playlist = event.options.playlist
					let number = event.options.number
					if (event.options.playlist == -1) {
						playlist = this.data.selected_playlist
					}
					if (number == -1) {
						number = this.data.selected_playlist_length
					}
					else if (number == 0) {
						number = this.data.selected_number
					}
					if (this.data.selected_playlist == playlist && this.data.selected_number == number) {
						return true
					}
					return false
				}
			},
			clip_cued: {
				type: 'boolean',
				name: 'Clip is cued-up',
				description: 'Show feedback if a clip from a playlist is cued-up',
				options: [
					{
						id: 'playlist',
						type: 'dropdown',
						label: 'Playlist',
						default: -1,
						choices: [
							{id: -1, label: 'Selected'},
							{id: 0, label: 'Clip List'},
							{id: 1, label: 'Palette 1'},
							{id: 2, label: 'Palette 2'},
							{id: 3, label: 'Palette 3'},
							{id: 4, label: 'Palette 4'},
							{id: 5, label: 'Palette 5'},
							{id: 6, label: 'Palette 6'},
							{id: 7, label: 'Palette 7'},
							{id: 8, label: 'Palette 8'},
						]
					},
					{
						id: 'number',
						type: 'number',
						label: 'Number (0 = selected clip | -1 = last clip in playlist)',
						default: 1,
						min: -1,
						max: 512
					}
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(255, 0, 0)
				},
				callback: (event) => {
					let playlist = event.options.playlist
					let number = event.options.number
					if (playlist == -1) {
						playlist = this.data.selected_playlist
					}
					if (number == -1) {
						number = this.data.selected_playlist_length
					}
					else if (number == 0) {
						number = this.data.selected_number
					}
					if (this.data.cued_playlist == playlist && this.data.cued_number == number) {
						return true
					}
					return false
				}
			},
			clip_available: {
				type: 'boolean',
				name: 'Clip is available',
				description: 'Show feedback if a clip from the selected playlist is available',
				options: [
					{
						id: 'number',
						type: 'number',
						label: 'Number',
						default: 1,
						min: 1,
						max: 512
					}
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 51)
				},
				callback: (event) => {
					if (event.options.number <= this.data.selected_playlist_length) {
						return true
					}
					return false
				}
			},
			playlist_selected: {
				type: 'boolean',
				name: 'Playlist is selected',
				description: 'Show feedback if a playlist is selected',
				options: [
					{
						id: 'playlist',
						type: 'dropdown',
						label: 'Playlist',
						default: 0,
						choices: [
							{id: 0, label: 'Clip List'},
							{id: 1, label: 'Palette 1'},
							{id: 2, label: 'Palette 2'},
							{id: 3, label: 'Palette 3'},
							{id: 4, label: 'Palette 4'},
							{id: 5, label: 'Palette 5'},
							{id: 6, label: 'Palette 6'},
							{id: 7, label: 'Palette 7'},
							{id: 8, label: 'Palette 8'},
						]
					}
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(255, 0, 255)
				},
				callback: (event) => {
					if (this.data.selected_playlist == event.options.playlist) {
						return true
					}
					return false
				}
			},
			audio_available: {
				type: 'boolean',
				name: 'Audio Clip is available',
				description: 'Show feedback if an audio clip is available',
				options: [
					{
						id: 'clip',
						type: 'dropdown',
						label: 'Audio Clip',
						default: 1,
						choices: [
							{id: 1, label: 'Audio Clip 1'},
							{id: 2, label: 'Audio Clip 2'},
							{id: 3, label: 'Audio Clip 3'},
							{id: 4, label: 'Audio Clip 4'},
							{id: 5, label: 'Audio Clip 5'},
							{id: 6, label: 'Audio Clip 6'},
							{id: 7, label: 'Audio Clip 7'},
							{id: 8, label: 'Audio Clip 8'},
							{id: 9, label: 'Audio Clip 9'},
							{id: 10, label: 'Audio Clip 10'},
							{id: 11, label: 'Audio Clip 11'},
							{id: 12, label: 'Audio Clip 12'},
							{id: 13, label: 'Audio Clip 13'},
							{id: 14, label: 'Audio Clip 14'},
							{id: 15, label: 'Audio Clip 15'},
							{id: 16, label: 'Audio Clip 16'},
						]
					}
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 51)
				},
				callback: (event) => {
					return this.data.audio_clips[event.options.audio-1] == 1 ? true : false
				}
			},
			still_available: {
				type: 'boolean',
				name: 'Still Image is available',
				description: 'Show feedback if a still image is available',
				options: [
					{
						id: 'still',
						type: 'dropdown',
						label: 'Still Image',
						default: 1,
						choices: [
							{id: 1, label: 'Still Image 1'},
							{id: 2, label: 'Still Image 2'},
							{id: 3, label: 'Still Image 3'},
							{id: 4, label: 'Still Image 4'},
							{id: 5, label: 'Still Image 5'},
							{id: 6, label: 'Still Image 6'},
							{id: 7, label: 'Still Image 7'},
							{id: 8, label: 'Still Image 8'},
							{id: 9, label: 'Still Image 9'},
							{id: 10, label: 'Still Image 10'},
							{id: 11, label: 'Still Image 11'},
							{id: 12, label: 'Still Image 12'},
							{id: 13, label: 'Still Image 13'},
							{id: 14, label: 'Still Image 14'},
							{id: 15, label: 'Still Image 15'},
							{id: 16, label: 'Still Image 16'},
						]
					}
				],
				defaultStyle: {
					color: combineRgb(255, 255, 255),
					bgcolor: combineRgb(0, 0, 51)
				},
				callback: (event) => {
					return this.data.still_images[event.options.still-1] == 1 ? true : false
				}
			}
		}

		this.setFeedbackDefinitions(feedbacks)
	}

	initVariables() {
		let variables = []

		variables.push({variableId: 'product', name: 'Product Name'})
		variables.push({variableId: 'version', name: 'Version'})
		variables.push({variableId: 'project_open', name: 'Project Open'})
		variables.push({variableId: 'project_mode', name: 'Project Mode'})
		variables.push({variableId: 'recording', name: 'Recording'})
		variables.push({variableId: 'playing', name: 'Playing'})
		variables.push({variableId: 'playback_speed', name: 'Playback Speed'})
		variables.push({variableId: 'playback_range', name: 'Playback Range'})
		variables.push({variableId: 'in_point', name: 'In Point'})
		variables.push({variableId: 'input_selection_status', name: 'Input Selection Status'})
		variables.push({variableId: 'output_selection_status', name: 'Output Selection Status'})
		variables.push({variableId: 'audio_level', name: 'Audio Level'})
		variables.push({variableId: 'selected_clip_playlist', name: 'Playlist Containing Selected Clip'})
		variables.push({variableId: 'selected_clip_playlist_length', name: 'Number Of Clips In Playlist Containing Selected Clip'})
		variables.push({variableId: 'selected_clip_number', name: 'Number of Currently Selected Clip'})
		variables.push({variableId: 'cued_clip_playlist', name: 'Playlist Containing Cued-Up Clip'})
		variables.push({variableId: 'cued_clip_number', name: 'Number of Currently Cued-Up Clip'})

		this.setVariableDefinitions(variables)

		this.setVariableValues({
			product: '',
			version: '',
			project_open: false,
			project_mode: '',
			recording: false,
			playing: false,
			playback_speed: 0,
			playback_range: '',
			in_point: false,
			input_selection_status: '',
			output_selection_status: '',
			audio_level: '-INF',
			selected_clip_playlist: '',
			selected_clip_playlist_length: 0,
			selected_clip_number: '',
			cued_clip_playlist: '',
			cued_clip_number: '',
		})
	}

	initPresets() {
		let presets = [
			{
				category: 'Control',
				name: 'Play/Pause',
				type: 'button',
				style: {
					text: 'Play',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(51,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'playback',
								options: {mode: 'TOG'}
							}
						]
					}
				],
				feedbacks: [
					{
						feedbackId: 'playing',
						style: {
							text: "Pause",
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(255, 0, 0)
						}
					}
				]
			},
			{
				category: 'Control',
				name: 'Recording Start/Stop',
				type: 'button',
				style: {
					text: 'Rec',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(51,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'recording',
								options: {mode: 'TOG'}
							}
						]
					}
				],
				feedbacks: [
					{
						feedbackId: 'recording',
						style: {
							text: 'Stop',
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(255, 0, 0)
						}
					}
				]
			},
			{
				category: 'Control',
				name: 'Jump To Beginning',
				type: 'button',
				style: {
					text: 'Start',
					size: '24',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'timeline',
								options: {setting: 'JTP'}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Jump To Previous Bookmark',
				type: 'button',
				style: {
					text: 'I<',
					size: '24',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'timeline',
								options: {setting: 'JPB'}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Shuttle Reverse x2',
				type: 'button',
				style: {
					text: '<<',
					size: '24',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'shuttle',
								options: {direction: 'rev', speed: 2}
							}
						],
						up: [
							{
								actionId: 'playback',
								options: {mode: 'PUS'}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Shuttle Reverse x1',
				type: 'button',
				style: {
					text: '<',
					size: '24',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'shuttle',
								options: {direction: 'rev', speed: 1}
							}
						],
						up: [
							{
								actionId: 'playback',
								options: {mode: 'PUS'}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Jog To Previous Frame',
				type: 'button',
				style: {
					text: '-1',
					size: '24',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'jog',
								options: {direction: -1}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Jog To Next Frame',
				type: 'button',
				style: {
					text: '+1',
					size: '24',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'jog',
								options: {direction: 1}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Shuttle Forward x1',
				type: 'button',
				style: {
					text: '>',
					size: '24',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'shuttle',
								options: {direction: 'for', speed: 1}
							}
						],
						up: [
							{
								actionId: 'playback',
								options: {mode: 'PUS'}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Shuttle Forward x2',
				type: 'button',
				style: {
					text: '>>',
					size: '24',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'shuttle',
								options: {direction: 'for', speed: 2}
							}
						],
						up: [
							{
								actionId: 'playback',
								options: {mode: 'PUS'}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Jump To Next Bookmark',
				type: 'button',
				style: {
					text: '>I',
					size: '24',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'timeline',
								options: {setting: 'JNB'}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Jump To End',
				type: 'button',
				style: {
					text: 'End',
					size: '24',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'timeline',
								options: {setting: 'JED'}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Set In Point In Live',
				type: 'button',
				style: {
					text: 'IN\n(Live)',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(0,51,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'keyframes',
								options: {type: 'MIN', source: 1}
							}
						]
					}
				],
				feedbacks: [
					{
						feedbackId: 'in_point',
						options: {},
						style: {
							color: combineRgb(0, 0, 0),
							bgcolor: combineRgb(0, 255, 0)
						}
					}
				]
			},
			{
				category: 'Control',
				name: 'Set Out Point In Live',
				type: 'button',
				style: {
					text: 'OUT\n(Live)',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(0,51,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'keyframes',
								options: {type: 'MOT', source: 1}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Set In Point In Replay',
				type: 'button',
				style: {
					text: 'IN\n(Rply)',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(0,51,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'keyframes',
								options: {type: 'MIN', source: 0}
							}
						]
					}
				],
				feedbacks: [
					{
						feedbackId: 'in_point',
						options: {},
						style: {
							color: combineRgb(0, 0, 0),
							bgcolor: combineRgb(0, 255, 0)
						}
					}
				]
			},
			{
				category: 'Control',
				name: 'Set Out Point In Replay',
				type: 'button',
				style: {
					text: 'OUT\n(Rply)',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(0,51,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'keyframes',
								options: {type: 'MOT', source: 0}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'New Bookmark in Replay On Current Position',
				type: 'button',
				style: {
					text: 'New\nBook-\nmark',
					size: '18',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'bookmarks',
								options: {action: 0, timeline: 0}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Control',
				name: 'Delete Bookmark in Replay on Current Position',
				type: 'button',
				style: {
					text: 'Del\nBook-\nmark',
					size: '18',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'bookmarks',
								options: {action: 1, timeline: 0}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Speed',
				name: 'Show Speed',
				type: 'button',
				style: {
					text: 'Speed:\n$(p20:playback_speed)',
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(0,0,0)
				},
				steps: [],
				feedbacks: []
			}
		]

		for (let m = 0; m <= 1; m++) {
			let name
			let text
			let bg
			let play
			if (m == 0) {
				name = 'Start Playback At '
				text = 'Play'
				bg = combineRgb(51,0,0)
				play = true
			}
			else {
				name = 'Set Playback To '
				text = 'Set'
				bg = combineRgb(0,0,51)
				play = false
			}

			for (let n = 80; n >= 25; n-=5) {
				let i
				if (n == 80) {i = 100} else {i = n}
				presets.push({
					category: 'Speed',
					name: name + i + '% Speed',
					type: 'button',
					style: {
						text: text + '\n' + i + '%',
						size: '24',
						color: combineRgb(255,255,255),
						bgcolor: bg
					},
					steps: [
						{
							down: [
								{
									actionId: 'playback_speed',
									options: {mode: 'set', speed: i, play: play, limit: true}
								},
							]
						}
					],
					feedbacks: []
				})
			}
		}

		presets.push(
			{
				category: 'Speed',
				name: 'Decrease Speed by 5%',
				type: 'button',
				style: {
					text: 'Speed\n-5%',
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(255,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'playback_speed',
								options: {mode: 'dec', speed: 5, play: false, limit: true}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Speed',
				name: 'Increase Speed by 5%',
				type: 'button',
				style: {
					text: 'Speed\n+5%',
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(255,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'playback_speed',
								options: {mode: 'inc', speed: 5, play: false, limit: true}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Clips',
				name: 'Create Clip From Output',
				type: 'button',
				style: {
					text: 'New\n(OUT)',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(255,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'clip_create',
								options: {setting: -1}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Clips',
				name: 'Create Clip From Replay',
				type: 'button',
				style: {
					text: 'New\n(RPL)',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(255,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'clip_create',
								options: {setting: 0}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Clips',
				name: 'Create Clip From Live',
				type: 'button',
				style: {
					text: 'New\n(LIVE)',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(255,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'clip_create',
								options: {setting: 1}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Clips',
				name: 'Cue Selected Clip',
				type: 'button',
				style: {
					text: 'Cue',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(51,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'clip_actions',
								options: {action: 'CLQ', number: 0}
							}
						]
					}
				],
				feedbacks: [
					{
						feedbackId: 'clip_cued',
						options: {playlist: -1, number: 0},
						style: {
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(255, 0, 0)
						}
					}
				]
			},
			{
				category: 'Clips',
				name: 'Cue Last Clip',
				type: 'button',
				style: {
					text: 'Cue\nLast',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(51,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'clip_actions',
								options: {action: 'CLQ', number: -1}
							},
						]
					}
				],
				feedbacks: [
					{
						feedbackId: 'clip_cued',
						options: {playlist: -1, number: -1},
						style: {
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(255, 0, 0)
						}
					},
				]
			},
			{
				category: 'Clips',
				name: 'Delete Selected Clip',
				type: 'button',
				style: {
					text: 'Del',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(255,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'clip_actions',
								options: {action: 'CLD', number: 0}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Clips',
				name: 'Delete Last Clip',
				type: 'button',
				style: {
					text: 'Del\nLast',
					size: '24',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(255,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'clip_actions',
								options: {action: 'CLD', number: -1}
							},
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Clips',
				name: 'Play Selected Clip',
				type: 'button',
				style: {
					text: 'Play\nClip',
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(51,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'play_clip',
								options: {}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Clips',
				name: 'Select Last Clip',
				type: 'button',
				style: {
					text: 'Clip\nLast',
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(0,0,51)
				},
				steps: [
					{
						down: [
							{
								actionId: 'clip_actions',
								options: {action: 'CLS', number: -1}
							},
						]
					}
				],
				feedbacks: [
					{
						feedbackId: 'clip_selected',
						options: {playlist: -1, number: -1},
						style: {
							color: combineRgb(0, 0, 0),
							bgcolor: combineRgb(0, 255, 0)
						}
					},
					{
						feedbackId: 'clip_cued',
						options: {playlist: -1, number: -1},
						style: {
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(255, 0, 0)
						}
					},
				]
			}
		)

		for (let i = 1; i <= 8; i++) {
			presets.push({
				category: 'Clips',
				name: 'Add Selected Clip To Palette ' + i,
				type: 'button',
				style: {
					text: 'Add to\nPalette' + i,
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(255,0,255)
				},
				steps: [
					{
						down: [
							{
								actionId: 'palette_add',
								options: {palette: i}
							},
						]
					}
				],
				feedbacks: []
			})
		}

		for (let i = 1; i <= 64; i++) {
			presets.push({
				category: 'Clips',
				name: 'Select Clip ' + i,
				type: 'button',
				style: {
					text: 'Clip\n' + i,
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(0,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'clip_actions',
								options: {action: 'CLS', number: i}
							},
						]
					}
				],
				feedbacks: [
					{
						feedbackId: 'clip_available',
						options: {number: i},
						style: {
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(0, 0, 51)
						},
					},
					{
						feedbackId: 'clip_selected',
						options: {playlist: -1, number: i},
						style: {
							color: combineRgb(0, 0, 0),
							bgcolor: combineRgb(0, 255, 0)
						}
					},
					{
						feedbackId: 'clip_cued',
						options: {playlist: -1, number: i},
						style: {
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(255, 0, 0)
						}
					},
				]
			})
		}



		presets.push(
			{
				category: 'Playlist',
				name: 'Start/Stop Selected Playlist On First Clip',
				type: 'button',
				style: {
					text: 'Start\nPlaylist',
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(51,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'playlist_autoplay',
								options: {mode: 'TOG', number: 1}
							}
						]
					}
				],
				feedbacks: [
					{
						feedbackId: 'playing',
						style: {
							text: 'Stop\nPlaylist',
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(255, 0, 0)
						}
					}
				]
			},
			{
				category: 'Playlist',
				name: 'Start/Stop Selected Playlist On Selected Clip',
				type: 'button',
				style: {
					text: 'Start\nPlaylist',
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(51,0,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'playlist_autoplay',
								options: {mode: 'TOG', number: 0}
							}
						]
					}
				],
				feedbacks: [
					{
						feedbackId: 'playing',
						style: {
							text: 'Stop\nPlaylist',
							color: combineRgb(255, 255, 255),
							bgcolor: combineRgb(255, 0, 0)
						}
					}
				]
			}
		)

		for (let i = 0; i <= 8; i++) {
			let name = 'Palette\n' + i
			if (i == 0) {
				name = 'Clip List'
			}
			presets.push(
				{
					category: 'Playlist',
					name: 'Select ' + name,
					type: 'button',
					style: {
						text: name,
						size: '18',
						color: combineRgb(255,255,255),
						bgcolor: combineRgb(51,0,51)
					},
					steps: [
						{
							down: [
								{
									actionId: 'playlist_select',
									options: {playlist: i}
								}
							]
						}
					],
					feedbacks: [
						{
							feedbackId: 'playlist_selected',
							options: {playlist: i},
							style: {
								color: combineRgb(255, 255, 255),
								bgcolor: combineRgb(255, 0, 255)
							}
						}
					]
				},
			)
		}

		for (let i = 1; i <= 16; i++) {
			presets.push(
				{
					category: 'Image',
					name: 'Play Still Image ' + 1,
					type: 'button',
					style: {
						text: 'Image\n' + i,
						size: '18',
						color: combineRgb(255,255,255),
						bgcolor: combineRgb(0,0,0)
					},
					steps: [
						{
							down: [
								{
									actionId: 'stillimages',
									options: {still: i}
								}
							]
						}
					],
					feedbacks: [
						{
							feedbackId: 'still_available',
							options: {still: i},
							style: {
								color: combineRgb(255, 255, 255),
								bgcolor: combineRgb(0, 0, 51)
							}
						}
					]
				}
			)
		}

		presets.push(
			{
				category: 'Image',
				name: 'Stop Image Playback',
				type: 'button',
				style: {
					text: 'Stop\nImages',
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(0,0,255)
				},
				steps: [
					{
						down: [
							{
								actionId: 'stillimages',
								options: {still: 0}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Audio',
				name: 'Show Audio Level',
				type: 'button',
				style: {
					text: 'Level:\n$(p20:audio_level)',
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(0,0,0)
				},
				steps: [],
				feedbacks: []
			},
			{
				category: 'Audio',
				name: 'Decrease Audio Level',
				type: 'button',
				style: {
					text: 'Audio\n-5',
					size: '18',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'audio_level',
								options: {mode: 'dec', level: 5}
							}
						]
					}
				],
				feedbacks: []
			},
			{
				category: 'Audio',
				name: 'Increase Audio Level',
				type: 'button',
				style: {
					text: 'Audio\n+5',
					size: '18',
					color: combineRgb(0,0,0),
					bgcolor: combineRgb(255,255,0)
				},
				steps: [
					{
						down: [
							{
								actionId: 'audio_level',
								options: {mode: 'inc', level: 5}
							}
						]
					}
				],
				feedbacks: []
			}
		)

		for (let i = 1; i <= 16; i++) {
			presets.push(
				{
					category: 'Audio',
					name: 'Play Audio Clip ' + 1,
					type: 'button',
					style: {
						text: 'Audio\n' + i,
						size: '18',
						color: combineRgb(255,255,255),
						bgcolor: combineRgb(0,0,0)
					},
					steps: [
						{
							down: [
								{
									actionId: 'audioclips',
									options: {clip: i}
								}
							]
						}
					],
					feedbacks: [
						{
							feedbackId: 'audio_available',
							options: {clip: i},
							style: {
								color: combineRgb(255, 255, 255),
								bgcolor: combineRgb(0, 0, 51)
							}
						}
					]
				}
			)
		}

		presets.push(
			{
				category: 'Audio',
				name: 'Stop Audio Playback',
				type: 'button',
				style: {
					text: 'Stop\nAudio',
					size: '18',
					color: combineRgb(255,255,255),
					bgcolor: combineRgb(0,0,255)
				},
				steps: [
					{
						down: [
							{
								actionId: 'audioclips',
								options: {clip: 0}
							}
						]
					}
				],
				feedbacks: []
			}
		)

		this.setPresetDefinitions(presets)
	}
}

runEntrypoint(p20hdInstance, UpgradeScripts)
