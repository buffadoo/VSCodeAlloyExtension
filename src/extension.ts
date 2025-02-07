'use strict';
import * as vscode from 'vscode';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	Executable,
	ExecutableOptions,
	StreamInfo,
	Middleware,
	Command,
	CancellationToken,
	ProvideCodeLensesSignature,
	ProvideDocumentLinksSignature,
	CodeLensRequest,
	CodeLensParams,
	DocumentLink,
	SymbolKind
} from 'vscode-languageclient';
import { ViewColumn } from 'vscode';

import net = require('net');
import fs = require('fs');
import { ChildProcess, spawn } from 'child_process';
import { TextDocument, Uri } from 'vscode';
import { log } from 'util';
import * as path from 'path';
import * as os from 'os';

const ACTIVATION_DEBUG = true;

let lsProc: ChildProcess | undefined;
let client: LanguageClient;
let alloyWebViewContent: string;
let latestInstanceLink : string | null = null;
let outputChannel: vscode.OutputChannel;

function isAlloyLangId (id : String) : boolean {
	return id === "alloy" || id === "markdown";
} 

export async function activate(context: vscode.ExtensionContext) {
	outputChannel = vscode.window.createOutputChannel("Alloy Extension");
	outputChannel.show();

	outputChannel.appendLine("Alloy Extension Activating...");
	
	const alloyJar = context.asAbsolutePath("org.alloytools.alloy.dist.jar");
	outputChannel.appendLine("alloyJar: " + alloyJar);
	
	alloyWebViewContent = fs.readFileSync(context.asAbsolutePath("AlloyPanel.html")).toString();
	

	let disposable = vscode.commands.registerCommand('alloy.executeCommand', (uri: String, ind: number, line: number, char: number) => {
		outputChannel.appendLine(`executeCommand called with uri: ${uri}, ind: ${ind}, line: ${line}, char: ${char}`);
		if (typeof uri === 'string') {  // Make sure uri is a string
			client.sendNotification("ExecuteAlloyCommand", [uri, ind, line, char]);
		} else {
			outputChannel.appendLine("Error: uri is not a string");
		}
	});
	context.subscriptions.push(disposable);

	disposable = vscode.commands.registerCommand('alloy.executeAllCommands', () => {
		debugger;
		let editor = vscode.window.activeTextEditor;
		if (editor && !editor.document.isUntitled && isAlloyLangId(editor.document.languageId)){
			client.sendNotification("ExecuteAlloyCommand", [editor.document.uri.toString(), -1, 0, 0]);
		}
	});
	context.subscriptions.push(disposable);
	outputChannel.appendLine("Command registered: alloy.executeAllCommands");
	
	disposable = vscode.commands.registerCommand('alloy.openAlloyEditor', () => {
		let editor = vscode.window.activeTextEditor;
		if(editor && !editor.document.isUntitled && isAlloyLangId(editor.document.languageId)){
			spawn("java", ["-jar", alloyJar, 'gui', editor.document.fileName] );
		}else{
			spawn("java", ["-jar", alloyJar] );
		}
	});
	context.subscriptions.push(disposable);
	outputChannel.appendLine("Registered openAlloyEditor command");
	
	disposable = vscode.commands.registerCommand('alloy.listCommands', () => {
		let editor = vscode.window.activeTextEditor;
		if(editor && !editor.document.isUntitled && isAlloyLangId(editor.document.languageId))
			client.sendNotification("ListAlloyCommands", editor.document.uri.toString());
	});
	context.subscriptions.push(disposable);


	disposable = vscode.commands.registerCommand('alloy.openLatestInstance', () => {
		if(latestInstanceLink)
			client.sendNotification("OpenModel", latestInstanceLink);
		else
			vscode.window.showWarningMessage("No Alloy instances generated yet!");
	});
	context.subscriptions.push(disposable);

	disposable = vscode.commands.registerCommand('alloy.executeCommandUnderCursor', () => {
		const editor = vscode.window.activeTextEditor;
		let commandFound = false;
		if(editor && editor.selection.active){
			const cursor = editor.selection.active;
			const documentUri = editor.document.uri;
			const docCommands = commands.get(documentUri);
			if(docCommands){
				let command = 
					docCommands.find(codeLens => codeLens.range.contains(cursor) && 
									             codeLens.command!.arguments![0] === documentUri.toString());
				if (command){
					vscode.commands.executeCommand(command.command!.command, ...command.command!.arguments!);
					commandFound = true;
				}
			}
		}
		if(!commandFound){
			vscode.window.showWarningMessage("Cursor is not inside an Alloy command!");
		}
	});
	context.subscriptions.push(disposable);

	let port: number = Math.floor(randomNumber(49152, 65535));
	let serverExecOptions: ExecutableOptions = {stdio: "pipe"};
	let serverExec: Executable = {
		command: "java",
		args: ["-jar", alloyJar, "ls", port.toString()],
		options: serverExecOptions
	};

	type nil = null | undefined;
	let commands : Map<Uri, vscode.CodeLens[] | nil> = new Map();
	let middleware: Middleware = {
		
		provideCodeLenses : ( document: TextDocument, token: CancellationToken, next: ProvideCodeLensesSignature) => {
			let mode = vscode.workspace.getConfiguration("alloy").get("commandHighlightMode", "") ;
			let res = next(document, token);
			outputChannel.appendLine(`CodeLens requested for ${document.uri}, mode: ${mode}`);
			actOnProvideResult(res, codeLensRes => {
				if (codeLensRes) {
					codeLensRes.forEach(lens => {
						if (lens.command) {
							lens.command.command = 'alloy.executeCommand';
							outputChannel.appendLine(`CodeLens command: ${lens.command.command}, args: ${JSON.stringify(lens.command.arguments)}`);
						}
					});
				}
				commands.set(document.uri, codeLensRes)
			});
			return mode === "codelens" ? res : [];
		},

		provideDocumentLinks : ( document: TextDocument, token: CancellationToken, next: ProvideDocumentLinksSignature) => {
			let mode  = vscode.workspace.getConfiguration("alloy").get("commandHighlightMode", "") ;
			return mode === "link" ? next(document, token) : [];
		}
	};

	let clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'alloy' }, { scheme: 'file', language: 'markdown' }],
		middleware : middleware
	};

	// Create the language client
	outputChannel.appendLine("starting language client on port " + port);
	client = new LanguageClient(
		'AlloyLanguageService',
		'Alloy Language Service',
		await createClientOwnedTCPServerOptions(port),
		clientOptions,
		false
	);

	client.onReady().then(() => {
		client.onNotification("alloy/showExecutionOutput", (req: { message: string, messageType: number, bold: boolean }) => {
			getWebViewPanel().webview.postMessage(req);
		});
		client.onNotification("alloy/commandsListResult", res => {
			let commands : {title: string, command: Command}[] = res.commands;
			let qpitems = commands.map(item => ({ label: item.title, command: item.command}));
			vscode.window.showQuickPick(qpitems, {canPickMany : false, placeHolder : "Select a command to execute"})
				.then(item => {
					vscode.commands.executeCommand(item!.command.command, ...item!.command.arguments!);
			});
			outputChannel.appendLine(JSON.stringify(res));

		});
	});
	client.start();
	outputChannel.appendLine("LanguageClient started.");

	outputChannel.appendLine("Starting the Alloy process...");
	lsProc = spawn(serverExec.command, serverExec.args, serverExec.options);

	lsProc.on("exit", (code, signal) => {
		outputChannel.appendLine("Alloy JAR process exited. code: " + code + (signal ? "; signal: " + signal : ""));
	});
	lsProc.on("error", (err) => {
		outputChannel.appendLine("ERROR CREATING ALLOY PROCESS: " + err);
		vscode.window.showErrorMessage("Could not start the Alloy process, make sure Java is installed and included in PATH." +
										" Error: " + err.message);
	});
	if (lsProc.pid){
		outputChannel.appendLine("Alloy language server process (Alloy JAR) started. PID: " + lsProc.pid);
	}

	lsProc.stdout.on("data", data => {
		outputChannel.appendLine("Server: " + data.toString());
	});
	lsProc.stderr.on("data", data => {
		outputChannel.appendLine("Server err: " + data.toString());
	});

	let _webViewPanel : vscode.WebviewPanel | null;
	let getWebViewPanel = () => {
		outputChannel.appendLine("getWebViewPanel called");
		
		if (_webViewPanel){
			outputChannel.appendLine("Existing panel found");
			if (! _webViewPanel.visible) {
				outputChannel.appendLine("Panel not visible, revealing");
				_webViewPanel.reveal(_webViewPanel.viewColumn, true);
			}
			return _webViewPanel;
		}

		outputChannel.appendLine("Creating new WebView panel");
		let webViewPanelOptions: vscode.WebviewOptions & vscode.WebviewPanelOptions = {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [
				vscode.Uri.file(context.extensionPath)
			],
			enableCommandUris: true
		};
		
		_webViewPanel = vscode.window.createWebviewPanel("side bar", "Alloy", 
			{viewColumn :  vscode.ViewColumn.Beside, preserveFocus: false}, webViewPanelOptions);

		_webViewPanel.webview.html = alloyWebViewContent;
		_webViewPanel.webview.onDidReceiveMessage( (req : {method : "model" | "stop" | "instanceCreated" , data: any}) => {
			if (req.method === "model"){
				client.sendNotification("OpenModel", req.data.link);
				latestInstanceLink = req.data.link;
			} else if (req.method === "instanceCreated"){
				latestInstanceLink = req.data.link;
			} else if (req.method === "stop")
				client.sendNotification("StopExecution");
		});

		_webViewPanel.onDidDispose( () => {
			_webViewPanel = null;
		});

		_webViewPanel.reveal();
		return _webViewPanel;
	};

	// class AlloyCommandsTreeDataProvider implements vscode.TreeDataProvider<String>{
	// 	onDidChangeTreeData?: vscode.Event<String | null | undefined> | undefined;		
		
	// 	getTreeItem(element: String): vscode.TreeItem | Thenable<vscode.TreeItem> {
	// 		throw new Error("Method not implemented.");
	// 	}
	// 	getChildren(element?: String | undefined): vscode.ProviderResult<String[]> {
	// 		client.sendNotification("ListAlloyCommands", vscode.window.activeTextEditor!.document.uri.toString());
	// 	}


	// }
	// vscode.window.registerTreeDataProvider("Alloy", bookmarkProvider);

}

// this method is called when the extension is deactivated
export function deactivate() {
	if (lsProc) {
		lsProc.kill();
	}
}

async function createClientOwnedTCPServerOptions(port: number): Promise<ServerOptions> {
	let continuation: Function;
	let rejectedContinuation: Function;
	let promise = new Promise((r, rejected) => {continuation = r; rejectedContinuation = rejected});
	let streamPromise : Promise<StreamInfo> = new Promise((resolve) => {
		net.createServer( socket => {
			let res: StreamInfo = { reader: <NodeJS.ReadableStream>socket, writer: socket };
			resolve(res);
		}).listen(port, "localhost", () => continuation())
		.on("error", (err) => {
			log("error listening: " + err);
			rejectedContinuation(err);
		});
	});
	await promise;
	let serverExec: ServerOptions = () => streamPromise;
	return serverExec;
}

function randomNumber(from : number, to: number){
	let newTo = Math.max(from, to);
	from = Math.min(from, to);
	to = newTo;
	let res = from + Math.random() * (to - from + 1);
	if(res > to) res = to;
	if (res < from) res = from;
	return res;
}


function isFunc(value: any): value is Function {
	return typeof value  === 'function';
}

function isThenable<T>(value: any): value is Thenable<T> {
	return value && isFunc(value.then);
}

function actOnProvideResult<T> (res: vscode.ProviderResult<T>, func : (res: T | null | undefined) => void ){
	if(isThenable<T>(res)){
		res.then(func);
	}else{
		func(<T | null | undefined> res);
	}
}