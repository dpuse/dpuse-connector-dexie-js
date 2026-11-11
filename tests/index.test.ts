// ── External Dependencies & Registrations
import 'fake-indexeddb/auto'; // An in-memory IndexedDB for Node, loaded before Dexie so Dexie finds it.
import { Dexie } from 'dexie';
import type { AuditObjectContentOptions, ConnectorUtilities, CreateObjectOptions, ObjectColumnConfig, RetrieveRecordsChunk } from '@dpuse/dpuse-shared';
import type { RetrieveRecordsOptions, RetrieveRecordsSummary, StoreRecord } from '@dpuse/dpuse-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Local Framework
import { Connector } from '@/index';

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const DATABASE_NAME = 'test';
const PEOPLE_PATH = `/${DATABASE_NAME}/people`;
const RECORDS_PATH = `/${DATABASE_NAME}/records`; // A data view's records, keyed by a hidden number that counts up, as an audit stores them.

// Fields are named by column position: a person's id is 'c0' and their name 'c1'.
const PEOPLE_COLUMN_CONFIGS: ObjectColumnConfig[] = [
    { dataSubtypeId: undefined, dataTypeId: 'numeric', label: { en: 'Id' } },
    { dataSubtypeId: undefined, dataTypeId: 'string', label: { en: 'Name' } }
];

const RECORDS_COLUMN_CONFIGS: ObjectColumnConfig[] = [{ dataSubtypeId: 'integer', dataTypeId: 'numeric', label: { en: 'Value' } }];

// Each test's connectors, closed afterwards so their databases can be deleted.
const connectors: Connector[] = [];

// Type inference and the column auditor have their own tests, so here they only record what the connector hands them.
function createConnector(connectorUtilities: Partial<ConnectorUtilities> = {}): Connector {
    const connector = new Connector(connectorUtilities as ConnectorUtilities, []);
    connectors.push(connector);
    return connector;
}

async function createPeopleTable(connector: Connector): Promise<void> {
    await connector.createObject(buildCreateOptions({ keyColumnIndex: 0 }));
}

// A people table with no key or indexes, unless the test asks for them.
function buildCreateOptions(overrides: Partial<CreateObjectOptions> = {}): CreateObjectOptions {
    return { columnConfigs: PEOPLE_COLUMN_CONFIGS, indexedColumnIndexes: [], keyColumnIndex: undefined, path: PEOPLE_PATH, ...overrides };
}

async function createRecordsTable(connector: Connector): Promise<void> {
    await connector.createObject(buildCreateOptions({ columnConfigs: RECORDS_COLUMN_CONFIGS, path: RECORDS_PATH }));
}

// Stores records whose one value is 'firstValue', 'firstValue + 1' and so on, in that order.
async function fillRecordsTable(connector: Connector, count: number, firstValue = 0): Promise<void> {
    await connector.upsertRecords({ path: RECORDS_PATH, records: Array.from({ length: count }, (_, index) => [firstValue + index]) });
}

// Reads a retrieval through, keeping each chunk and the summary it ends with.
async function readRetrieval(connector: Connector, options: Partial<RetrieveRecordsOptions>): Promise<{ chunks: RetrieveRecordsChunk[]; summary: RetrieveRecordsSummary }> {
    const retrieval = connector.retrieveRecords(options as RetrieveRecordsOptions);
    const chunks: RetrieveRecordsChunk[] = [];
    let result = await retrieval.next();
    while (result.done !== true) {
        chunks.push(result.value);
        result = await retrieval.next();
    }
    return { chunks, summary: result.value };
}

async function retrieveRange(connector: Connector, offset: number, limit: number): Promise<{ totalCount: number | undefined; values: unknown[] }> {
    const { chunks, summary } = await readRetrieval(connector, { path: RECORDS_PATH, range: { limit, offset } });
    const values = chunks.flatMap((chunk) => (chunk.records as StoreRecord[]).map((record) => record[0]));
    return { totalCount: summary.totalCount, values };
}

// A table has no file settings, so only the path, the chunk size and the stop signal matter.
function buildAuditOptions(overrides: Partial<AuditObjectContentOptions> = {}): AuditObjectContentOptions {
    return {
        byteLimit: undefined,
        chunkSize: undefined,
        dataFormatId: 'unknown',
        encodingId: undefined,
        hasHeaders: false,
        parserId: undefined,
        path: RECORDS_PATH,
        stopSignal: undefined,
        supportsTransferableStreams: false,
        valueDelimiterId: undefined,
        ...overrides
    };
}

async function retrieveAll(connector: Connector, path = PEOPLE_PATH): Promise<StoreRecord[]> {
    const { chunks } = await readRetrieval(connector, { path });
    return chunks.flatMap((chunk) => chunk.records as StoreRecord[]);
}

describe('Connector', () => {
    afterEach(async () => {
        const containers = connectors.splice(0).flatMap((connector) => Object.values(connector.containers));
        for (const container of containers) container.close();
        const databaseNames = await Dexie.getDatabaseNames();
        for (const name of databaseNames) await Dexie.delete(name);
    });

    it('constructs with no open containers', () => {
        const connector = createConnector();
        expect(connector.containers).toEqual({});
    });

    it('abortOperation is a no-op when nothing is running', () => {
        const connector = createConnector();
        expect(() => {
            connector.abortOperation();
        }).not.toThrow();
    });

    describe('objects', () => {
        it('creates tables, lists them, finds them and drops them', async () => {
            const connector = createConnector();
            await connector.createObject(buildCreateOptions({ indexedColumnIndexes: [1] }));
            await connector.createObject(buildCreateOptions({ keyColumnIndex: 0, path: `/${DATABASE_NAME}/places` }));

            const tables = await connector.listNodes({ folderPath: `/${DATABASE_NAME}` });
            expect(tables.connectionNodeConfigs.map((node) => node.id).toSorted((a, b) => a.localeCompare(b))).toEqual(['people', 'places']);
            expect(tables.connectionNodeConfigs[0]).toEqual(expect.objectContaining({ folderPath: `/${DATABASE_NAME}`, typeId: 'object' }));
            expect(await connector.findObject({ storeId: DATABASE_NAME, nodeId: 'people' })).toEqual({ path: PEOPLE_PATH });

            await connector.dropObject({ path: PEOPLE_PATH });
            expect(await connector.findObject({ storeId: DATABASE_NAME, nodeId: 'people' })).toEqual({ path: undefined });

            await connector.dropObject({ path: `/${DATABASE_NAME}/places` });
            const emptied = await connector.listNodes({ folderPath: `/${DATABASE_NAME}` });
            expect(emptied.totalCount).toBe(0);
        });

        it('lists each database at the root', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);

            const result = await connector.listNodes({ folderPath: '' });

            expect(result.connectionNodeConfigs).toEqual([{ folderPath: '', id: DATABASE_NAME, label: DATABASE_NAME, name: DATABASE_NAME, typeId: 'folder' }]); // Not the database that keeps column types.
            expect(result.isMore).toBe(false);
        });

        it('keys a table by the key column, or by a number when there is none, and indexes the columns asked for', async () => {
            const connector = createConnector();
            await connector.createObject(buildCreateOptions({ indexedColumnIndexes: [0, 1], keyColumnIndex: 0 }));
            await createRecordsTable(connector);

            const container = connector.containers[DATABASE_NAME];
            const peopleSchema = container?.table('people').schema;
            const recordsSchema = container?.table('records').schema;
            expect(peopleSchema?.primKey.keyPath).toBe('c0');
            expect(peopleSchema?.indexes.map((index) => index.keyPath)).toEqual(['c1']);
            expect(recordsSchema?.primKey.auto).toBe(true);
        });

        it('rejects a key or index column that does not exist', async () => {
            const connector = createConnector();

            await expect(connector.createObject(buildCreateOptions({ keyColumnIndex: 2 }))).rejects.toThrow('Column 2 does not exist.');
            await expect(connector.createObject(buildCreateOptions({ indexedColumnIndexes: [-1] }))).rejects.toThrow('Column -1 does not exist.');
        });

        it('rejects a duplicate table and dropping a table that does not exist', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);

            await expect(createPeopleTable(connector)).rejects.toThrow("Duplicate table 'people'.");
            await expect(connector.dropObject({ path: `/${DATABASE_NAME}/missing` })).rejects.toThrow("Table 'missing' not found.");
        });

        it('rejects invalid folder paths, object paths and store identifiers', async () => {
            const connector = createConnector();

            await expect(connector.listNodes({ folderPath: 'x' })).rejects.toThrow("Encountered invalid folder path 'x'.");
            await expect(connector.listNodes({ folderPath: 'x/y' })).rejects.toThrow("Encountered invalid folder path 'x/y'.");
            await expect(connector.listNodes({ folderPath: '/a/b' })).rejects.toThrow("Encountered invalid folder path '/a/b'.");
            await expect(connector.getRecord({ path: '/only-database', id: 1 })).rejects.toThrow("Encountered invalid object path '/only-database'.");
            await expect(connector.findObject({ storeId: undefined, nodeId: 'people' })).rejects.toThrow("Encountered invalid container identifier 'undefined'.");
        });
    });

    describe('records', () => {
        it('upserts one or many records, gets one, and fails for one that is missing', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);

            await connector.upsertRecords({ path: PEOPLE_PATH, records: [[1, 'Ada']] });
            await connector.upsertRecords({
                path: PEOPLE_PATH,
                records: [
                    [2, 'Grace'],
                    [1, 'Ada Lovelace']
                ]
            });
            await connector.upsertRecords({ path: PEOPLE_PATH, records: [] });

            expect(await connector.getRecord({ path: PEOPLE_PATH, id: 1 })).toEqual({ record: [1, 'Ada Lovelace'] });
            await expect(connector.getRecord({ path: PEOPLE_PATH, id: 99 })).rejects.toThrow('Not found.');
        });

        it('removes one record, several records, or all of them', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);
            await connector.upsertRecords({ path: PEOPLE_PATH, records: [[1], [2], [3], [4]] });

            await connector.removeRecords({ path: PEOPLE_PATH, keys: [1] }); // Numbers, which the keys are stored as, not their text.
            await connector.removeRecords({ path: PEOPLE_PATH, keys: [2, 3] });
            expect(await retrieveAll(connector)).toEqual([[4, null]]);

            await connector.removeRecords({ path: PEOPLE_PATH, keys: [] });
            expect(await retrieveAll(connector)).toEqual([]);
        });

        it('retrieves every record as one chunk, then reports the count', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);
            await connector.upsertRecords({
                path: PEOPLE_PATH,
                records: [
                    [1, 'Ada'],
                    [2, 'Grace']
                ]
            });

            const { chunks, summary } = await readRetrieval(connector, { path: PEOPLE_PATH });

            expect(chunks).toEqual([
                {
                    records: [
                        [1, 'Ada'],
                        [2, 'Grace']
                    ],
                    typeId: 'storeRecordArray'
                }
            ]);
            expect(summary).toEqual({ recordCount: 2 });
        });

        it("retrieves the records at a range of positions, wherever it lies, with the table's total", async () => {
            const connector = createConnector();
            await createRecordsTable(connector);
            await fillRecordsTable(connector, 250);

            const firstBlock = await retrieveRange(connector, 0, 100);
            const lastBlock = await retrieveRange(connector, 200, 100);
            const middle = await retrieveRange(connector, 120, 3);

            expect(firstBlock.values).toEqual(Array.from({ length: 100 }, (_, index) => index));
            expect(firstBlock.totalCount).toBe(250);
            expect(lastBlock.values).toEqual(Array.from({ length: 50 }, (_, index) => 200 + index));
            expect(middle.values).toEqual([120, 121, 122]);
        });

        it('finds the right records after the table was emptied and filled again, when its numbers no longer start at 1', async () => {
            const connector = createConnector();
            await createRecordsTable(connector);
            await fillRecordsTable(connector, 10);
            await connector.removeRecords({ keys: [], path: RECORDS_PATH });
            await fillRecordsTable(connector, 10, 100);

            expect(await retrieveRange(connector, 5, 3)).toEqual({ totalCount: 10, values: [105, 106, 107] });
        });

        it('steps through the records when their numbers have a gap', async () => {
            const connector = createConnector();
            await createRecordsTable(connector);
            await fillRecordsTable(connector, 10);
            await connector.containers[DATABASE_NAME]?.table<Record<string, unknown>>('records')
                .filter((record) => record['c0'] === 2)
                .delete();

            expect(await retrieveRange(connector, 2, 2)).toEqual({ totalCount: 9, values: [3, 4] });
        });

        it('returns no records for a range past the end, still with the total', async () => {
            const connector = createConnector();
            await createRecordsTable(connector);
            await fillRecordsTable(connector, 10);

            expect(await retrieveRange(connector, 10, 5)).toEqual({ totalCount: 10, values: [] });
        });

        it("keeps a value only if it fits its column's type, and rejects a record with more values than columns", async () => {
            const connector = createConnector();
            await connector.createObject(buildCreateOptions());

            await connector.upsertRecords({ path: PEOPLE_PATH, records: [['one', 2]] });

            expect(await retrieveAll(connector)).toEqual([[null, '2']]); // A text column takes any value as text.
            await expect(connector.upsertRecords({ path: PEOPLE_PATH, records: [[1, 'Ada', true]] })).rejects.toThrow('A record has 3 values, but the table has 2 columns.');
        });

        it('works out the columns of a table it did not create from the records in it', async () => {
            const foreignDatabase = new Dexie('foreign');
            foreignDatabase.version(1).stores({ things: 'code' });
            await foreignDatabase.table('things').bulkAdd([
                { code: 'a', size: 1, mixed: 1, when: new Date(0) },
                { code: 'b', size: 2.5, mixed: 'two', tags: ['x'] }
            ]);
            foreignDatabase.close();
            const connector = createConnector();

            expect(await retrieveAll(connector, '/foreign/things')).toEqual([
                ['a', 1, '1', new Date(0), null],
                ['b', 2.5, 'two', null, '["x"]']
            ]);
        });

        it('wraps a retrieval failure in a connector error', async () => {
            const connector = createConnector();

            await expect(readRetrieval(connector, { path: 'bad' })).rejects.toThrow("Failed to access Dexie table with path 'bad'.");
        });

        it("previews a table's first records as text, with its saved column types and nothing to choose", async () => {
            const inferredColumnConfigs = [{ id: 'inferred' }];
            const inferDataTypes = vi.fn().mockReturnValue({ columnConfigs: inferredColumnConfigs, hasHeaders: false });
            const connector = createConnector({ inferDataTypes });
            await createPeopleTable(connector);
            await connector.upsertRecords({ path: PEOPLE_PATH, records: [[1, 'Ada']] });

            const { contentAuditConfig, readingConfig, sampleConfig } = await connector.previewObject({ path: PEOPLE_PATH } as never);

            const parsedRecords = [
                [
                    { value: '1', valueWasQuoted: false },
                    { value: 'Ada', valueWasQuoted: false }
                ]
            ];
            expect(inferDataTypes).toHaveBeenCalledWith(parsedRecords, false, [
                { dataSubtypeId: undefined, dataTypeId: 'numeric', label: 'Id', name: 'c0' },
                { dataSubtypeId: undefined, dataTypeId: 'string', label: 'Name', name: 'c1' }
            ]);
            expect(sampleConfig.parsedRecords).toEqual(parsedRecords);
            expect(contentAuditConfig).toMatchObject({ columns: inferredColumnConfigs, isComplete: true, recordCount: 1 });
            expect(readingConfig).toMatchObject({ encodingId: undefined, hasHeaders: false, isDeclared: true, valueDelimiterId: undefined });
        });
    });

    describe('auditObjectContent', () => {
        it('audits every record a chunk at a time, as text, against its column types', async () => {
            const columnAuditor = { auditRecords: vi.fn(), completeAudit: vi.fn().mockReturnValue({ columnConfigs: [{ id: 'audited' }], hasHeaders: false }) };
            const constructColumnAuditor = vi.fn().mockReturnValue(columnAuditor);
            const connector = createConnector({ constructColumnAuditor });
            await createRecordsTable(connector);
            await fillRecordsTable(connector, 25);
            const onProgress = vi.fn();

            const { contentAuditConfig, hasHeaders } = await connector.auditObjectContent(buildAuditOptions({ chunkSize: 10 }), onProgress);

            expect(constructColumnAuditor).toHaveBeenCalledWith(false, [{ dataSubtypeId: 'integer', dataTypeId: 'numeric', label: 'Value', name: 'c0' }]);
            expect(columnAuditor.auditRecords).toHaveBeenCalledTimes(3);
            expect(columnAuditor.auditRecords.mock.calls[2]?.[0]).toEqual(Array.from({ length: 5 }, (_, index) => [{ value: String(20 + index), valueWasQuoted: false }]));
            expect(onProgress.mock.calls).toEqual([
                [10, 0],
                [10, 0],
                [5, 0]
            ]);
            expect(contentAuditConfig).toMatchObject({ columns: [{ id: 'audited' }], isComplete: true, recordCount: 25 });
            expect(hasHeaders).toBe(false);
        });

        it('keeps what it has audited when told to stop', async () => {
            const columnAuditor = { auditRecords: vi.fn(), completeAudit: vi.fn().mockReturnValue({ columnConfigs: [], hasHeaders: false }) };
            const connector = createConnector({ constructColumnAuditor: vi.fn().mockReturnValue(columnAuditor) });
            await createRecordsTable(connector);
            await fillRecordsTable(connector, 5);
            const stopController = new AbortController();
            stopController.abort();

            const { contentAuditConfig } = await connector.auditObjectContent(buildAuditOptions({ stopSignal: stopController.signal }), vi.fn());

            expect(columnAuditor.auditRecords).not.toHaveBeenCalled();
            expect(contentAuditConfig).toMatchObject({ isComplete: false, recordCount: 0 });
        });
    });
});
