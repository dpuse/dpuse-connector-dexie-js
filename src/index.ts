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
    LoadObjectRecordsOptions,
    LoadObjectRecordsResult,
    ObjectColumnConfig,
    OpenStoreResult,
    PreviewObjectOptions,
    PreviewObjectResult,
    QueryRecordsOptions,
    QueryRecordsResult,
    RemoveRecordsOptions,
    RetrieveRecordsChunk,
    RetrieveRecordsOptions,
    RetrieveRecordsSummary,
    StoreRecord,
    StoreValue,
    ToolConfig,
    UpsertRecordsOptions
} from '@dpuse/dpuse-shared';
import { ConnectorError, convertStoreRecordToParsedRecord, normalizeToError, resolveRequestSignal } from '@dpuse/dpuse-shared';

// ── Local Framework
import { checkCount, queryStoreRecords } from '@/dexieStore';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

// The connector keeps each database it has opened, by name.
interface ExtendedConnectorInterface extends ConnectorInterface {
    containers: Record<string, Dexie>;
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

// A store path that names no database, such as a data view's id, uses this database.
const DEFAULT_STORE_DATABASE_NAME = 'dpuse-store';

const INFERENCE_RECORD_COUNT = 100; // Records read to work out a table's columns from its values.
const PREVIEW_RECORD_COUNT = 50;
const DEFAULT_AUDIT_CHUNK_SIZE = 10_000;

// ── Connectors ───────────────────────────────────────────────────────────────────────────────────────────────────────

// Reads and writes IndexedDB databases through Dexie, and keeps data views for investigation as a store. Every tab can
// open the same database, so the store is never held by one tab.
export class Connector implements ExtendedConnectorInterface {
    private readonly connectorUtilities: ConnectorUtilities;
    private readonly schemaChanges: Map<string, Promise<unknown>>; // Each database's latest schema change, which the next one waits for.
    private storeIsOpen: boolean;
    private readonly toolConfigs;
    containers: Record<string, Dexie>;

    constructor(connectorUtilities: ConnectorUtilities, toolConfigs: ToolConfig[]) {
        this.connectorUtilities = connectorUtilities;
        this.schemaChanges = new Map();
        this.storeIsOpen = false;
        this.toolConfigs = toolConfigs;
        this.containers = {};
    }

    // ── Actions ──────────────────────────────────────────────────────────────────────────────────────────────────────

    // A table's columns already have types, so the audit counts its values against them rather than working types out.
    // The auditor reads text, so each typed record is handed over as text. A table has no bytes, so 'byteLimit' does
    // not apply, and the audit reads every record unless 'stopSignal' fires.
    async auditObjectContent(options: AuditObjectContentOptions, onProgress: (recordCount: number, byteCount: number) => void): Promise<AuditObjectContentResult> {
        const signal = resolveRequestSignal(options);
        try {
            const asAt = Date.now();
            const startedAt = performance.now();
            const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
            const container = await this.establishContainer(containerId);
            const table = container.table<Record<string, unknown>>(nodeId);
            const layout = await establishTableLayout(table);
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
        }
    }

    // Closes every database, so a schema change made in another tab is not held up waiting for this one.
    closeStore(): Promise<void> {
        this.storeIsOpen = false;
        for (const container of Object.values(this.containers)) container.close();
        this.containers = {};
        return Promise.resolve();
    }

    async createObject(options: CreateObjectOptions): Promise<void> {
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        await this.runSchemaChange(containerId, async () => {
            const container = await this.establishContainer(containerId);
            if (container.tables.some((table) => table.name === nodeId)) throw new Error(`Duplicate table '${nodeId}'.`);
            await this.changeSchema(containerId, nodeId, constructTableSchema(options));
        });
    }

    // Drops a table this connector created, or one a store load wrote. A store names a table on its own when it is in the
    // default store database. A table that does not exist is already gone, as in the SQL stores.
    async dropObject(options: DropObjectOptions): Promise<void> {
        const { containerId, nodeId } = this.resolveObjectIdentifiers(options.path);
        await this.runSchemaChange(containerId, async () => {
            const container = await this.establishContainer(containerId);
            if (container.tables.every((table) => table.name !== nodeId)) return;
            await this.changeSchema(containerId, nodeId, null);
        });
    }

    async findObject(options: FindObjectOptions): Promise<FindObjectResult> {
        if (options.storeId == null) throw new Error(`${ERROR_INVALID_CONTAINER_ID} '${String(options.storeId)}'.`);
        const container = await this.establishContainer(options.storeId);
        const isObjectFound = container.tables.some((table) => table.name === options.nodeId);
        return { path: isObjectFound ? `/${options.storeId}/${options.nodeId}` : undefined };
    }

    async getRecord(options: GetRecordOptions): Promise<GetRecordResult> {
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);
        const table = container.table<Record<string, unknown>>(nodeId);
        const layout = await establishTableLayout(table);
        const record = await table.get(options.id);
        if (!record) throw new Error('Not found.');
        return { record: constructStoreRecord(record, layout) };
    }

    async listNodes(settings: ListNodesOptions): Promise<ListNodesResult> {
        const folderPathSegments = settings.folderPath.split('/');
        switch (folderPathSegments.length) {
            case 1: {
                if (folderPathSegments[0] != '') throw new Error(`${ERROR_INVALID_FOLDER_PATH} '${settings.folderPath}'.`); // Invalid folder path if characters ahead of first separator.
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

    // Fills a table with the records given, typed by the columns given. The app names a new table for every load, so an
    // earlier load stays in its own table until the app drops it, and a failed load leaves only its own table to drop. A
    // table already holding the name is replaced.
    async loadObjectRecords(options: LoadObjectRecordsOptions, chunks: AsyncIterable<StoreRecord[]>): Promise<LoadObjectRecordsResult> {
        const signal = resolveRequestSignal(options);
        try {
            this.establishOpenStore();
            const { containerId, nodeId } = this.resolveObjectIdentifiers(options.path);
            await this.runSchemaChange(containerId, async () => {
                const container = await this.establishContainer(containerId);
                if (container.tables.some((table) => table.name === nodeId)) await this.changeSchema(containerId, nodeId, null);
                await this.changeSchema(containerId, nodeId, '++');
            });
            const container = await this.establishContainer(containerId);
            const table = container.table<Record<string, unknown>>(nodeId);
            const layout = constructTableLayout(options.columnConfigs);
            let recordCount = 0;
            for await (const records of chunks) {
                signal.throwIfAborted();
                await table.bulkAdd(records.map((record) => constructRecordObject(record, layout)));
                recordCount += records.length;
            }
            signal.throwIfAborted();
            return { recordCount };
        } catch (error) {
            throw normalizeToError(error);
        }
    }

    // IndexedDB lets every tab open the same database, so no tab holds the store for itself and 'heldElsewhere' never
    // applies. Some private windows refuse IndexedDB, which leaves the store unavailable.
    async openStore(): Promise<OpenStoreResult> {
        if (typeof indexedDB === 'undefined') return { storeStateId: 'unavailable' };
        try {
            await this.establishContainer(DEFAULT_STORE_DATABASE_NAME);
        } catch {
            return { storeStateId: 'unavailable' };
        }
        this.storeIsOpen = true;
        return { storeStateId: 'ready' };
    }

    // A table's columns are worked out from its values, so nothing is detected and the user has nothing to choose. The
    // sample is shown as text, as a file's is.
    async previewObject(options: PreviewObjectOptions): Promise<PreviewObjectResult> {
        const asAt = Date.now();
        const startedAt = performance.now();
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);
        const table = container.table<Record<string, unknown>>(nodeId);
        const layout = await establishTableLayout(table);
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

    // The query brings the columns the table was loaded with. A page with no filters, groups or sorts is read straight from
    // the table. Any other query reads the whole table and is answered in memory, because IndexedDB cannot filter, group
    // or sort as SQL does.
    async queryRecords(options: QueryRecordsOptions): Promise<QueryRecordsResult> {
        try {
            this.establishOpenStore();
            const { containerId, nodeId } = this.resolveObjectIdentifiers(options.path);
            const container = await this.establishContainer(containerId);
            if (container.tables.every((table) => table.name !== nodeId)) throw new Error(`'${options.path}' has not been loaded.`);
            const table = container.table<Record<string, unknown>>(nodeId);
            const layout = constructTableLayout(options.columnConfigs);
            if (options.filters.length === 0 && options.groupColumnIndexes.length === 0 && options.sorts.length === 0) {
                const pageRecords = await table.offset(checkCount(options.offset)).limit(checkCount(options.limit)).toArray();
                const totalCount = await table.count();
                return { records: pageRecords.map((record) => constructStoreRecord(record, layout)), totalCount };
            }
            const records = await table.toArray();
            return queryStoreRecords(
                records.map((record) => constructStoreRecord(record, layout)),
                layout.columnConfigs.length,
                options
            );
        } catch (error) {
            throw normalizeToError(error);
        }
    }

    // No keys removes every record.
    async removeRecords(options: RemoveRecordsOptions): Promise<void> {
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);
        const keys = options.keys;
        if (keys.length === 0) {
            await container.table(nodeId).clear();
        } else if (keys.length === 1 && keys[0] != null) {
            await container.table(nodeId).delete(keys[0]);
        } else {
            await container.table(nodeId).bulkDelete(keys);
        }
    }

    // Retrieves every record of the table, typed by its columns.
    async *retrieveRecords(options: RetrieveRecordsOptions): AsyncGenerator<RetrieveRecordsChunk, RetrieveRecordsSummary, undefined> {
        try {
            const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
            const container = await this.establishContainer(containerId);
            const table = container.table<Record<string, unknown>>(nodeId);
            const layout = await establishTableLayout(table);
            const records = await table.toArray();
            yield { records: records.map((record) => constructStoreRecord(record, layout)), typeId: 'storeRecordArray' };
            return { recordCount: records.length };
        } catch (error) {
            throw new ConnectorError(`Failed to access Dexie table with path '${options.path}'.`, 'dpuse-connector-dexie-js.Connector.retrieveRecords', { cause: error });
        }
    }

    // No column types are kept, so each value is stored as given. A table with records takes them into the fields worked
    // out from those records. An empty table takes them by position.
    async upsertRecords(options: UpsertRecordsOptions): Promise<void> {
        if (options.records.length === 0) return;
        const { containerId, nodeId } = this.establishObjectIdentifiers(options.path);
        const container = await this.establishContainer(containerId);
        const table = container.table<Record<string, unknown>>(nodeId);
        const { fieldNames } = await establishTableLayout(table);
        await table.bulkPut(
            options.records.map((record) => {
                if (fieldNames.length > 0 && record.length > fieldNames.length)
                    throw new Error(`A record has ${String(record.length)} values, but the table has ${String(fieldNames.length)} columns.`);
                return Object.fromEntries(record.map((value, columnIndex) => [fieldNames[columnIndex] ?? constructFieldName(columnIndex), value]));
            })
        );
    }

    // ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────

    // Adds a table, or removes it when 'schema' is null. Dexie changes a schema by closing the database and opening it
    // again at the next version. A database left with no tables is deleted and started again at version 1.
    private async changeSchema(containerId: string, nodeId: string, schema: string | null): Promise<void> {
        const container = await this.establishContainer(containerId);
        container.close();
        const newContainer = new Dexie(container.name);
        newContainer.on('blocked', () => false); // Silence console warning of blocked event
        const isLastTable = container.tables.length === 0 || (schema == null && container.tables.length === 1);
        if (isLastTable) {
            await container.delete();
            newContainer.version(1).stores(schema == null ? {} : { [nodeId]: schema });
        } else {
            const currentSchema: Record<string, string> = {};
            for (const { name, schema: tableSchema } of container.tables) {
                currentSchema[name] = [tableSchema.primKey.src, ...tableSchema.indexes.map((index) => index.src)].join(',');
            }
            newContainer.version(container.verno).stores(currentSchema);
            newContainer.version(container.verno + 1).stores({ [nodeId]: schema });
        }
        this.containers[containerId] = await newContainer.open();
    }

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

    private establishOpenStore(): void {
        if (!this.storeIsOpen) throw new Error('The store is not open.');
    }

    // A store names a table in the default store database on its own, such as a data view's id. Any other path names its
    // database too, as '/database/table'.
    private resolveObjectIdentifiers(path: string): { containerId: string; nodeId: string } {
        return path.startsWith('/') ? this.establishObjectIdentifiers(path) : { containerId: DEFAULT_STORE_DATABASE_NAME, nodeId: path };
    }

    // Changing a schema closes the database and opens it again at the next version. Two changes made together would both
    // start from the same version, so each waits for the one before it on the same database.
    private async runSchemaChange(containerId: string, change: () => Promise<void>): Promise<void> {
        const previousChange = this.schemaChanges.get(containerId);
        const currentChange = (async (): Promise<void> => {
            try {
                await previousChange;
            } catch {
                // A failed change does not stop the next one. Its caller has its error.
            }
            await change();
        })();
        this.schemaChanges.set(containerId, currentChange);
        try {
            await currentChange;
        } finally {
            if (this.schemaChanges.get(containerId) === currentChange) this.schemaChanges.delete(containerId);
        }
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

// A table's fields are named by column position, so the columns given name every field.
function constructTableLayout(columnConfigs: ObjectColumnConfig[]): TableLayout {
    return { columnConfigs, fieldNames: columnConfigs.map((_columnConfig, columnIndex) => constructFieldName(columnIndex)) };
}

// IndexedDB keeps each value's JavaScript type but not a column's type, so a table's columns are worked out from its
// first records.
async function establishTableLayout(table: Table<Record<string, unknown>, IndexableType>): Promise<TableLayout> {
    return inferTableLayout(await table.limit(INFERENCE_RECORD_COUNT).toArray());
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

// No column types are kept, so a table's fields are taken in the order they first appear in its first records, and each
// field's type is worked out from its values there.
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
