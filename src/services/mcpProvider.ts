import * as vscode from 'vscode';

/** Must equal the id declared under `mcpServerDefinitionProviders` in the manifest. */
export const MCP_PROVIDER_ID = 'jevlint-le';
/** The command line, shipped in the extension. Run with `--mcp` it is the server. */
export const MCP_BUNDLE = 'dist/cli.js';

function definition(
	context: vscode.ExtensionContext,
): vscode.McpStdioServerDefinition {
	return new vscode.McpStdioServerDefinition(
		'JevLint-LE',
		// The extension host is Electron, so this is the editor's own binary.
		// ELECTRON_RUN_AS_NODE makes it run the script as Node would. Without it
		// a second editor window opens and no server starts.
		process.execPath,
		[context.asAbsolutePath(MCP_BUNDLE), '--mcp'],
		{ ELECTRON_RUN_AS_NODE: '1' },
		// With the version, the editor refreshes the tool list after an upgrade.
		context.extension.packageJSON.version,
	);
}

/**
 * Offers the bundled MCP server to agents running in the editor, so they can
 * lint the Jev questions they write with no setup. The editor starts the
 * server only when an agent calls a tool.
 *
 * An editor built on VS Code may lack this API whatever version it reports,
 * so it is looked for and never assumed. Its absence is not an error.
 */
export function registerMcpProvider(
	context: vscode.ExtensionContext,
): vscode.Disposable | undefined {
	if (typeof vscode.lm?.registerMcpServerDefinitionProvider !== 'function')
		return undefined;
	return vscode.lm.registerMcpServerDefinitionProvider(MCP_PROVIDER_ID, {
		provideMcpServerDefinitions: () => [definition(context)],
	});
}
