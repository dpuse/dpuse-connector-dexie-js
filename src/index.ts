// https://dexie.org/docs/Tutorial/Hello-World
// https://dexie.org/docs/Tutorial/Understanding-the-basics
// https://dexie.org/docs/Dexie/Dexie.open()#dynamic-schema-manipulation

// ── External Dependencies & Registrations
import { Dexie, type IndexableType, type Table } from 'dexie';

// ── DPUse Framework
import { ConnectorError } from '@dpuse/dpuse-shared';
import type {
    ConnectionNodeConfig,
    ConnectorConfig,
    ConnectorInterface,
    ConnectorUtilities,
    CreateObjectOptions,
    DropObjectOptions,
    FindObjectOptions,
    FindObjectResult,
    GetRecordOptions,
    GetRecordResult,
    ListNodesOptions,
    ListNodesResult,
    PreviewConfig,
    PreviewObjectOptions,
    RecordRange,
    RecordRetrievalTypeId,
    RemoveRecordsOptions,
    RetrieveRecordsOptions,
    RetrieveRecordsSummary,
    ToolConfig,
    UpsertRecordsOptions
} from '@dpuse/dpuse-shared';

// ── Data
import config from '~/config.json';
import { version } from '~/package.json';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Extend default connector interface with Dexie container map
interface ExtendedConnectorInterface extends ConnectorInterface {
    containers: Record<string, Dexie>;
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const CALLBACK_RETRIEVE_ABORTED = 'Connector failed to abort retrieve all records operation.';
const ERROR_INVALID_CONTAINER_ID = 'Encountered invalid container identifier';
const ERROR_INVALID_FOLDER_PATH = 'Encountered invalid folder path';
const ERROR_INVALID_OBJECT_PATH = 'Encountered invalid object path';

// ── Connectors ───────────────────────────────────────────────────────────────────────────────────────────────────────

export class Connector implements ExtendedConnectorInterface {
    abortController: AbortController | undefined;
    readonly config: ConnectorConfig;
    connectorUtilities: ConnectorUtilities;
    readonly toolConfigs;
    containers: Record<string, Dexie>;

    constructor(connectorUtilities: ConnectorUtilities, toolConfigs: ToolConfig[]) {
        this.abortController = undefined;
        this.config = config as ConnectorConfig;
        this.config.version = version;
        this.connectorUtilities = connectorUtilities;
        this.toolConfigs = toolConfigs;
        this.containers = {};
    }

    // Abort operation
    abortOperation(): void {
        if (!this.abortController) return;
        this.abortController.abort();
        this.abortController = undefined;
    }

    // Create object
    async createObject(options: CreateObjectOptions): Promise<void> {
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);

        if (container.tables.some((table) => table.name === nodeId)) throw new Error(`Duplicate table '${nodeId}'.`);

        container.close();
        const newContainer = new Dexie(container.name);
        newContainer.on('blocked', () => false); // Silence console warning of blocked event

        if (container.tables.length === 0) {
            await container.delete();
            newContainer.version(1).stores({ [nodeId]: options.structure || '' });
            this.containers[containerId] = await newContainer.open();
            return;
        }

        const currentSchema: Record<string, string> = {};
        for (const { name, schema } of container.tables) {
            currentSchema[name] = [schema.primKey.src, ...schema.indexes.map((index) => index.src)].join(',');
        }
        newContainer.version(container.verno).stores(currentSchema);
        newContainer.version(container.verno + 1).stores({ [nodeId]: options.structure || '' });
        this.containers[containerId] = await newContainer.open();
    }

    // Drop object
    async dropObject(options: DropObjectOptions): Promise<void> {
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);

        if (container.tables.every((table) => table.name !== nodeId)) throw new Error(`Table '${nodeId}' not found.`);

        container.close();
        const newContainer = new Dexie(container.name);
        newContainer.on('blocked', () => false); // Silence console warning of blocked event

        if (container.tables.length === 1) {
            await container.delete();
            newContainer.version(1).stores({});
            this.containers[containerId] = await newContainer.open();
            return;
        }

        const currentSchema: Record<string, string> = {};
        for (const { name, schema } of container.tables) {
            currentSchema[name] = [schema.primKey.src, ...schema.indexes.map((index) => index.src)].join(',');
        }
        newContainer.version(container.verno).stores(currentSchema);
        newContainer.version(container.verno + 1).stores({ [nodeId]: null });
        this.containers[containerId] = await newContainer.open();
    }

    // Find object
    async findObject(options: FindObjectOptions): Promise<FindObjectResult> {
        if (options.storeId == null) throw new Error(`${ERROR_INVALID_CONTAINER_ID} '${String(options.storeId)}'.`);
        const container = await this.establishContainer(options.storeId);
        const isObjectFound = container.tables.some((table) => table.name === options.nodeId);
        return { path: isObjectFound ? `/${options.storeId}/${options.nodeId}` : undefined };
    }

    // Get record
    async getRecord(options: GetRecordOptions): Promise<GetRecordResult> {
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);
        const record = await container.table<Record<string, unknown>>(nodeId).get(options.id);
        if (record) return { record };
        throw new Error('Not found.');
    }

    // List nodes
    async listNodes(settings: ListNodesOptions): Promise<ListNodesResult> {
        const folderPathSegments = settings.folderPath.split('/');
        switch (folderPathSegments.length) {
            case 1: {
                if (folderPathSegments[0] != '') throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${settings.folderPath}'.`); // Invalid folder path if characters ahead of first separator.
                // Return list of database nodes for Dexie instance.
                const databaseNames = await Dexie.getDatabaseNames();
                const connectionNodeConfigs = databaseNames.map(
                    (name) => ({ folderPath: settings.folderPath, id: name, label: name, name, typeId: 'folder' }) as ConnectionNodeConfig
                );
                return { cursor: undefined, isMore: false, connectionNodeConfigs, totalCount: connectionNodeConfigs.length };
            }
            case 2: {
                if (folderPathSegments[0] != '') throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${settings.folderPath}'.`); // Invalid folder path if characters ahead of first separator.
                const containerName = folderPathSegments[1];
                if (containerName == null) throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${settings.folderPath}'.`); // Invalid folder path if no container name.
                // Return list of table nodes in Dexie database.
                const container = await this.establishContainer(containerName);
                const connectionNodeConfigs = container.tables.map(
                    (table) => ({ folderPath: settings.folderPath, id: table.name, label: table.name, name: table.name, typeId: 'object' }) as ConnectionNodeConfig
                );
                return { cursor: undefined, isMore: false, connectionNodeConfigs, totalCount: connectionNodeConfigs.length };
            }
            default:
                throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${settings.folderPath}'.`);
        }
    }

    // Preview object
    async previewObject(options: PreviewObjectOptions): Promise<PreviewConfig> {
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);
        const data = await container.table<Record<string, unknown>>(nodeId).limit(50).toArray(); // Fetch the first 50 rows.
        return {
            asAt: Date.now(),
            columnConfigs: [],
            dataFormatId: 'unknown',
            duration: 0,
            encodingConfidenceLevel: undefined,
            encodingId: undefined,
            fileType: undefined,
            hasHeaders: undefined,
            inferenceRecords: [],
            parsedRecords: [],
            recordDelimiterId: undefined,
            size: undefined,
            text: undefined,
            valueDelimiterId: undefined
        };
    }

    // Upsert records
    async upsertRecords(options: UpsertRecordsOptions): Promise<void> {
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);
        const records = options.records;
        if (records.length === 1) {
            await container.table(nodeId).put(records[0]);
        } else if (records.length > 1) {
            await container.table(nodeId).bulkPut(records);
        }
    }

    // Remove records
    async removeRecords(options: RemoveRecordsOptions): Promise<void> {
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);
        const keys = options.keys;
        if (keys.length === 0) {
            await container.table(nodeId).clear(); // Remove all records.
        } else if (keys.length === 1 && keys[0] != null) {
            await container.table(nodeId).delete(keys[0]); // Remove single record.
        } else {
            await container.table(nodeId).bulkDelete(keys); // Remove multiple records.
        }
    }

    // Retrieve records, every one of them or only those in a range of positions, which also reports the table's total.
    async retrieveRecords(
        options: RetrieveRecordsOptions,
        chunk: (typeId: RecordRetrievalTypeId, records: Record<string, unknown>[]) => void,
        complete: (result: RetrieveRecordsSummary) => void
    ): Promise<void> {
        try {
            const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
            const container = await this.establishContainer(containerId);
            const table = container.table<Record<string, unknown>>(nodeId);
            if (options.range == null) {
                const records = await table.toArray();
                chunk('jsonRecordArray', records);
                complete({ byteCount: 0, commentLineCount: 0, emptyLineCount: 0, lineCount: 0, nonUniformRecordCount: 0, recordCount: records.length });
                return;
            }
            const totalCount = await table.count();
            const records = await retrieveRecordRange(table, options.range, totalCount);
            chunk('jsonRecordArray', records);
            complete({ byteCount: 0, commentLineCount: 0, emptyLineCount: 0, lineCount: 0, nonUniformRecordCount: 0, recordCount: records.length, totalCount });
        } catch (error) {
            throw new ConnectorError(`Failed to access Dexie table with path '${options.path}'.`, 'dpu-connector-dexie-js.index.retrieveRecords', { cause: error });
        } finally {
            this.abortController = undefined;
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

    private async establishContainer(name: string): Promise<Dexie> {
        let container = this.containers[name];
        if (!container) {
            const database = new Dexie(name);
            if (!(await Dexie.exists(database.name))) database.version(1).stores({});
            container = await database.open();
            this.containers[name] = container;
        }
        return container;
    }

    private establishObjectIdentifiers(path: string): { containerId: string; nodeId: string } {
        const pathSegments = path.split('/');
        const [, containerId, nodeId] = pathSegments;
        if (!containerId || !nodeId || pathSegments.length !== 3) {
            throw new Error(`${ERROR_INVALID_OBJECT_PATH} '${path}'.`);
        }
        return { containerId, nodeId };
    }
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// A range is found by record number when the numbers run without a gap, as they do in a table one audit filled: the
// record at position N is then numbered 'first + N', and is looked up directly however far in it is. Otherwise the
// records before the range are stepped past, which takes longer the further in it starts.
async function retrieveRecordRange(table: Table<Record<string, unknown>, IndexableType>, range: RecordRange, totalCount: number): Promise<Record<string, unknown>[]> {
    if (range.limit <= 0 || range.offset >= totalCount) return [];
    const [firstKey] = await table.toCollection().limit(1).primaryKeys();
    const [lastKey] = await table.toCollection().reverse().limit(1).primaryKeys();
    if (typeof firstKey === 'number' && typeof lastKey === 'number' && lastKey - firstKey + 1 === totalCount) {
        const lowerKey = firstKey + range.offset;
        return await table
            .where(':id')
            .between(lowerKey, lowerKey + range.limit, true, false)
            .toArray();
    }
    return await table.offset(range.offset).limit(range.limit).toArray();
}
