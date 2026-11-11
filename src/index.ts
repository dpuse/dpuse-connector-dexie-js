// https://dexie.org/docs/Tutorial/Hello-World
// https://dexie.org/docs/Tutorial/Understanding-the-basics
// https://dexie.org/docs/Dexie/Dexie.open()#dynamic-schema-manipulation

// ── External Dependencies & Registrations
import { Dexie, type IndexableType, type Table } from 'dexie';

// ── DPUse Framework
import type {
    AuditObjectContentOptions,
    AuditObjectContentResult,
    ConnectionNodeConfig,
    ConnectorInterface,
    ConnectorUtilities,
    CreateObjectOptions,
    DataSubtypeId,
    DataTypeId,
    DeclaredColumnConfig,
    DropObjectOptions,
    FindObjectOptions,
    FindObjectResult,
    GetRecordOptions,
    GetRecordResult,
    ListNodesOptions,
    ListNodesResult,
    ObjectColumnConfig,
    PreviewObjectOptions,
    PreviewObjectResult,
    RecordRange,
    RemoveRecordsOptions,
    RetrieveRecordsChunk,
    RetrieveRecordsOptions,
    RetrieveRecordsSummary,
    StoreRecord,
    StoreValue,
    ToolConfig,
    UpsertRecordsOptions
} from '@dpuse/dpuse-shared';
import { ConnectorError, convertStoreRecordToParsedRecord, normalizeToError } from '@dpuse/dpuse-shared';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// Extend default connector interface with Dexie container map
interface ExtendedConnectorInterface extends ConnectorInterface {
    containers: Record<string, Dexie>;
}

// The column types saved for a table this connector created, by the table's path.
interface SavedObject {
    columnConfigs: ObjectColumnConfig[];
    path: string;
}

// How a table's stored fields map to columns, in column order.
interface TableLayout {
    columnConfigs: ObjectColumnConfig[];
    fieldNames: string[];
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const CALLBACK_RETRIEVE_ABORTED = 'Connector failed to abort retrieve all records operation.';
const ERROR_INVALID_CONTAINER_ID = 'Encountered invalid container identifier';
const ERROR_INVALID_FOLDER_PATH = 'Encountered invalid folder path';
const ERROR_INVALID_OBJECT_PATH = 'Encountered invalid object path';

// IndexedDB keeps each value's JavaScript type but not a column's type, so the types given to 'createObject' are saved in
// a database of the connector's own. It is left out of the databases listed.
const OBJECTS_DATABASE_NAME = '_dpuse_objects';

const INFERENCE_RECORD_COUNT = 100; // Records read to work out the columns of a table this connector did not create.
const PREVIEW_RECORD_COUNT = 50;
const DEFAULT_AUDIT_CHUNK_SIZE = 10_000;

// ── Connectors ───────────────────────────────────────────────────────────────────────────────────────────────────────

export class Connector implements ExtendedConnectorInterface {
    private abortController: AbortController | undefined;
    private readonly connectorUtilities: ConnectorUtilities;
    private readonly toolConfigs;
    containers: Record<string, Dexie>;

    constructor(connectorUtilities: ConnectorUtilities, toolConfigs: ToolConfig[]) {
        this.abortController = undefined;
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

    // A table's columns already have types, so the audit counts its values against them rather than working types out.
    // The auditor reads text, so each typed record is handed over as text. A table has no bytes, so 'byteLimit' does
    // not apply, and the audit reads every record unless 'stopSignal' fires.
    async auditObjectContent(options: AuditObjectContentOptions, onProgress: (recordCount: number, byteCount: number) => void): Promise<AuditObjectContentResult> {
        const abortController = new AbortController();
        this.abortController = abortController;
        const { signal } = abortController;
        try {
            const asAt = Date.now();
            const startedAt = performance.now();
            const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
            const container = await this.establishContainer(containerId);
            const table = container.table<Record<string, unknown>>(nodeId);
            const layout = await this.establishTableLayout(options.path, table);
            const columnAuditor = this.connectorUtilities.constructColumnAuditor(false, constructDeclaredColumnConfigs(layout));
            let recordCount = 0;
            let isComplete = true;
            const recordChunks = readRecordChunks(table, options.chunkSize ?? DEFAULT_AUDIT_CHUNK_SIZE);
            for await (const records of recordChunks) {
                signal.throwIfAborted();
                if (options.stopSignal?.aborted === true) {
                    isComplete = false;
                    break;
                }
                columnAuditor.auditRecords(records.map((record) => convertStoreRecordToParsedRecord(constructStoreRecord(record, layout))));
                recordCount += records.length;
                onProgress(records.length, 0);
            }
            const { columnConfigs } = columnAuditor.completeAudit();
            return {
                contentAuditConfig: {
                    asAt,
                    byteCount: 0,
                    columns: columnConfigs,
                    commentLineCount: undefined,
                    duration: performance.now() - startedAt,
                    emptyLineCount: undefined,
                    invalidFieldLengthCount: undefined,
                    isComplete,
                    lineCount: undefined,
                    recordCount,
                    sourceWaitDuration: undefined
                },
                hasHeaders: false // A table's columns are named by the database, not by a header record.
            };
        } catch (error) {
            throw normalizeToError(error);
        } finally {
            if (this.abortController === abortController) this.abortController = undefined;
        }
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
            newContainer.version(1).stores({ [nodeId]: constructTableSchema(options) });
        } else {
            const currentSchema: Record<string, string> = {};
            for (const { name, schema } of container.tables) {
                currentSchema[name] = [schema.primKey.src, ...schema.indexes.map((index) => index.src)].join(',');
            }
            newContainer.version(container.verno).stores(currentSchema);
            newContainer.version(container.verno + 1).stores({ [nodeId]: constructTableSchema(options) });
        }
        this.containers[containerId] = await newContainer.open();
        const objectsDatabase = await this.establishObjectsDatabase();
        await objectsDatabase.table<SavedObject>('objects').put({ columnConfigs: options.columnConfigs, path: options.path });
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
        } else {
            const currentSchema: Record<string, string> = {};
            for (const { name, schema } of container.tables) {
                currentSchema[name] = [schema.primKey.src, ...schema.indexes.map((index) => index.src)].join(',');
            }
            newContainer.version(container.verno).stores(currentSchema);
            newContainer.version(container.verno + 1).stores({ [nodeId]: null });
        }
        this.containers[containerId] = await newContainer.open();
        const objectsDatabase = await this.establishObjectsDatabase();
        await objectsDatabase.table<SavedObject>('objects').delete(options.path);
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
        const table = container.table<Record<string, unknown>>(nodeId);
        const record = await table.get(options.id);
        if (!record) throw new Error('Not found.');
        const layout = await this.establishTableLayout(options.path, table);
        return { record: constructStoreRecord(record, layout) };
    }

    // List nodes
    async listNodes(settings: ListNodesOptions): Promise<ListNodesResult> {
        const folderPathSegments = settings.folderPath.split('/');
        switch (folderPathSegments.length) {
            case 1: {
                if (folderPathSegments[0] != '') throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${settings.folderPath}'.`); // Invalid folder path if characters ahead of first separator.
                // Return list of database nodes for Dexie instance.
                const allDatabaseNames = await Dexie.getDatabaseNames();
                const databaseNames = allDatabaseNames.filter((name) => name !== OBJECTS_DATABASE_NAME);
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

    // A table's columns come from its saved or worked-out types, so nothing is detected and the user has nothing to choose.
    // The sample is shown as text, as a file's is.
    async previewObject(options: PreviewObjectOptions): Promise<PreviewObjectResult> {
        const asAt = Date.now();
        const startedAt = performance.now();
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);
        const table = container.table<Record<string, unknown>>(nodeId);
        const layout = await this.establishTableLayout(options.path, table);
        const records = await table.limit(PREVIEW_RECORD_COUNT).toArray();
        const totalCount = await table.count();
        const parsedRecords = records.map((record) => convertStoreRecordToParsedRecord(constructStoreRecord(record, layout)));
        const { columnConfigs } = this.connectorUtilities.inferDataTypes(parsedRecords, false, constructDeclaredColumnConfigs(layout));
        return {
            contentAuditConfig: {
                asAt,
                byteCount: 0,
                columns: columnConfigs,
                commentLineCount: undefined,
                duration: performance.now() - startedAt,
                emptyLineCount: undefined,
                invalidFieldLengthCount: undefined,
                isComplete: records.length === totalCount,
                lineCount: undefined,
                recordCount: records.length,
                sourceWaitDuration: undefined
            },
            sampleConfig: { hasHeaders: false, issues: [], parsedRecords, size: undefined, text: undefined },
            readingConfig: {
                dataFormatId: 'unknown', // A table is not a file, so it has no data format, encoding or delimiter.
                encodingConfidenceLevel: undefined,
                encodingId: undefined,
                fileType: undefined,
                hasHeaders: false,
                isDeclared: true,
                parserId: undefined,
                recordDelimiterId: undefined,
                valueDelimiterId: undefined
            }
        };
    }

    // Upsert records
    async upsertRecords(options: UpsertRecordsOptions): Promise<void> {
        if (options.records.length === 0) return;
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);
        const table = container.table<Record<string, unknown>>(nodeId);
        const layout = await this.establishTableLayout(options.path, table);
        await table.bulkPut(options.records.map((record) => constructRecordObject(record, layout)));
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
    async *retrieveRecords(options: RetrieveRecordsOptions): AsyncGenerator<RetrieveRecordsChunk, RetrieveRecordsSummary, undefined> {
        try {
            const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
            const container = await this.establishContainer(containerId);
            const table = container.table<Record<string, unknown>>(nodeId);
            const layout = await this.establishTableLayout(options.path, table);
            if (options.range == null) {
                const records = await table.toArray();
                yield { records: records.map((record) => constructStoreRecord(record, layout)), typeId: 'storeRecordArray' };
                return { recordCount: records.length };
            }
            const totalCount = await table.count();
            const records = await retrieveRecordRange(table, options.range, totalCount);
            yield { records: records.map((record) => constructStoreRecord(record, layout)), typeId: 'storeRecordArray' };
            return { recordCount: records.length, totalCount };
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

    private async establishObjectsDatabase(): Promise<Dexie> {
        let objectsDatabase = this.containers[OBJECTS_DATABASE_NAME];
        if (!objectsDatabase) {
            const database = new Dexie(OBJECTS_DATABASE_NAME);
            database.version(1).stores({ objects: 'path' });
            objectsDatabase = await database.open();
            this.containers[OBJECTS_DATABASE_NAME] = objectsDatabase;
        }
        return objectsDatabase;
    }

    // A table this connector created has its column types saved, and its fields are named by position. Any other
    // table's columns are worked out from its first records.
    private async establishTableLayout(path: string, table: Table<Record<string, unknown>, IndexableType>): Promise<TableLayout> {
        const objectsDatabase = await this.establishObjectsDatabase();
        const savedObject = await objectsDatabase.table<SavedObject>('objects').get(path);
        return savedObject
            ? { columnConfigs: savedObject.columnConfigs, fieldNames: savedObject.columnConfigs.map((_columnConfig, columnIndex) => constructFieldName(columnIndex)) }
            : inferTableLayout(await table.limit(INFERENCE_RECORD_COUNT).toArray());
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

// Column positions come from the caller, so each is checked before it names a field.
function checkColumnIndex(columnIndex: number, columnCount: number): number {
    if (!Number.isSafeInteger(columnIndex) || columnIndex < 0 || columnIndex >= columnCount) throw new Error(`Column ${String(columnIndex)} does not exist.`);
    return columnIndex;
}

// Fields are named by column position, because an audited column has a label but no id.
function constructFieldName(columnIndex: number): string {
    return `c${String(columnIndex)}`;
}

// The columns as their source states them, so the auditor and type inference take their types rather than working them
// out. A column with no known type is left for them to work out.
function constructDeclaredColumnConfigs(layout: TableLayout): DeclaredColumnConfig[] {
    return layout.columnConfigs.map((columnConfig, columnIndex) => ({
        dataSubtypeId: columnConfig.dataSubtypeId,
        dataTypeId: columnConfig.dataTypeId === 'unknown' ? undefined : columnConfig.dataTypeId,
        label: columnConfig.label.en,
        name: layout.fieldNames[columnIndex] ?? constructFieldName(columnIndex)
    }));
}

// A record as Dexie stores it, with a field for each column. Each value is kept only if it fits its column's type.
function constructRecordObject(record: StoreRecord, layout: TableLayout): Record<string, StoreValue> {
    if (record.length > layout.fieldNames.length) throw new Error(`A record has ${String(record.length)} values, but the table has ${String(layout.fieldNames.length)} columns.`);
    return Object.fromEntries(layout.fieldNames.map((fieldName, columnIndex) => [fieldName, toStoreValue(record[columnIndex], layout.columnConfigs[columnIndex])]));
}

// A stored record's values in column order, each as its column's type.
function constructStoreRecord(record: Record<string, unknown>, layout: TableLayout): StoreRecord {
    return layout.fieldNames.map((fieldName, columnIndex) => toStoreValue(record[fieldName], layout.columnConfigs[columnIndex]));
}

// Dexie's schema for a table lists its key first, then its indexes. With no key column, Dexie numbers the records as
// they are added. Dexie keeps no column types, so only the key and indexes are given.
function constructTableSchema(options: CreateObjectOptions): string {
    const columnCount = options.columnConfigs.length;
    const keySchema = options.keyColumnIndex == null ? '++' : constructFieldName(checkColumnIndex(options.keyColumnIndex, columnCount));
    const indexSchemas = options.indexedColumnIndexes
        .filter((columnIndex) => columnIndex !== options.keyColumnIndex)
        .map((columnIndex) => constructFieldName(checkColumnIndex(columnIndex, columnCount)));
    return [keySchema, ...indexSchemas].join(',');
}

// Every record of a table, a chunk at a time in key order. Each chunk starts after the last key of the one before, so a
// chunk far into the table is found as quickly as the first.
async function* readRecordChunks(table: Table<Record<string, unknown>, IndexableType>, chunkSize: number): AsyncGenerator<Record<string, unknown>[]> {
    let lastKey: IndexableType | undefined;
    for (;;) {
        const startKey = lastKey;
        const collection = (): ReturnType<typeof table.orderBy> => (startKey === undefined ? table.orderBy(':id') : table.where(':id').above(startKey)).limit(chunkSize);
        const records = await collection().toArray();
        if (records.length === 0) return;
        const keys = await collection().primaryKeys();
        lastKey = keys.at(-1);
        yield records;
        if (records.length < chunkSize) return;
    }
}

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

// The type each kind of stored value has. An object or list, which a store column cannot hold, is read as JSON text.
function identifyValueType(value: unknown): { dataSubtypeId: DataSubtypeId | undefined; dataTypeId: DataTypeId } {
    if (typeof value === 'boolean') return { dataSubtypeId: undefined, dataTypeId: 'boolean' };
    if (typeof value === 'bigint') return { dataSubtypeId: 'bigint', dataTypeId: 'numeric' };
    if (typeof value === 'number') return { dataSubtypeId: Number.isSafeInteger(value) ? 'integer' : 'decimal', dataTypeId: 'numeric' };
    if (value instanceof Date) return { dataSubtypeId: 'dateTime', dataTypeId: 'temporal' };
    if (typeof value === 'string') return { dataSubtypeId: 'plain', dataTypeId: 'string' };
    return { dataSubtypeId: 'json', dataTypeId: 'string' };
}

// A field whose values are all of one type takes that type, with whole numbers and decimals together as decimals. A
// field with values of several types is read as text, so none is lost. A field with no values has no known type.
function inferColumnConfig(fieldName: string, values: unknown[]): ObjectColumnConfig {
    const valueTypes = values.filter((value) => value != null).map((value) => identifyValueType(value));
    const dataTypeIds = new Set(valueTypes.map((valueType) => valueType.dataTypeId));
    const label = { en: fieldName };
    const [onlyDataTypeId] = dataTypeIds;
    if (onlyDataTypeId == null) return { dataSubtypeId: undefined, dataTypeId: 'unknown', label };
    if (dataTypeIds.size > 1) return { dataSubtypeId: 'plain', dataTypeId: 'string', label };
    const dataSubtypeIds = new Set(valueTypes.map((valueType) => valueType.dataSubtypeId));
    if (onlyDataTypeId === 'numeric' && dataSubtypeIds.has('decimal')) return { dataSubtypeId: 'decimal', dataTypeId: 'numeric', label };
    if (onlyDataTypeId === 'numeric' && dataSubtypeIds.has('bigint')) return { dataSubtypeId: 'bigint', dataTypeId: 'numeric', label };
    if (onlyDataTypeId === 'string' && dataSubtypeIds.size > 1) return { dataSubtypeId: 'plain', dataTypeId: 'string', label };
    return { dataSubtypeId: valueTypes[0]?.dataSubtypeId, dataTypeId: onlyDataTypeId, label };
}

// A table this connector did not create has no saved column types. Its fields are taken in the order they first appear
// in its first records, and each field's type is worked out from its values there.
function inferTableLayout(records: Record<string, unknown>[]): TableLayout {
    const fieldNames = [...new Set(records.flatMap((record) => Object.keys(record)))];
    return {
        columnConfigs: fieldNames.map((fieldName) =>
            inferColumnConfig(
                fieldName,
                records.map((record) => record[fieldName])
            )
        ),
        fieldNames
    };
}

// A value that does not fit its column's type is null, as in the other stores. A text column takes any value as text.
// eslint-disable-next-line sonarjs/function-return-type -- A store value is one of several types, by its column.
function toStoreValue(value: unknown, columnConfig: ObjectColumnConfig | undefined): StoreValue {
    if (value == null) return null;
    switch (columnConfig?.dataTypeId) {
        case 'boolean':
            return typeof value === 'boolean' ? value : null;
        case 'numeric':
            return typeof value === 'number' || typeof value === 'bigint' ? value : null;
        case 'temporal':
            return value instanceof Date ? value : null;
        case 'string':
            return convertToText(value);
        default:
            return null;
    }
}

// Text for a stored value. An object or list that cannot be written as JSON, such as one holding itself, is null, as is
// a value IndexedDB cannot hold in the first place.
function convertToText(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
    if (value instanceof Date) return value.toISOString();
    if (typeof value !== 'object' || value === null) return null;
    try {
        return JSON.stringify(value);
    } catch {
        return null;
    }
}
