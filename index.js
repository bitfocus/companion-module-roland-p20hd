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

		this.data = {
			open_project: '',
			recording_status: '',
			playback_status: '',
			playback_range: '',
			in_point_status: '',
		}

		this.CHOICES_SHUTTLE_SPEEDS = [
			{ id: '-8', label: 'x-128'},
			{ id: '-7', label: 'x-64'},
			{ id: '-6', label: 'x-32'},
			{ id: '-5', label: 'x-16'},
			{ id: '-4', label: 'x-8'},
			{ id: '-3', label: 'x-4'},
			{ id: '-2', label: 'x-2'},
			{ id: '-1', label: 'x-1'},
			{ id: '0', label: 'x0'},
			{ id: '1', label: 'x1'},
			{ id: '2', label: 'x2'},
			{ id: '3', label: 'x4'},
			{ id: '4', label: 'x8'},
			{ id: '5', label: 'x16'},
			{ id: '6', label: 'x32'},
			{ id: '7', label: 'x64'},
			{ id: '8', label: 'x128'},
		]

		this.CHOICES_CLIP_LIST = [];

		for (let i = 1; i <= 512; i++) {
			this.CHOICES_CLIP_LIST.push({
				id: i.toString(),
				label: 'Clip ' + i
			});
		}

		for (let i = 1; i <= 64; i++) {
			this.CHOICES_CLIP_LIST.push({
				id: i.toString(),
				label: 'Palette ' + i
			});
		}
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

		//debug('destroy', this.id)
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

				if (this.config.uselogin == true) {
					this.initLoginUser();
				}
				else {
					this.initCommunication();
				}
			})

			this.socket.on('data', (receivebuffer) => {
				pipeline += receivebuffer.toString('utf8')

				if (pipeline.includes(this.CONTROL_NACK)) {
					this.log('error', `Command ${this.lastReturnedCommand} was not accepted by the device`)
					if (this.lastReturnedCommand.indexOf('PSS') > -1) {
						this.log('error', `The password was probably wrong`);
					}
				}
				else if (pipeline.includes(this.CONTROL_ACK)) { // ACKs are sent at the end of the stream result, we should have 1 command to 1 ack
					if (this.lastReturnedCommand.indexOf('USR') > -1) { //if the last command was the username command, send the password
						this.initLoginPassword();
					}
					else {
						//if we got an ACK at all, let's assume we're connected
						this.initCommunication();
					}
				}

				this.lastReturnedCommand = this.cmdPipeNext() //returns the last command and runs the next one

				if (pipeline.length == 1) pipeline = ''
				
				// Every command ends with ; and an ACK or an ACK if nothing needed; `VER` is the only command that won't return an ACK
				if (pipeline.includes(';')) {
					// multiple rapid Query strings can result in async multiple responses so split response into individual messages
					// however, the documentation says NOT to send more than 1 command before receiving the ACK from the last one,
					// so we should always have one at a time
					let allresponses = pipeline.split(';')
					// last element will either be a partial response, an <ack> (processed next timer tick), or an empty string from split where a complete pipeline ends with ';'
					pipeline = allresponses.pop()
					for (let response of allresponses) {
						response = response.replace(new RegExp(this.CONTROL_ACK, 'g'), '')

						if (response.length > 0) {
							this.processResponse(response)
						}
					}
				}
							
			})
		}
	}

	cmdPipeNext() {
		const return_cmd = this.cmdPipe.shift()

		if(this.cmdPipe.length > 0) {
			this.socket.send(this.CONTROL_STX + this.cmdPipe[0] + ';')
		}

		return return_cmd
	}

	initLoginUser() {
		this.sendCommand(`USR:${this.config.username}`); //send username
	}

	initLoginPassword() {
		this.sendCommand(`PSS:${this.config.password}`); //send password
	}

	initCommunication() {
		if (this.communicationInitiated !== true) {
			this.sendCommand('VER') //request version
			this.initPolling()
			this.updateStatus('ok')

			this.communicationInitiated = true;
		}		
	}

	processResponse(response) {
		let category = 'XXX'
		let args = []

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
 
		let settingseparator = response.search(':')
		if (settingseparator > 2) {
			category = response.substring(settingseparator - 3, settingseparator)
			let argstring = response.substring(settingseparator + 1, response.length) // from start of params to end of string
			args = argstring.split(',')
		} 
		switch (category) {
			case 'VER': //version
				this.setVariableValues({
					product: args[0],
					version: args[1]
				})
				break
			case 'QPJ': //check for open project
				this.data.open_project = parseInt(args[0])
				this.setVariableValues({
					open_project: parseInt(args[0]) == 1 ? 'True' : 'False'
				})
				break
			case 'QMD': //get project recording/playback mode
				this.setVariableValues({
					project_mode: parseInt(args[0]) == 0 ? 'Resolution' : 'Frame Rate'
				})
				break
			case 'QRC': //get recording status
			this.data.playback_status = parseInt(args[0])
				this.setVariableValues({
					recording_status: parseInt(args[0]) == 1 ? 'Recording' : 'Stopped'
				})
				break
			case 'QPL': //get playback status
				let playbackArg = parseInt(args[0])
				this.data.playback_status = playbackArg
				let playbackStatus = ''
				
				if (playbackArg == 0) {
					playbackStatus = 'Playback Paused'
				}
				else if (playbackArg == 1) {
					playbackStatus = 'Playing Back'
				}
				else if (playbackArg == 2) {
					playbackStatus = 'Playing Back Clip'
				}
				else if (playbackArg == 3) {
					playbackStatus = 'Playing Back Playlist'
				}

				this.setVariableValues({
					playback_status: playbackStatus
				})
				break
			case 'QSP': //get playback speed
				this.setVariableValues({
					playback_speed: parseInt(args[0])
				})
				break
			case 'QSR': //get playback range
				this.data.playback_range = parseInt(args[0])
				this.setVariableValues({
					playback_range: parseInt(args[0]) == 1 ? 'Lit' : 'Unlit'
				})
				break
			case 'QMI': //get in point status
				this.data.in_point_status = parseInt(args[0])
				this.setVariableValues({
					in_point_status: parseInt(args[0]) == 1 ? 'Set' : 'Not Set'
				})
				break
			case 'QIS': //get input selection status
				let inputStatusArg = parseInt(args[0])
				let inputStatus = ''
				
				if (inputStatusArg == 1) {
					inputStatus = 'Live In 1'
				}
				else if (inputStatusArg == 2) {
					inputStatus = 'Live In 2'
				}
				else if (inputStatusArg == 3) {
					inputStatus = 'PinP'
				}
				else if (inputStatusArg == 4) {
					inputStatus = 'Split'
				}

				this.setVariableValues({
					input_selection_status: inputStatus
				})
				break
			case 'QOS': //get output selection status
				this.setVariableValues({
					output_selection_status: parseInt(args[0]) == 1 ? 'Live In Video' : 'Replay Video'
				})
				break
			case 'QAL': //get audio level
				let audioLevelArg = parseInt(args[0])
				let audioLevel = ''
				if (audioLevelArg == 801) {
					audioLevel = '-INF dB'
				}
				else {
					audioLevel = audioLevelArg / 10 + 'dB'
				}

				this.setVariableValues({
					audio_level: audioLevel
				})
				break
			case 'QPS': //get playlist containing currently selected clip
				let playlistArg = parseInt(args[0])
				let playlist = ''
				if (playlistArg == 0) {
					playlist = 'Clip List'
				}
				else {
					playlist = 'Palette ' + playlistArg
				}

				this.setVariableValues({
					playlist_selected_clip: playlist
				})
				break
			case 'QCS': //get number of currently selected clip
				this.setVariableValues({
					playlist_selected_clip_number: parseInt(args[0])
				})
				break
			case 'QPQ': //get playlist containing cued-up clip
				let playlistQArg = parseInt(args[0])
				let playlistQ = ''
				if (playlistQArg == 0) {
					playlistQ = 'Clip List'
				}
				else {
					playlistQ = 'Palette ' + playlistQArg
				}

				this.setVariableValues({
					playlist_queued_clip: playlist
				})
				break
			case 'QCQ': //get number of currently queued clip
				this.setVariableValues({
					playlist_queued_clip_number: parseInt(args[0])
				})
				break
			case 'QCX':

				break
			case 'QAX':
				
				break
			case 'QSX':
				
				break
			case 'QNC':
				
				break
			case 'ERR':
				errorMessage(args[0])
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
		if (this.pollTimer === undefined && this.config.poll_interval > 0) {
			this.pollTimer = setInterval(() => {
				this.sendPollCommand('QPJ');
				this.sendPollCommand('QMD');
				this.sendPollCommand('QRC');
				this.sendPollCommand('QPL');
				this.sendPollCommand('QSP');
				this.sendPollCommand('QSR');
				this.sendPollCommand('QMI');
				this.sendPollCommand('QIS');
				this.sendPollCommand('QOS');
				this.sendPollCommand('QAL');
				this.sendPollCommand('QPS');
				this.sendPollCommand('QCS');
				this.sendPollCommand('QPQ');
				this.sendPollCommand('QCQ');
				this.sendPollCommand('QCX');
				this.sendPollCommand('QAX');
				this.sendPollCommand('QSX');
				this.sendPollCommand('QNC');
			}, this.config.poll_interval)
		}
	}

	sendPollCommand(cmd) {
		if (this.socket !== undefined && this.socket.isConnected) {
			if(!this.cmdPipe.includes(cmd)) { // No need to flood the buffer with these
				this.sendCommand(cmd)
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
				default: '192.168.0.1',
				regex: Regex.IP,
			},
			{
				type: 'number',
				id: 'poll_interval',
				label: 'Polling Interval (ms), set to 0 to disable polling',
				min: 50,
				max: 30000,
				default: 1000,
				width: 3,
			},
			{
				type: 'checkbox',
				id: 'uselogin',
				label: 'Use Username and Password',
				default: false
			},
			{
				type: 'textinput',
				id: 'username',
				label: 'Username',
				width: 6,
				default: 'admin',
			},
			{
				type: 'textinput',
				id: 'password',
				label: 'Password',
				width: 6,
				default: 'admin',
			},
		]
	}

	initActions() {
		let actions = {
			rec_start: {
				name: 'Start Recording',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('REC')
				},
			},
			rec_stop: {
				name: 'Stop Recording',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('RES')
				},
			},
			playback_start: {
				name: 'Start Playback',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('PLY')
				},
			},
			playback_pause: {
				name: 'Pause Playback',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('PUS')
				},
			},
			jog_forward: {
				name: 'Jog Forward',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('JOG:1')
				},
			},
			jog_reverse: {
				name: 'Jog Reverse',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('JOG:-1')
				},
			},
			shuttle: {
				name: 'Set Shuttle Speed',
				options: [
					{
						type: 'dropdown',
						label: 'Shuttle Speed',
						id: 'speed',
						default: '0',
						choices: this.CHOICES_SHUTTLE_SPEEDS
					},
				],
				callback: async (event) => {
					this.sendCommand('SHT:' + event.options.speed)
				},
			},
			playback_speed: {
				name: 'Change Playback Speed',
				options: [
					{
						id: 'speed',
						type: 'number',
						label: 'Speed',
						default: 100,
						min: 0,
						max: 100
					}
				],
				callback: async (event) => {
					this.sendCommand('SPC:' + event.options.speed)
				},
			},
			speed_range: {
				name: 'Switch Playback Speed Range',
				options: [
					{
						type: 'dropdown',
						label: 'Button State',
						id: 'state',
						default: '0',
						choices: [
							{ id: '0',  label: '[SPEED RANGE] button is unlit'},
							{ id: '1',  label: '[SPEED RANGE] button is lit'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('SPR:' + event.options.state)
				},
			},
			in_point_settings: {
				name: 'IN Point Settings',
				options: [
					{
						type: 'dropdown',
						label: 'Setting',
						id: 'setting',
						default: '0',
						choices: [
							{ id: '0',  label: 'Replay Video'},
							{ id: '1',  label: 'Live In Video'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('MIN:' + event.options.setting)
				},
			},
			out_point_settings: {
				name: 'OUT Point Settings',
				options: [
					{
						type: 'dropdown',
						label: 'Setting',
						id: 'setting',
						default: '0',
						choices: [
							{ id: '0',  label: 'Replay Video'},
							{ id: '1',  label: 'Live In Video'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('MOT:' + event.options.setting)
				},
			},
			clip_create: {
				name: 'Create Clip',
				options: [
					{
						type: 'dropdown',
						label: 'Setting',
						id: 'setting',
						default: '0',
						choices: [
							{ id: '0',  label: 'Replay Video'},
							{ id: '1',  label: 'Live In Video'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('MCL:' + event.options.setting)
				},
			},
			clip_select: {
				name: 'Select Clip',
				options: [
					{
						type: 'dropdown',
						label: 'Clip/Palette',
						id: 'clip',
						default: '1',
						choices: this.CHOICES_CLIP_LIST
					},
				],
				callback: async (event) => {
					this.sendCommand('CLS:' + event.options.setting)
				},
			},
			clip_playback_start: {
				name: 'Start Clip Playback',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('APC')
				},
			},
			clip_cue: {
				name: 'Cue Clip',
				options: [
					{
						type: 'dropdown',
						label: 'Clip/Palette',
						id: 'clip',
						default: '1',
						choices: this.CHOICES_CLIP_LIST
					},
				],
				callback: async (event) => {
					this.sendCommand('CLQ:' + event.options.setting)
				},
			},
			clip_delete: {
				name: 'Delete Clip',
				options: [
					{
						type: 'dropdown',
						label: 'Clip/Palette',
						id: 'clip',
						default: '1',
						choices: this.CHOICES_CLIP_LIST
					},
				],
				callback: async (event) => {
					this.sendCommand('CLD:' + event.options.setting)
				},
			},
			bookmark_set: {
				name: 'Set Bookmark',
				options: [
					{
						type: 'dropdown',
						label: 'Setting',
						id: 'setting',
						default: '0',
						choices: [
							{ id: '0',  label: 'Replay Video'},
							{ id: '1',  label: 'Live In Video'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('BMK:' + event.options.setting)
				},
			},
			bookmark_delete: {
				name: 'Delete Bookmark',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('DMK')
				},
			},
			switch_input: {
				name: 'Switch Input',
				options: [
					{
						type: 'dropdown',
						label: 'Setting',
						id: 'setting',
						default: '1',
						choices: [
							{ id: '1',  label: 'Live In 1'},
							{ id: '2',  label: 'Live In 2'},
							{ id: '3',  label: 'PnP'},
							{ id: '4',  label: 'Split'}
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
						default: '0',
						choices: [
							{ id: '0',  label: 'Replay Video'},
							{ id: '1',  label: 'Live In Video'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('SLO:' + event.options.setting)
				},
			},
			bookmark_next: {
				name: 'Jump to Next Bookmark',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('JNB')
				},
			},
			bookmark_previous: {
				name: 'Jump to Previous Bookmark',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('JPB')
				},
			},
			timeline_beginning: {
				name: 'Jump to Beginning of Timeline',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('JTP')
				},
			},
			timeline_end: {
				name: 'Jump to End of Timeline',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('JED')
				},
			},
			playlist_select: {
				name: 'Select Playlist',
				options: [
					{
						type: 'dropdown',
						label: 'Setting',
						id: 'setting',
						default: '0',
						choices: [
							{ id: '0',  label: 'Clip List'},
							{ id: '1',  label: 'Palette 1'},
							{ id: '2',  label: 'Palette 2'},
							{ id: '3',  label: 'Palette 3'},
							{ id: '4',  label: 'Palette 4'},
							{ id: '5',  label: 'Palette 5'},
							{ id: '6',  label: 'Palette 6'},
							{ id: '7',  label: 'Palette 7'},
							{ id: '8',  label: 'Palette 8'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('PLS:' + event.options.setting)
				},
			},
			playlist_playback_start: {
				name: 'Start Playback of Playlist',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('APL')
				},
			},
			playlist_stop: {
				name: 'Stop Auto-Play of Playlist',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('SAP')
				},
			},
			palette_select: {
				name: 'Select Palette',
				options: [
					{
						type: 'dropdown',
						label: 'Palette',
						id: 'palette',
						default: '1',
						choices: [
							{ id: '1',  label: 'Palette 1'},
							{ id: '2',  label: 'Palette 2'},
							{ id: '3',  label: 'Palette 3'},
							{ id: '4',  label: 'Palette 4'},
							{ id: '5',  label: 'Palette 5'},
							{ id: '6',  label: 'Palette 6'},
							{ id: '7',  label: 'Palette 7'},
							{ id: '8',  label: 'Palette 8'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('PLS:' + event.options.palette) //this command is probably wrong, but it's what the manual says
				},
			},
			palette_select: {
				name: 'Add Current Clip to Palette',
				options: [
					{
						type: 'dropdown',
						label: 'Palette',
						id: 'palette',
						default: '1',
						choices: [
							{ id: '1',  label: 'Palette 1'},
							{ id: '2',  label: 'Palette 2'},
							{ id: '3',  label: 'Palette 3'},
							{ id: '4',  label: 'Palette 4'},
							{ id: '5',  label: 'Palette 5'},
							{ id: '6',  label: 'Palette 6'},
							{ id: '7',  label: 'Palette 7'},
							{ id: '8',  label: 'Palette 8'}
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('ATP:' + event.options.palette)
				},
			},
			stillimage_playback: {
				name: 'Select Still Image for Playback',
				options: [
					{
						type: 'dropdown',
						label: 'Still Image',
						id: 'still',
						default: '1',
						choices: [
							{ id: '1',  label: 'Still Image 1'},
							{ id: '2',  label: 'Still Image 2'},
							{ id: '3',  label: 'Still Image 3'},
							{ id: '4',  label: 'Still Image 4'},
							{ id: '5',  label: 'Still Image 5'},
							{ id: '6',  label: 'Still Image 6'},
							{ id: '7',  label: 'Still Image 7'},
							{ id: '8',  label: 'Still Image 8'},
							{ id: '9',  label: 'Still Image 9'},
							{ id: '10',  label: 'Still Image 10'},
							{ id: '11',  label: 'Still Image 11'},
							{ id: '12',  label: 'Still Image 12'},
							{ id: '13',  label: 'Still Image 13'},
							{ id: '14',  label: 'Still Image 14'},
							{ id: '15',  label: 'Still Image 15'},
							{ id: '16',  label: 'Still Image 16'},
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('STP:' + event.options.still)
				},
			},
			stillimage_stop: {
				name: 'Stop Still Image Playback',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('STS')
				},
			},
			audioclips_playback: {
				name: 'Select Audio Clip for Playback',
				options: [
					{
						type: 'dropdown',
						label: 'Audio Clip',
						id: 'clip',
						default: '1',
						choices: [
							{ id: '1',  label: 'Audio Clip 1'},
							{ id: '2',  label: 'Audio Clip 2'},
							{ id: '3',  label: 'Audio Clip 3'},
							{ id: '4',  label: 'Audio Clip 4'},
							{ id: '5',  label: 'Audio Clip 5'},
							{ id: '6',  label: 'Audio Clip 6'},
							{ id: '7',  label: 'Audio Clip 7'},
							{ id: '8',  label: 'Audio Clip 8'},
							{ id: '9',  label: 'Audio Clip 9'},
							{ id: '10',  label: 'Audio Clip 10'},
							{ id: '11',  label: 'Audio Clip 11'},
							{ id: '12',  label: 'Audio Clip 12'},
							{ id: '13',  label: 'Audio Clip 13'},
							{ id: '14',  label: 'Audio Clip 14'},
							{ id: '15',  label: 'Audio Clip 15'},
							{ id: '16',  label: 'Audio Clip 16'},
						]
					},
				],
				callback: async (event) => {
					this.sendCommand('AUP:' + event.options.clip)
				},
			},
			audioclips_stop: {
				name: 'Stop Audio Clip Playback',
				options: [
				],
				callback: async (event) => {
					this.sendCommand('AUS')
				},
			},
			audio_level: {
				name: 'Set Audio Level',
				options: [
					{
						id: 'level',
						type: 'number',
						label: 'Audio Level',
						default: 0,
						min: -80,
						max: 10,
						steps: 0.1
					}
				],
				callback: async (event) => {
					this.sendCommand('VOL:' + (event.options.level * 10))
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
		let feedbacks = {}

		feedbacks['open_project'] = {
			type: 'boolean',
			name: 'Unit has an Open Project',
			description: 'Show feedback for Open Project state',
			options: [
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 0, 0)
			},
			callback: async (event) => {
				let opt = await event.options
				if (this.data.open_project == true) {
					return true
				}
				return false
			},
		}

		feedbacks['recording_status'] = {
			type: 'boolean',
			name: 'Unit is Recording',
			description: 'Show feedback for recording state',
			options: [
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 0, 0)
			},
			callback: async (event) => {
				let opt = await event.options
				if (this.data.recording_status == true) {
					return true
				}
				return false
			},
		}

		feedbacks['playback_status'] = {
			type: 'boolean',
			name: 'Unit is in Selected Playback State',
			description: 'Show feedback for playback state',
			options: [
				{
					type: 'dropdown',
					label: 'Playback Status',
					id: 'status',
					default: 1,
					choices: [
						{ id: 0,  label: 'Playback Paused'},
						{ id: 1,  label: 'Playing Back'},
						{ id: 2,  label: 'Playing Back Clip'},
						{ id: 3,  label: 'Playing Back Playlist'}
					]
				},
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 0, 0)
			},
			callback: async (event) => {
				let opt = await event.options
				if (this.data.playback_status == true) {
					return true
				}
				return false
			},
		}

		feedbacks['playback_range'] = {
			type: 'boolean',
			name: 'SPEED RANGE is Lit',
			description: 'Show feedback for SPEED RANGE button state',
			options: [
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 0, 0)
			},
			callback: async (event) => {
				let opt = await event.options
				if (this.data.playback_range == true) {
					return true
				}
				return false
			},
		}

		feedbacks['in_point_status'] = {
			type: 'boolean',
			name: 'In Point is Set',
			description: 'Show feedback for In Point Set state',
			options: [
			],
			defaultStyle: {
				color: combineRgb(0, 0, 0),
				bgcolor: combineRgb(255, 0, 0)
			},
			callback: async (event) => {
				let opt = await event.options
				if (this.data.in_point_status == true) {
					return true
				}
				return false
			},
		}

		this.setFeedbackDefinitions(feedbacks)
	}

	initVariables() {
		let variables = []

		variables.push({ variableId: 'product', name: 'Product Name' })
		variables.push({ variableId: 'version', name: 'Version' })
		variables.push({ variableId: 'open_project', name: 'Open Project' })
		variables.push({ variableId: 'project_mode', name: 'Project Mode' })
		variables.push({ variableId: 'recording_status', name: 'Recording Status' })
		variables.push({ variableId: 'playback_status', name: 'Playback Status' })
		variables.push({ variableId: 'playback_speed', name: 'Playback Speed' })
		variables.push({ variableId: 'playback_range', name: 'Playback Range' })
		variables.push({ variableId: 'in_point_status', name: 'In Point Status' })
		variables.push({ variableId: 'input_selection_status', name: 'Input Selection Status' })
		variables.push({ variableId: 'output_selection_status', name: 'Output Selection Status' })
		variables.push({ variableId: 'audio_level', name: 'Audio Level' })
		variables.push({ variableId: 'playlist_selected_clip', name: 'Playlist Containing Selected Clip' })
		variables.push({ variableId: 'playlist_selected_clip_number', name: 'Number of Currently Selected Clip' })
		variables.push({ variableId: 'playlist_queued_clip', name: 'Playlist Containing Queued Clip' })
		variables.push({ variableId: 'playlist_queued_clip_number', name: 'Number of Currently Queued Clip' })

		this.setVariableDefinitions(variables)

		this.setVariableValues({
			product: '',
			version: '',
			open_project: '',
			project_mode: '',
			recording_status: '',
			playback_status: '',
			playback_speed: '',
			playback_range: '',
			in_point_status: '',
			input_selection_status: '',
			output_selection_status: '',
			audio_level: '',
			playlist_selected_clip: '',
			playlist_selected_clip_number: '',
			playlist_queued_clip: '',
			playlist_queued_clip_number: ''
		})
	}

	initPresets() {
		let presets = []

		this.setPresetDefinitions(presets)
	}
}

runEntrypoint(p20hdInstance, UpgradeScripts)
