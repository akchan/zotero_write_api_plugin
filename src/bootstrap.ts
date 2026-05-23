// APP_SHUTDOWN is a Zotero bootstrap constant not in zotero-types
declare const APP_SHUTDOWN: number;

let AttachEndpoint: any;
let WriteEndpoint: any;
let VersionEndpoint: any;

const PLUGIN_VERSION = "0.1.0";
const FULLTEXT_ATTACH_PATH = "/attach";
const LOCAL_WRITE_PATH = "/write";
const VERSION_PATH = "/version";
const FULLTEXT_ALLOWED_DIRS = ["/tmp", "/var/tmp"];
const ADDON_ID = "zotero-write-api@akchan.acts";
const HOMEPAGE_URL = "https://github.com/akchan/zotero_write_api_plugin";
const UPDATE_URL = "https://raw.githubusercontent.com/akchan/zotero_write_api_plugin/main/updates.json";
const STRICT_MIN_VERSION = "7.0";
const STRICT_MAX_VERSION = "*";
const TESTED_ZOTERO_VERSION = "8.0.1";
const SUPPORTED_OPERATIONS = [
	"import_by_identifier",
	"attach_note",
	"import_pdf",
];
const PLUGIN_CAPABILITIES = [
	"attach",
	"attach_bytes",
	"write",
	"version_probe",
];

type RequestData = Record<string, unknown>;
type SendResponse = (status: number, contentType: string, body: string) => void;
type JsonPayload = Record<string, unknown>;

function log(msg: string): void {
	Zotero.debug("Zotero Write API: " + msg);
}

function sendJSON(sendResponse: SendResponse, statusCode: number, payload: JsonPayload): void {
	sendResponse(statusCode, "application/json", JSON.stringify(payload));
}

function successResult(operation: string, details?: JsonPayload, extra?: JsonPayload): JsonPayload {
	const payload: JsonPayload = {
		success: true,
		operation: operation,
		stage: "completed",
		version: PLUGIN_VERSION,
	};
	if (details) {
		payload.details = details;
	}
	if (extra) {
		Object.assign(payload, extra);
	}
	return payload;
}

function errorResult(operation: string, stage: string, error: string, details?: JsonPayload): JsonPayload {
	return {
		success: false,
		operation: operation,
		stage: stage,
		error: error,
		details: details ?? {},
		version: PLUGIN_VERSION,
	};
}

function pluginVersionPayload(): JsonPayload {
	return {
		success: true,
		version: PLUGIN_VERSION,
		addon_id: ADDON_ID,
		homepage_url: HOMEPAGE_URL,
		update_url: UPDATE_URL,
		endpoints: {
			attach: FULLTEXT_ATTACH_PATH,
			write: LOCAL_WRITE_PATH,
			version: VERSION_PATH,
		},
		compatibility: {
			strict_min_version: STRICT_MIN_VERSION,
			strict_max_version: STRICT_MAX_VERSION,
			tested_zotero_version: TESTED_ZOTERO_VERSION,
		},
		capabilities: PLUGIN_CAPABILITIES.slice(),
		operations: SUPPORTED_OPERATIONS.slice(),
	};
}

function requireString(value: unknown, fieldName: string): string {
	if (typeof value !== "string") {
		throw new Error(fieldName + " must be a string");
	}
	return value;
}

function requireNonEmptyString(value: unknown, fieldName: string): string {
	const cleaned = requireString(value, fieldName).trim();
	if (!cleaned) {
		throw new Error(fieldName + " must be a non-empty string");
	}
	return cleaned;
}

function optionalNonEmptyString(value: unknown): string | null {
	if (typeof value !== "string") {
		return null;
	}
	const cleaned = value.trim();
	return cleaned ? cleaned : null;
}

function userLibraryID(): number {
	return Zotero.Libraries.userLibraryID;
}

async function getUserItemOrThrow(itemKey: string): Promise<Zotero.Item> {
	const item = await Zotero.Items.getByLibraryAndKey(userLibraryID(), itemKey);
	if (!item) {
		throw new Error("Item not found: " + itemKey);
	}
	return item;
}

async function collectionIDFromKey(collectionKey: string): Promise<number> {
	const collection = await Zotero.Collections.getByLibraryAndKey(userLibraryID(), collectionKey);
	if (!collection) {
		throw new Error("Collection not found: " + collectionKey);
	}
	return collection.id;
}

function resolveAttachFilePath(filePath: string): string {
	const file = Zotero.File.pathToFile(filePath);
	if (!file.exists()) {
		throw new Error("File not found: " + filePath);
	}
	return file.path;
}

function isMissingFileError(error: unknown): boolean {
	return typeof (error as Error).message === "string"
		&& (error as Error).message.includes("NS_ERROR_FILE_NOT_FOUND");
}

async function materializeUploadBytes(fileName: string, fileBytesBase64: string): Promise<string> {
	const tempDir = Zotero.getTempDirectory();
	const safeFileName = Zotero.File.getValidFileName(fileName.trim()) || "attachment.bin";
	tempDir.append(`zotero-write-api-${Date.now()}-${Math.random().toString(16).slice(2)}-${safeFileName}`);
	const binary = atob(fileBytesBase64);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	// Zotero.File.putContentsAsync() accepts Blob at runtime, but zotero-types
	// only advertises string | ArrayBuffer | nsIInputStream.
	await Zotero.File.putContentsAsync(tempDir.path, new Blob([bytes]) as unknown as ArrayBuffer);
	return tempDir.path;
}

function removeTempFile(tempPath: string): void {
	try {
		Zotero.File.pathToFile(tempPath).remove(false);
	}
	catch (error) {
		Zotero.logError(error instanceof Error ? error : new Error(String(error)));
	}
}

async function importStoredAttachment(parentItem: Zotero.Item, filePath: string, title: string): Promise<Zotero.Item> {
	const resolvedFilePath = resolveAttachFilePath(filePath);
	const attachment = await Zotero.Attachments.importFromFile({
		file: resolvedFilePath,
		libraryID: parentItem.libraryID,
		parentItemID: parentItem.id,
		title: title,
	});
	if (!attachment) {
		throw new Error("Failed to create attachment");
	}
	await attachment.saveTx();
	return attachment;
}

async function handleFulltextAttach(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const title = requireNonEmptyString(data.title, "title");
	const filePath = optionalNonEmptyString(data.file_path);
	const fileName = optionalNonEmptyString(data.file_name);
	const fileBytesBase64 = optionalNonEmptyString(data.file_bytes_base64);

	if (!filePath && !fileBytesBase64) {
		throw new Error("Either file_path or file_bytes_base64 must be provided");
	}

	const parentItem = await getUserItemOrThrow(itemKey);
	let attachment: Zotero.Item;
	let sourceMode = "path";
	let tempPath: string | null = null;

	try {
		if (filePath) {
			if (!FULLTEXT_ALLOWED_DIRS.some(dir => filePath.startsWith(dir))) {
				throw new Error(
					"File path must be within allowed directories: " + FULLTEXT_ALLOWED_DIRS.join(", ")
				);
			}
			try {
				attachment = await importStoredAttachment(parentItem, filePath, title);
			}
			catch (error) {
				if (!fileBytesBase64 || !isMissingFileError(error)) {
					throw error;
				}
				const fallbackName = fileName || Zotero.File.pathToFile(filePath).leafName || "attachment.bin";
				tempPath = await materializeUploadBytes(fallbackName, fileBytesBase64);
				attachment = await importStoredAttachment(parentItem, tempPath, title);
				sourceMode = "bytes_fallback";
			}
		}
		else {
			const requiredFileName = requireNonEmptyString(data.file_name, "file_name");
			tempPath = await materializeUploadBytes(requiredFileName, requireNonEmptyString(data.file_bytes_base64, "file_bytes_base64"));
			attachment = await importStoredAttachment(parentItem, tempPath, title);
			sourceMode = "bytes";
		}
	}
	finally {
		if (tempPath) {
			removeTempFile(tempPath);
		}
	}

	return successResult(
		"attach_file_to_item",
		{
			parent_item_key: itemKey,
			file_path: filePath,
			source_mode: sourceMode,
			title: title,
		},
		{
			attachment_key: attachment.key,
			attachment_id: attachment.id,
			message: "File attached successfully to item " + itemKey,
			handler: "fulltext-attach",
		}
	);
}

async function handleAttachNote(data: RequestData): Promise<JsonPayload> {
	const itemKey = requireNonEmptyString(data.item_key, "item_key");
	const noteText = requireString(data.note, "note");
	const parentItem = await getUserItemOrThrow(itemKey);

	const noteItem = new Zotero.Item("note");
	// libraryID is readonly in zotero-types but writable on unsaved items
	(noteItem as unknown as { libraryID: number }).libraryID = parentItem.libraryID;
	noteItem.parentID = parentItem.id;
	noteItem.setNote(noteText);
	await noteItem.saveTx();

	return successResult(
		"attach_note",
		{
			item_key: itemKey,
			note_length: noteText.length,
		},
		{
			note_key: noteItem.key,
			note_id: noteItem.id,
		}
	);
}

function detectIdentifier(raw: string): Record<string, string> | null {
	const doi = Zotero.Utilities.cleanDOI(raw);
	if (doi) {
		return { DOI: doi };
	}
	const isbn = Zotero.Utilities.cleanISBN(raw, false);
	if (isbn) {
		return { ISBN: isbn };
	}
	const arxivMatch = raw.match(/(?:arxiv:)?(\d{4}\.\d{4,}(?:v\d+)?|[a-z][a-z0-9\-.]+\/\d{7})/i);
	if (arxivMatch) {
		return { arXiv: arxivMatch[1] };
	}
	if (/^\d{1,10}$/.test(raw.trim())) {
		return { PMID: raw.trim() };
	}
	return null;
}

async function handleImportByIdentifier(data: RequestData): Promise<JsonPayload> {
	const raw = requireNonEmptyString(data.identifier, "identifier");
	const identifier = detectIdentifier(raw);
	if (!identifier) {
		throw new Error("Could not detect identifier type for: " + raw);
	}
	const identifierType = Object.keys(identifier)[0];

	const collectionKey = optionalNonEmptyString(data.collection_key);
	const collections: number[] = [];
	if (collectionKey) {
		collections.push(await collectionIDFromKey(collectionKey));
	}

	const search = new Zotero.Translate.Search();
	search.setIdentifier(identifier);
	const translators = await search.getTranslators();
	if (!translators || translators.length === 0) {
		throw new Error("No translator available for " + identifierType + ": " + raw);
	}
	search.setTranslator(translators);
	const items = await search.translate({
		libraryID: userLibraryID(),
		collections: collections,
	});
	if (!items || items.length === 0) {
		throw new Error("No item found for " + identifierType + ": " + raw);
	}

	return successResult(
		"import_by_identifier",
		{
			identifier: raw,
			identifier_type: identifierType,
			item_count: items.length,
			collection_key: collectionKey,
		},
		{
			item_key: items[0].key,
			item_id: items[0].id,
		}
	);
}

async function handleImportPdf(data: RequestData): Promise<JsonPayload> {
	const filePath = optionalNonEmptyString(data.file_path);
	const fileBytesBase64 = optionalNonEmptyString(data.file_bytes_base64);
	const collectionKey = optionalNonEmptyString(data.collection_key);

	if (!filePath && !fileBytesBase64) {
		throw new Error("Either file_path or file_bytes_base64 must be provided");
	}

	let sourcePath: string;
	let tempPath: string | null = null;

	try {
		if (filePath) {
			if (!FULLTEXT_ALLOWED_DIRS.some(dir => filePath.startsWith(dir))) {
				throw new Error(
					"File path must be within allowed directories: " + FULLTEXT_ALLOWED_DIRS.join(", ")
				);
			}
			sourcePath = resolveAttachFilePath(filePath);
		}
		else {
			const fileName = requireNonEmptyString(data.file_name, "file_name");
			tempPath = await materializeUploadBytes(fileName, fileBytesBase64 as string);
			sourcePath = tempPath;
		}

		const libraryID = userLibraryID();
		const attachment = await Zotero.Attachments.importFromFile({
			file: sourcePath,
			libraryID: libraryID,
		});
		if (!attachment) {
			throw new Error("Failed to create attachment");
		}

		// Zotero.RecognizeDocument is not in zotero-types
		const recognizer = (Zotero as unknown as { RecognizeDocument?: { recognizeItems: (items: Zotero.Item[]) => Promise<void> } }).RecognizeDocument;
		if (recognizer && typeof recognizer.recognizeItems === "function") {
			try {
				await recognizer.recognizeItems([attachment]);
			}
			catch (error) {
				Zotero.logError(error instanceof Error ? error : new Error(String(error)));
			}
		}

		// Re-fetch in case the recognizer reparented this attachment
		const refreshed = await Zotero.Items.getAsync(attachment.id) as Zotero.Item;
		const parentID = refreshed.parentID;

		if (parentID) {
			const parentItem = Zotero.Items.get(parentID) as Zotero.Item;
			if (collectionKey) {
				const collectionID = await collectionIDFromKey(collectionKey);
				const currentCollections = parentItem.getCollections();
				if (!currentCollections.includes(collectionID)) {
					parentItem.setCollections([...currentCollections, collectionID]);
					await parentItem.saveTx();
				}
			}
			return successResult(
				"import_pdf",
				{
					status: "recognized",
					collection_key: collectionKey,
				},
				{
					status: "recognized",
					parent_item_key: parentItem.key,
					attachment_key: refreshed.key,
				}
			);
		}

		// Standalone attachment — recognizer failed. Optionally add to collection.
		if (collectionKey) {
			const collectionID = await collectionIDFromKey(collectionKey);
			const currentCollections = refreshed.getCollections();
			if (!currentCollections.includes(collectionID)) {
				refreshed.setCollections([...currentCollections, collectionID]);
				await refreshed.saveTx();
			}
		}

		return successResult(
			"import_pdf",
			{
				status: "standalone",
				collection_key: collectionKey,
			},
			{
				status: "standalone",
				attachment_key: refreshed.key,
			}
		);
	}
	finally {
		if (tempPath) {
			removeTempFile(tempPath);
		}
	}
}

async function runWrite(data: RequestData): Promise<JsonPayload> {
	const operation = requireNonEmptyString(data.operation, "operation");
	switch (operation) {
		case "import_by_identifier":
			return handleImportByIdentifier(data);
		case "attach_note":
			return handleAttachNote(data);
		case "import_pdf":
			return handleImportPdf(data);
		default:
			throw new Error("Unsupported operation: " + operation);
	}
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function install(): void {
	log("Installed " + PLUGIN_VERSION);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function startup({ id, version, rootURI }: { id: string; version: string; rootURI: string }): Promise<void> {
	void id; void version; void rootURI;
	log("Starting " + PLUGIN_VERSION);

	AttachEndpoint = function() {};
	AttachEndpoint.prototype = {
		supportedMethods: ["POST"],
		supportedDataTypes: ["application/json"],
		init: async function(data: RequestData, sendResponse: SendResponse) {
			try {
				log("Received POST request to " + FULLTEXT_ATTACH_PATH + " [v" + PLUGIN_VERSION + "]");
				sendJSON(sendResponse, 200, await handleFulltextAttach(data));
			}
			catch (error) {
				const msg = (error as Error).message;
				log("Error in " + FULLTEXT_ATTACH_PATH + " [v" + PLUGIN_VERSION + "]: " + msg);
				sendJSON(
					sendResponse,
					500,
					errorResult(
						"attach_file_to_item",
						"attach_endpoint",
						msg,
						{ request: data ?? {} }
					)
				);
			}
		}
	};

	WriteEndpoint = function() {};
	WriteEndpoint.prototype = {
		supportedMethods: ["POST"],
		supportedDataTypes: ["application/json"],
		init: async function(data: RequestData, sendResponse: SendResponse) {
			try {
				const operation = data?.operation ?? "unknown_operation";
				log("Received POST request to " + LOCAL_WRITE_PATH + " [operation=" + operation + "]");
				sendJSON(sendResponse, 200, await runWrite(data ?? {}));
			}
			catch (error) {
				const operation = data?.operation ?? "unknown_operation";
				const msg = (error as Error).message;
				log("Error in " + LOCAL_WRITE_PATH + " [operation=" + operation + "]: " + msg);
				sendJSON(
					sendResponse,
					500,
					errorResult(
						String(operation),
						"write_endpoint",
						msg,
						{ request: data ?? {} }
					)
				);
			}
		}
	};

	VersionEndpoint = function() {};
	VersionEndpoint.prototype = {
		supportedMethods: ["GET"],
		init: function(_data: unknown, sendResponse: SendResponse) {
			log("Received GET request to " + VERSION_PATH + " [v" + PLUGIN_VERSION + "]");
			sendJSON(sendResponse, 200, pluginVersionPayload());
		}
	};

	Zotero.Server.Endpoints[FULLTEXT_ATTACH_PATH] = AttachEndpoint;
	Zotero.Server.Endpoints[LOCAL_WRITE_PATH] = WriteEndpoint;
	Zotero.Server.Endpoints[VERSION_PATH] = VersionEndpoint;
	log("Registered " + FULLTEXT_ATTACH_PATH + " endpoint");
	log("Registered " + LOCAL_WRITE_PATH + " endpoint");
	log("Registered " + VERSION_PATH + " endpoint");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onMainWindowLoad({ window: _window }: { window: Window }): void {
	// No window modifications needed
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function onMainWindowUnload({ window: _window }: { window: Window }): void {
	// No window modifications needed
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function shutdown({ id, version, rootURI }: { id: string; version: string; rootURI: string }, reason: number): void {
	void id; void version; void rootURI;
	if (reason === APP_SHUTDOWN) return;
	log("Shutting down " + PLUGIN_VERSION);
	delete Zotero.Server.Endpoints[FULLTEXT_ATTACH_PATH];
	delete Zotero.Server.Endpoints[LOCAL_WRITE_PATH];
	delete Zotero.Server.Endpoints[VERSION_PATH];
	AttachEndpoint = undefined;
	WriteEndpoint = undefined;
	VersionEndpoint = undefined;
	log("Unregistered " + FULLTEXT_ATTACH_PATH + " endpoint");
	log("Unregistered " + LOCAL_WRITE_PATH + " endpoint");
	log("Unregistered " + VERSION_PATH + " endpoint");
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function uninstall(): void {
	log("Uninstalled " + PLUGIN_VERSION);
}
