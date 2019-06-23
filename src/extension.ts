/* Copyright (c) Ben Robert Mewburn 
 * Licensed under the MIT Licence.
 */
'use strict';

import * as path from 'path';
import * as semver from 'semver';

import { ExtensionContext, window, commands, workspace } from 'vscode';
import {
	LanguageClient, LanguageClientOptions, ServerOptions,
	TransportKind,
	NotificationType,
	RequestType
} from 'vscode-languageclient';
import { createMiddleware } from './middleware';
import * as fs from 'fs-extra';

const PHP_LANGUAGE_ID = 'php';
const VERSION = '1.0.14';
const INDEXING_STARTED_NOTIFICATION = new NotificationType('indexingStarted');
const INDEXING_ENDED_NOTIFICATION = new NotificationType('indexingEnded');
const CANCEL_INDEXING_REQUEST = new RequestType('cancelIndexing');

let languageClient: LanguageClient;
let extensionContext: ExtensionContext;
let initializationOptions: { storagePath?: string, clearCache?: boolean };

export async function activate(context: ExtensionContext) {

	extensionContext = context;
	let versionMemento = context.workspaceState.get<string>('version');
	let clearCache = false;
	context.workspaceState.update('version', VERSION);

	if (!versionMemento || (semver.lt(versionMemento, VERSION))) {
		try {
			await fs.remove(context.storagePath);
		} catch (e) {
			//ignore
		}

		clearCache = true;
	}
	//clearCache = true;
	// The server is implemented in node
	let serverModule: string;
	if (process.env.mode === 'debug') {
		serverModule = context.asAbsolutePath(path.join('node_modules', 'intelephense', 'out', 'server.js'));
	} else {
		serverModule = context.asAbsolutePath(path.join('node_modules', 'intelephense', 'lib', 'intelephense.js'));
	}
	// The debug options for the server
	let debugOptions = {
		execArgv: ["--nolazy", "--inspect=6039", "--trace-warnings", "--preserve-symlinks"],
		detached: true
	};

	// If the extension is launched in debug mode then the debug server options are used
	// Otherwise the run options are used
	let serverOptions: ServerOptions = {
		run: { module: serverModule, transport: TransportKind.ipc },
		debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
	}

	let intelephenseConfig = workspace.getConfiguration('intelephense');
	let runtime = intelephenseConfig.get('runtime') as string | undefined;
	let memory = Math.floor(Number(intelephenseConfig.get('maxMemory')));

	if (runtime) {
		serverOptions.run.runtime = runtime;
		serverOptions.debug.runtime = runtime;
	}

	if (memory && memory > 256) {
		let maxOldSpaceSize = '--max-old-space-size=' + memory.toString();
		serverOptions.run.options = { execArgv: [maxOldSpaceSize] };
		serverOptions.debug.options.execArgv.push(maxOldSpaceSize);
	}

	let middleware = createMiddleware(() => {
		return languageClient;
	});

	initializationOptions = {
		storagePath: context.storagePath,
		clearCache: clearCache
	};

	// Options to control the language client
	let clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ language: PHP_LANGUAGE_ID, scheme: 'file' },
			{ language: PHP_LANGUAGE_ID, scheme: 'untitled' }
		],
		initializationOptions: initializationOptions,
		middleware: middleware
	}

	// Create the language client and start the client.
	languageClient = new LanguageClient('intelephense', 'intelephense', serverOptions, clientOptions);
	let ready = languageClient.onReady();

	ready.then(() => {

		let resolveIndexingPromise: () => void;
		languageClient.onNotification(INDEXING_STARTED_NOTIFICATION.method, () => {
			window.setStatusBarMessage('$(sync~spin) intelephense indexing ...', new Promise((resolve, reject) => {
				resolveIndexingPromise = () => {
					resolve();
				}
			}));
		});

		languageClient.onNotification(INDEXING_ENDED_NOTIFICATION.method, () => {
			if (resolveIndexingPromise) {
				resolveIndexingPromise();
			}
			resolveIndexingPromise = undefined;
		});
	});

	let indexWorkspaceDisposable = commands.registerCommand('intelephense.index.workspace', indexWorkspace);
	let cancelIndexingDisposable = commands.registerCommand('intelephense.cancel.indexing', cancelIndexing);

	//push disposables
	context.subscriptions.push(
		indexWorkspaceDisposable,
		cancelIndexingDisposable,
		middleware
	);

	languageClient.start();
}

export function deactivate() {
	if (!languageClient) {
		return undefined;
	}
	return languageClient.stop();
}

function indexWorkspace() {
	initializationOptions.clearCache = true;
	languageClient.stop().then(_ => {
		languageClient.start();
	});
}

function cancelIndexing() {
	languageClient.sendRequest(CANCEL_INDEXING_REQUEST.method);
}
