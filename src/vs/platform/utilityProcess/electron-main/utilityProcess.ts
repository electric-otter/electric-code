/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, Details, app, MessageChannelMain, MessagePortMain } from 'electron';
import { Disposable } from 'vs/base/common/lifecycle';
import { Emitter, Event } from 'vs/base/common/event';
import { ILogService } from 'vs/platform/log/common/log';
import { StringDecoder } from 'string_decoder';
import { timeout } from 'vs/base/common/async';
import { FileAccess } from 'vs/base/common/network';
import { UtilityProcess as ElectronUtilityProcess, UtilityProcessProposedApi, canUseUtilityProcess } from 'vs/base/parts/sandbox/electron-main/electronTypes';
import { IWindowsMainService } from 'vs/platform/windows/electron-main/windows';
import Severity from 'vs/base/common/severity';
import { ITelemetryService } from 'vs/platform/telemetry/common/telemetry';
import { ILifecycleMainService } from 'vs/platform/lifecycle/electron-main/lifecycleMainService';

export interface IUtilityProcessConfiguration {

	/**
	 * A way to group utility processes of same type together.
	 */
	readonly type: string;

	/**
	 * An optional serializable object to be sent into the utility process
	 * as first message alongside the message port.
	 */
	readonly payload?: unknown;

	/**
	 * Environment key-value pairs. Default is `process.env`.
	 */
	readonly env?: { [key: string]: string | undefined };

	/**
	 * List of string arguments that will be available as `process.argv`
	 * in the child process.
	 */
	readonly args?: string[];

	/**
	 * List of string arguments passed to the executable.
	 */
	readonly execArgv?: string[];

	/**
	 * Allow the utility process to load unsigned libraries.
	 */
	readonly allowLoadingUnsignedLibraries?: boolean;

	/**
	 * Used in log messages to correlate the process
	 * with other components.
	 */
	readonly correlationId?: string;
}

export interface IWindowUtilityProcessConfiguration extends IUtilityProcessConfiguration {

	// --- message port response related

	readonly responseWindowId: number;
	readonly responseChannel: string;
	readonly responseNonce: string;

	// --- utility process options

	/**
	 * If set to `true`, will terminate the utility process
	 * when the associated browser window closes or reloads.
	 */
	readonly windowLifecycleBound?: boolean;
}

interface IUtilityProcessExitBaseEvent {

	/**
	 * The process id of the process that exited.
	 */
	readonly pid: number;

	/**
	 * The exit code of the process.
	 */
	readonly code: number;
}

export interface IUtilityProcessExitEvent extends IUtilityProcessExitBaseEvent {

	/**
	 * The signal that caused the process to exit is unknown
	 * for utility processes.
	 */
	readonly signal: 'unknown';
}

export interface IUtilityProcessCrashEvent extends IUtilityProcessExitBaseEvent {

	/**
	 * The reason of the utility process crash.
	 */
	readonly reason: 'clean-exit' | 'abnormal-exit' | 'killed' | 'crashed' | 'oom' | 'launch-failed' | 'integrity-failure';
}

export class UtilityProcess extends Disposable {

	private static ID_COUNTER = 0;

	private readonly id = String(++UtilityProcess.ID_COUNTER);

	private readonly _onStdout = this._register(new Emitter<string>());
	readonly onStdout = this._onStdout.event;

	private readonly _onStderr = this._register(new Emitter<string>());
	readonly onStderr = this._onStderr.event;

	private readonly _onMessage = this._register(new Emitter<unknown>());
	readonly onMessage = this._onMessage.event;

	private readonly _onExit = this._register(new Emitter<IUtilityProcessExitEvent>());
	readonly onExit = this._onExit.event;

	private readonly _onCrash = this._register(new Emitter<IUtilityProcessCrashEvent>());
	readonly onCrash = this._onCrash.event;

	private process: UtilityProcessProposedApi.UtilityProcess | undefined = undefined;
	private processPid: number | undefined = undefined;
	private configuration: IUtilityProcessConfiguration | undefined = undefined;

	constructor(
		@ILogService private readonly logService: ILogService,
		@ITelemetryService private readonly telemetryService: ITelemetryService,
		@ILifecycleMainService protected readonly lifecycleMainService: ILifecycleMainService
	) {
		super();
	}

	protected log(msg: string, severity: Severity): void {
		let logMsg: string;
		if (this.configuration?.correlationId) {
			logMsg = `[UtilityProcess id: ${this.configuration?.correlationId}, type: ${this.configuration?.type}, pid: ${this.processPid ?? '<none>'}]: ${msg}`;
		} else {
			logMsg = `[UtilityProcess type: ${this.configuration?.type}, pid: ${this.processPid ?? '<none>'}]: ${msg}`;
		}

		switch (severity) {
			case Severity.Error:
				this.logService.error(logMsg);
				break;
			case Severity.Warning:
				this.logService.warn(logMsg);
				break;
			case Severity.Info:
				this.logService.info(logMsg);
				break;
		}
	}

	private validateCanStart(): boolean {
		if (!canUseUtilityProcess) {
			throw new Error('Cannot use UtilityProcess API from Electron!');
		}

		if (this.process) {
			this.log('Cannot start utility process because it is already running...', Severity.Error);

			return false;
		}

		return true;
	}

	start(configuration: IUtilityProcessConfiguration): boolean {
		const started = this.doStart(configuration);

		if (started && configuration.payload) {
			this.postMessage(configuration.payload);
		}

		return started;
	}

	protected doStart(configuration: IUtilityProcessConfiguration): boolean {
		if (!this.validateCanStart()) {
			return false;
		}

		this.configuration = configuration;

		const serviceName = `${this.configuration.type}-${this.id}`;
		const modulePath = FileAccess.asFileUri('bootstrap-fork.js').fsPath;
		const args = this.configuration.args ?? [];
		const execArgv = [...this.configuration.execArgv ?? [], `--vscode-utility-kind=${this.configuration.type}`];
		const allowLoadingUnsignedLibraries = this.configuration.allowLoadingUnsignedLibraries;
		const stdio = 'pipe';

		let env: { [key: string]: any } | undefined = this.configuration.env;
		if (env) {
			env = { ...env }; // make a copy since we may be going to mutate it

			for (const key of Object.keys(env)) {
				env[key] = String(env[key]); // make sure all values are strings, otherwise the process will not start
			}
		}

		this.log('creating new...', Severity.Info);

		// Fork utility process
		this.process = ElectronUtilityProcess.fork(modulePath, args, {
			serviceName,
			env,
			execArgv,
			allowLoadingUnsignedLibraries,
			stdio
		});

		// Register to events
		this.registerListeners(this.process, this.configuration, serviceName);

		return true;
	}

	private registerListeners(process: UtilityProcessProposedApi.UtilityProcess, configuration: IUtilityProcessConfiguration, serviceName: string): void {

		// Stdout
		if (process.stdout) {
			const stdoutDecoder = new StringDecoder('utf-8');
			this._register(Event.fromNodeEventEmitter<string | Buffer>(process.stdout, 'data')(chunk => this._onStdout.fire(typeof chunk === 'string' ? chunk : stdoutDecoder.write(chunk))));
		}

		// Stderr
		if (process.stderr) {
			const stderrDecoder = new StringDecoder('utf-8');
			this._register(Event.fromNodeEventEmitter<string | Buffer>(process.stderr, 'data')(chunk => this._onStderr.fire(typeof chunk === 'string' ? chunk : stderrDecoder.write(chunk))));
		}

		// Messages
		this._register(Event.fromNodeEventEmitter(process, 'message')(msg => this._onMessage.fire(msg)));

		// Spawn
		this._register(Event.fromNodeEventEmitter<void>(process, 'spawn')(() => {
			this.processPid = process.pid;

			this.log('successfully created', Severity.Info);
		}));

		// Exit
		this._register(Event.fromNodeEventEmitter<number>(process, 'exit')(code => {
			this.log(`received exit event with code ${code}`, Severity.Info);

			// Event
			this._onExit.fire({ pid: this.processPid!, code, signal: 'unknown' });

			// Cleanup
			this.onDidExitOrCrashOrKill();
		}));

		// Child process gone
		this._register(Event.fromNodeEventEmitter<{ details: Details }>(app, 'child-process-gone', (event, details) => ({ event, details }))(({ details }) => {
			if (details.type === 'Utility' && details.name === serviceName) {
				this.log(`crashed with code ${details.exitCode} and reason '${details.reason}'`, Severity.Error);

				// Telemetry
				type UtilityProcessCrashClassification = {
					type: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The type of utility process to understand the origin of the crash better.' };
					reason: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; comment: 'The reason of the utility process crash to understand the nature of the crash better.' };
					code: { classification: 'SystemMetaData'; purpose: 'PerformanceAndHealth'; isMeasurement: true; comment: 'The exit code of the utility process to understand the nature of the crash better' };
					owner: 'bpasero';
					comment: 'Provides insight into reasons the utility process crashed.';
				};
				type UtilityProcessCrashEvent = {
					type: string;
					reason: string;
					code: number;
				};
				this.telemetryService.publicLog2<UtilityProcessCrashEvent, UtilityProcessCrashClassification>('utilityprocesscrash', { type: configuration.type, reason: details.reason, code: details.exitCode });

				// Event
				this._onCrash.fire({ pid: this.processPid!, code: details.exitCode, reason: details.reason });

				// Cleanup
				this.onDidExitOrCrashOrKill();
			}
		}));
	}

	once(message: unknown, callback: () => void): void {
		const disposable = this._register(this._onMessage.event(msg => {
			if (msg === message) {
				disposable.dispose();

				callback();
			}
		}));
	}

	postMessage(message: unknown, transfer?: Electron.MessagePortMain[]): void {
		if (!this.process) {
			return; // already killed, crashed or never started
		}

		this.process.postMessage(message, transfer);
	}

	connect(payload?: unknown): MessagePortMain {
		const { port1: outPort, port2: utilityProcessPort } = new MessageChannelMain();
		this.postMessage(payload, [utilityProcessPort]);

		return outPort;
	}

	enableInspectPort(): boolean {
		if (!this.process || typeof this.processPid !== 'number') {
			return false;
		}

		this.log('enabling inspect port', Severity.Info);

		interface ProcessExt {
			_debugProcess?(pid: number): unknown;
		}

		// use (undocumented) _debugProcess feature of node if available
		const processExt = <ProcessExt>process;
		if (typeof processExt._debugProcess === 'function') {
			processExt._debugProcess(this.processPid);

			return true;
		}

		// not supported...
		return false;
	}

	kill(): void {
		if (!this.process) {
			return; // already killed, crashed or never started
		}

		this.log('attempting to kill the process...', Severity.Info);
		const killed = this.process.kill();
		if (killed) {
			this.log('successfully killed the process', Severity.Info);
			this.onDidExitOrCrashOrKill();
		} else {
			this.log('unable to kill the process', Severity.Warning);
		}
	}

	private onDidExitOrCrashOrKill(): void {
		this.process = undefined;
	}

	async waitForExit(maxWaitTimeMs: number): Promise<void> {
		if (!this.process) {
			return; // already killed, crashed or never started
		}

		this.log('waiting to exit...', Severity.Info);
		await Promise.race([Event.toPromise(this.onExit), timeout(maxWaitTimeMs)]);

		if (this.process) {
			this.log(`did not exit within ${maxWaitTimeMs}ms, will kill it now...`, Severity.Info);
			this.kill();
		}
	}
}

export class WindowUtilityProcess extends UtilityProcess {

	constructor(
		@ILogService logService: ILogService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@ITelemetryService telemetryService: ITelemetryService,
		@ILifecycleMainService lifecycleMainService: ILifecycleMainService
	) {
		super(logService, telemetryService, lifecycleMainService);
	}

	override start(configuration: IWindowUtilityProcessConfiguration): boolean {
		const responseWindow = this.windowsMainService.getWindowById(configuration.responseWindowId)?.win;
		if (!responseWindow || responseWindow.isDestroyed() || responseWindow.webContents.isDestroyed()) {
			this.log('Refusing to start utility process because requesting window cannot be found or is destroyed...', Severity.Error);

			return true;
		}

		// Start utility process
		const started = super.doStart(configuration);
		if (!started) {
			return false;
		}

		// Register to window events
		this.registerWindowListeners(responseWindow, configuration);

		// Establish & exchange message ports
		const windowPort = this.connect(configuration.payload);
		responseWindow.webContents.postMessage(configuration.responseChannel, configuration.responseNonce, [windowPort]);

		return true;
	}

	private registerWindowListeners(window: BrowserWindow, configuration: IWindowUtilityProcessConfiguration): void {

		// If the lifecycle of the utility process is bound to the window,
		// we kill the process if the window closes or changes

		if (configuration.windowLifecycleBound) {
			this._register(Event.filter(this.lifecycleMainService.onWillLoadWindow, e => e.window.win === window)(() => this.kill()));
			this._register(Event.fromNodeEventEmitter(window, 'closed')(() => this.kill()));
		}
	}
}
