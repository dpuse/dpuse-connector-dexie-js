// ── External Dependencies & Registrations
import 'fake-indexeddb/auto'; // An in-memory IndexedDB for Node, loaded before Dexie so Dexie finds it.
import { Dexie } from 'dexie';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── DPUse Framework
import type { StoreRecord } from '@dpuse/dpuse-shared';
import type { AuditObjectContentOptions, ConnectorActionName, ConnectorUtilities, CreateObjectOptions, LoadObjectRecordsOptions } from '@dpuse/dpuse-shared';
import type { ObjectColumnConfig, QueryRecordsOptions, RetrieveRecordsChunk, RetrieveRecordsOptions, RetrieveRecordsSummary } from '@dpuse/dpuse-shared';

// ── Local Framework
import config from '~/config.json';
import { Connector } from '@/index';
import { name as packageName } from '~/package.json';

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────────

interface Action {
    name: string;
    start: (connector: Connector, signal?: AbortSignal) => Promise<unknown>; // 'signal' stands in for the one the engine adds to a request the app names.
}

// ── Constants ────────────────────────────────────────────────────────────────────────────────────────────────────────

const DATABASE_NAME = 'test';
const PEOPLE_PATH = `/${DATABASE_NAME}/people`;
const RECORDS_PATH = `/${DATABASE_NAME}/records`; // Records numbered as they are added, as an audit reads them.

// Fields are named by column position: a person's id is 'c0' and their name 'c1'.
const PEOPLE_COLUMN_CONFIGS: ObjectColumnConfig[] = [
    { dataSubtypeId: undefined, dataTypeId: 'numeric', label: { en: 'Id' } },
    { dataSubtypeId: undefined, dataTypeId: 'string', label: { en: 'Name' } }
];
const RECORDS_COLUMN_CONFIGS: ObjectColumnConfig[] = [{ dataSubtypeId: 'integer', dataTypeId: 'numeric', label: { en: 'Value' } }];

// Every action a connector may implement. Typed as a record of 'ConnectorActionName', so the file stops compiling when
// dpuse-shared adds an action until it is listed here.
const CONNECTOR_ACTION_NAMES = Object.keys({
    auditObjectContent: true,
    closeStore: true,
    createObject: true,
    describeConnection: true,
    dropObject: true,
    findObject: true,
    getInfo: true,
    getObject: true,
    getReadableStream: true,
    getRecord: true,
    indexObjectStructure: true,
    listNodes: true,
    listObjectStructureEntries: true,
    loadObjectRecords: true,
    openStore: true,
    previewObject: true,
    queryRecords: true,
    removeRecords: true,
    retrieveRecords: true,
    upsertRecords: true
} satisfies Record<ConnectorActionName, true>);

// The actions that take the request's signal, each started on a table that exists, so only the abort can stop it.
const SIGNALLED_ACTIONS: Action[] = [
    {
        name: 'auditObjectContent',
        start: async (connector, signal) => {
            await createRecordsTable(connector);
            await fillRecordsTable(connector, 5);
            return connector.auditObjectContent(buildAuditOptions({ signal }), vi.fn());
        }
    },
    {
        name: 'loadObjectRecords',
        start: async (connector, signal) => {
            await connector.openStore();
            return connector.loadObjectRecords(buildLoadOptions({ signal }), yieldChunks([[[1]]]));
        }
    }
];

// Every action, each asked for something it cannot do, in the order a user meets them.
const FAILING_ACTIONS: Action[] = [
    { name: 'listNodes', start: (connector) => connector.listNodes({ folderPath: 'x' }) },
    { name: 'findObject', start: (connector) => connector.findObject({ id: '/bad' }) },
    { name: 'previewObject', start: (connector) => connector.previewObject({ path: 'bad' } as never) },
    { name: 'retrieveRecords', start: (connector) => readRetrieval(connector, buildRetrieveOptions({ path: 'bad' })) },
    { name: 'auditObjectContent', start: (connector) => connector.auditObjectContent(buildAuditOptions({ path: 'bad' }), vi.fn()) },
    { name: 'createObject', start: (connector) => connector.createObject(buildCreateOptions({ path: 'bad' })) },
    { name: 'dropObject', start: (connector) => connector.dropObject({ path: '/bad' }) },
    { name: 'getRecord', start: (connector) => connector.getRecord({ id: 1, path: 'bad' }) },
    { name: 'upsertRecords', start: (connector) => connector.upsertRecords({ path: 'bad', records: [[1]] }) },
    { name: 'removeRecords', start: (connector) => connector.removeRecords({ keys: [], path: 'bad' }) },
    { name: 'loadObjectRecords', start: (connector) => connector.loadObjectRecords(buildLoadOptions(), yieldChunks([])) },
    { name: 'queryRecords', start: (connector) => connector.queryRecords(buildQueryOptions()) }
];

// ── State ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const connectors: Connector[] = []; // Each test's connectors, closed afterwards so their databases can be deleted.

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('Connector', () => {
    afterEach(async () => {
        vi.unstubAllGlobals();
        const containers = connectors.splice(0).flatMap((connector) => Object.values(connector.containers));
        for (const container of containers) container.close();
        const databaseNames = await Dexie.getDatabaseNames();
        for (const name of databaseNames) await Dexie.delete(name);
    });

    // The app reads 'config.json' to decide which actions it can ask the connector for.
    describe('config', () => {
        it('lists exactly the actions the connector implements', () => {
            const connector = createConnector() as unknown as Record<string, unknown>;
            const implementedActionNames = CONNECTOR_ACTION_NAMES.filter((actionName) => typeof connector[actionName] === 'function');

            expect(new Set(config.actionNames)).toEqual(new Set(implementedActionNames));
        });

        it('is identified by the package name, without its scope', () => {
            expect(`@dpuse/${config.id}`).toBe(packageName);
        });
    });

    // The engine gives each request the app names a signal of its own, so each can be stopped without touching another.
    describe('abort', () => {
        it.each(SIGNALLED_ACTIONS)('stops $name when its request is aborted', async ({ start }) => {
            const connector = createConnector({ constructColumnAuditor: vi.fn().mockReturnValue({ auditRecords: vi.fn(), completeAudit: vi.fn() }) });
            const abortController = new AbortController();
            abortController.abort(new Error('Aborted.'));

            await expect(start(connector, abortController.signal)).rejects.toThrow('Aborted.');
        });
    });

    // The app expects every failure as an 'Error', so it can show and report it.
    describe('failures', () => {
        it.each(FAILING_ACTIONS)('passes on a failure in $name as an Error', async ({ start }) => {
            await expect(start(createConnector())).rejects.toBeInstanceOf(Error);
        });
    });

    describe('listNodes', () => {
        it('lists each database at the root', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);

            const result = await connector.listNodes({ folderPath: '' });

            expect(result.connectionNodeConfigs).toEqual([{ folderPath: '', id: DATABASE_NAME, label: DATABASE_NAME, name: DATABASE_NAME, typeId: 'folder' }]);
            expect(result.isMore).toBe(false);
        });

        it("lists a database's tables", async () => {
            const connector = createConnector();
            await createPeopleTable(connector);
            await createRecordsTable(connector);

            const result = await connector.listNodes({ folderPath: `/${DATABASE_NAME}` });

            expect(result.connectionNodeConfigs.map((node) => node.id).toSorted((left, right) => left.localeCompare(right))).toEqual(['people', 'records']);
            expect(result.connectionNodeConfigs[0]).toEqual(expect.objectContaining({ folderPath: `/${DATABASE_NAME}`, typeId: 'object' }));
        });

        it('opens a database once and keeps it for later calls', async () => {
            const connector = createConnector();
            await connector.listNodes({ folderPath: `/${DATABASE_NAME}` });
            const firstContainer = connector.containers[DATABASE_NAME];

            await connector.listNodes({ folderPath: `/${DATABASE_NAME}` });

            expect(connector.containers[DATABASE_NAME]).toBe(firstContainer);
        });

        it('rejects an invalid folder path', async () => {
            const connector = createConnector();

            await expect(connector.listNodes({ folderPath: 'x' })).rejects.toThrow("Encountered invalid folder path 'x'.");
            await expect(connector.listNodes({ folderPath: 'x/y' })).rejects.toThrow("Encountered invalid folder path 'x/y'.");
            await expect(connector.listNodes({ folderPath: '/a/b' })).rejects.toThrow("Encountered invalid folder path '/a/b'.");
        });
    });

    describe('findObject', () => {
        it('gives back the path of a table that exists, and throws for one that does not', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);

            expect(await connector.findObject({ id: PEOPLE_PATH })).toEqual({ path: PEOPLE_PATH });
            await expect(connector.findObject({ id: `/${DATABASE_NAME}/missing` })).rejects.toThrow(`Object '/${DATABASE_NAME}/missing' not found.`);
        });

        it('finds a table named on its own in the default store database', async () => {
            const connector = await openStoreConnector();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([[[1]]]));

            expect(await connector.findObject({ id: 'dataView1' })).toEqual({ path: 'dataView1' });
        });

        it('throws for a table in a database that does not exist, without creating the database', async () => {
            await expect(createConnector().findObject({ id: '/missing/people' })).rejects.toThrow("Object '/missing/people' not found.");
            expect(await Dexie.exists('missing')).toBe(false);
        });
    });

    describe('previewObject', () => {
        it("previews a table's first records as text, with column types worked out from its values and nothing to choose", async () => {
            const inferredColumnConfigs = [{ id: 'inferred' }];
            const inferDataTypes = vi.fn().mockReturnValue({ columnConfigs: inferredColumnConfigs, hasHeaders: false });
            const connector = createConnector({ inferDataTypes });
            await createPeopleTable(connector);
            await connector.upsertRecords({ path: PEOPLE_PATH, records: [[1, 'Ada']] });

            const { contentAuditConfig, readingConfig, sampleConfig } = await connector.previewObject({ path: PEOPLE_PATH } as never);

            const parsedRecords = [
                ['1', 'Ada']
            ];
            expect(inferDataTypes).toHaveBeenCalledWith(
                parsedRecords,
                false,
                [
                    { dataSubtypeId: 'integer', dataTypeId: 'numeric', label: 'c0', name: 'c0' },
                    { dataSubtypeId: 'plain', dataTypeId: 'string', label: 'c1', name: 'c1' }
                ],
                true // The sample is the whole table.
            );
            expect(sampleConfig.parsedRecords).toEqual(parsedRecords);
            expect(contentAuditConfig).toMatchObject({ columns: inferredColumnConfigs, isComplete: true, recordCount: 1 });
            expect(readingConfig).toMatchObject({ encodingId: undefined, hasHeaders: false, isDeclared: true, valueDelimiterId: undefined });
        });

        it("previews a loaded table's first records", async () => {
            const inferDataTypes = vi.fn().mockReturnValue({ columnConfigs: [{ id: 'c0' }], hasHeaders: false });
            const connector = createConnector({ inferDataTypes });
            await connector.openStore();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([numberRecords(0, 60)]));

            const { contentAuditConfig, sampleConfig } = await connector.previewObject({ path: '/dpuse-store/dataView1' } as never);

            expect(sampleConfig.parsedRecords).toEqual(Array.from({ length: 50 }, (_, index) => [String(index)]));
            expect(contentAuditConfig).toMatchObject({ isComplete: false, recordCount: 50 });
            expect(inferDataTypes.mock.calls[0]?.[2]).toEqual([{ dataSubtypeId: 'integer', dataTypeId: 'numeric', label: 'c0', name: 'c0' }]);
            expect(inferDataTypes.mock.calls[0]?.[3]).toBe(false); // The table holds more records than the sample.
        });

        it('rejects an invalid path', async () => {
            await expect(createConnector().previewObject({ path: 'bad' } as never)).rejects.toThrow("Encountered invalid object path 'bad'.");
        });
    });

    describe('retrieveRecords', () => {
        it('retrieves every record typed, with the count of every record, then reports the count', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);
            await connector.upsertRecords({
                path: PEOPLE_PATH,
                records: [
                    [1, 'Ada'],
                    [2, 'Grace']
                ]
            });

            const { chunks, summary } = await readRetrieval(connector, buildRetrieveOptions());

            expect(chunks).toEqual([
                {
                    records: [
                        [1, 'Ada'],
                        [2, 'Grace']
                    ],
                    totalRecordCount: 2,
                    typeId: 'storeRecordArray'
                }
            ]);
            expect(summary).toEqual({ recordCount: 2 });
        });

        it('retrieves a chunk at a time, each with the count of every record', async () => {
            const connector = createConnector();
            await createRecordsTable(connector);
            await fillRecordsTable(connector, 5);

            const { chunks, summary } = await readRetrieval(connector, buildRetrieveOptions({ chunkSize: 2, path: RECORDS_PATH }));

            expect(chunks).toEqual([
                { records: [[0], [1]], totalRecordCount: 5, typeId: 'storeRecordArray' },
                { records: [[2], [3]], totalRecordCount: 5, typeId: 'storeRecordArray' },
                { records: [[4]], totalRecordCount: 5, typeId: 'storeRecordArray' }
            ]);
            expect(summary).toEqual({ recordCount: 5 });
        });

        it('retrieves a loaded table a chunk at a time, in the order it was loaded', async () => {
            const connector = await openStoreConnector();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([numberRecords(0, 1500), numberRecords(1500, 1000)]));

            const { chunks, summary } = await readRetrieval(connector, buildRetrieveOptions({ chunkSize: 1000, path: '/dpuse-store/dataView1' }));

            expect(chunks.map((chunk) => [chunk.records.length, chunk.typeId === 'storeRecordArray' ? chunk.totalRecordCount : undefined])).toEqual([
                [1000, 2500],
                [1000, 2500],
                [500, 2500]
            ]);
            expect(chunks.flatMap((chunk) => chunk.records)).toEqual(numberRecords(0, 2500));
            expect(summary).toEqual({ recordCount: 2500 });
        });

        it('works out the columns of a table it did not create from the records in it', async () => {
            const foreignDatabase = new Dexie('foreign');
            foreignDatabase.version(1).stores({ things: 'code' });
            await foreignDatabase.table('things').bulkAdd([
                { code: 'a', mixed: 1, size: 1, when: new Date(0) },
                { code: 'b', mixed: 'two', size: 2.5, tags: ['x'] }
            ]);
            foreignDatabase.close();

            expect(await retrieveAll(createConnector(), '/foreign/things')).toEqual([
                ['a', '1', 1, new Date(0), null], // 'mixed' holds a number and text, so it is read as text.
                ['b', 'two', 2.5, null, '["x"]']
            ]);
        });

        it('wraps a failure in a connector error naming the path', async () => {
            await expect(readRetrieval(createConnector(), buildRetrieveOptions({ path: 'bad' }))).rejects.toThrow("Failed to access Dexie table with path 'bad'.");
        });
    });

    describe('auditObjectContent', () => {
        it('audits every record a chunk at a time, as text, against column types worked out from its values', async () => {
            const columnAuditor = { auditRecords: vi.fn(), completeAudit: vi.fn().mockReturnValue({ columnConfigs: [{ id: 'audited' }], hasHeaders: false }) };
            const constructColumnAuditor = vi.fn().mockReturnValue(columnAuditor);
            const connector = createConnector({ constructColumnAuditor });
            await createRecordsTable(connector);
            await fillRecordsTable(connector, 25);
            const onProgress = vi.fn();

            const { contentAuditConfig, hasHeaders } = await connector.auditObjectContent(buildAuditOptions({ chunkSize: 10 }), onProgress);

            expect(constructColumnAuditor).toHaveBeenCalledWith(false, [{ dataSubtypeId: 'integer', dataTypeId: 'numeric', label: 'c0', name: 'c0' }]);
            expect(columnAuditor.auditRecords).toHaveBeenCalledTimes(3);
            expect(columnAuditor.auditRecords.mock.calls[2]?.[0]).toEqual(Array.from({ length: 5 }, (_, index) => [String(20 + index)]));
            expect(onProgress.mock.calls).toEqual([
                [10, 0, 25],
                [10, 0, 25],
                [5, 0, 25]
            ]);
            expect(contentAuditConfig).toMatchObject({ columns: [{ id: 'audited' }], isComplete: true, recordCount: 25 });
            expect(hasHeaders).toBe(false);
        });

        it('audits a loaded table a chunk at a time, with the count of every record', async () => {
            const columnAuditor = { auditRecords: vi.fn(), completeAudit: vi.fn().mockReturnValue({ columnConfigs: [], hasHeaders: false }) };
            const constructColumnAuditor = vi.fn().mockReturnValue(columnAuditor);
            const connector = createConnector({ constructColumnAuditor });
            await connector.openStore();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([numberRecords(0, 2500)]));
            const onProgress = vi.fn();

            const { contentAuditConfig } = await connector.auditObjectContent(buildAuditOptions({ chunkSize: 1000, path: '/dpuse-store/dataView1' }), onProgress);

            expect(constructColumnAuditor).toHaveBeenCalledWith(false, [{ dataSubtypeId: 'integer', dataTypeId: 'numeric', label: 'c0', name: 'c0' }]);
            expect(columnAuditor.auditRecords.mock.calls[2]?.[0]).toEqual(Array.from({ length: 500 }, (_, index) => [String(2000 + index)]));
            expect(onProgress.mock.calls).toEqual([
                [1000, 0, 2500],
                [1000, 0, 2500],
                [500, 0, 2500]
            ]);
            expect(contentAuditConfig).toMatchObject({ isComplete: true, recordCount: 2500 });
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

    describe('createObject', () => {
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

        it('creates every table when several are created at once in the same database', async () => {
            const connector = createConnector();

            await Promise.all([createPeopleTable(connector), createRecordsTable(connector), connector.createObject(buildCreateOptions({ path: `/${DATABASE_NAME}/places` }))]);

            expect(connector.containers[DATABASE_NAME]?.tables.map((table) => table.name).toSorted((left, right) => left.localeCompare(right))).toEqual([
                'people',
                'places',
                'records'
            ]);
        });

        it('rejects a key or index column that does not exist, and a table that already exists', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);

            await expect(connector.createObject(buildCreateOptions({ keyColumnIndex: 2, path: `/${DATABASE_NAME}/other` }))).rejects.toThrow('Column 2 does not exist.');
            await expect(connector.createObject(buildCreateOptions({ indexedColumnIndexes: [-1], path: `/${DATABASE_NAME}/other` }))).rejects.toThrow('Column -1 does not exist.');
            await expect(createPeopleTable(connector)).rejects.toThrow("Duplicate table 'people'.");
        });
    });

    describe('dropObject', () => {
        it('drops a table, leaving the database empty once its last table goes', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);

            await connector.dropObject({ path: PEOPLE_PATH });

            const tables = await connector.listNodes({ folderPath: `/${DATABASE_NAME}` });
            await expect(connector.findObject({ id: PEOPLE_PATH })).rejects.toThrow(`Object '${PEOPLE_PATH}' not found.`);
            expect(tables.totalCount).toBe(0);
        });

        it('does nothing for a table that does not exist, as the SQL stores do', async () => {
            await expect(createConnector().dropObject({ path: `/${DATABASE_NAME}/missing` })).resolves.toBeUndefined();
        });
    });

    describe('getRecord', () => {
        it('gets a record by its key, typed by its columns', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);
            await connector.upsertRecords({ path: PEOPLE_PATH, records: [[1, 'Ada']] });

            expect(await connector.getRecord({ id: 1, path: PEOPLE_PATH })).toEqual({ record: [1, 'Ada'] });
        });

        it('gets a record of a loaded table by its number, counted from 1', async () => {
            const connector = await openStoreConnector();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([numberRecords(10, 1200)]));

            expect(await connector.getRecord({ id: 1, path: '/dpuse-store/dataView1' })).toEqual({ record: [10] });
            expect(await connector.getRecord({ id: 1200, path: '/dpuse-store/dataView1' })).toEqual({ record: [1209] });
            await expect(connector.getRecord({ id: 0, path: '/dpuse-store/dataView1' })).rejects.toThrow('Not found.');
            await expect(connector.getRecord({ id: 1201, path: '/dpuse-store/dataView1' })).rejects.toThrow('Not found.');
        });

        it('fails for a record that does not exist, and for an invalid path', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);

            await expect(connector.getRecord({ id: 99, path: PEOPLE_PATH })).rejects.toThrow('Not found.');
            await expect(connector.getRecord({ id: 1, path: '/only-database' })).rejects.toThrow("Encountered invalid object path '/only-database'.");
        });
    });

    describe('upsertRecords', () => {
        it('adds records, replaces one with the same key, and ignores an empty list', async () => {
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

            expect(await retrieveAll(connector)).toEqual([
                [1, 'Ada Lovelace'],
                [2, 'Grace']
            ]);
        });

        it('refuses to add to or change a loaded table, whose records are packed', async () => {
            const connector = await openStoreConnector();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([[[1]]]));

            await expect(connector.upsertRecords({ path: '/dpuse-store/dataView1', records: [[2]] })).rejects.toThrow(
                "'/dpuse-store/dataView1' is a loaded table, so records cannot be added to it or changed."
            );
        });

        it('stores values as given, and rejects a record with more values than the table has columns', async () => {
            const connector = createConnector();
            await connector.createObject(buildCreateOptions());

            await connector.upsertRecords({ path: PEOPLE_PATH, records: [['one', 2]] });

            expect(await retrieveAll(connector)).toEqual([['one', 2]]);
            await expect(connector.upsertRecords({ path: PEOPLE_PATH, records: [[1, 'Ada', true]] })).rejects.toThrow('A record has 3 values, but the table has 2 columns.');
        });
    });

    describe('removeRecords', () => {
        it('removes one record, several records, or all of them', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);
            await connector.upsertRecords({ path: PEOPLE_PATH, records: [[1], [2], [3], [4]] });

            await connector.removeRecords({ keys: [1], path: PEOPLE_PATH }); // Numbers, which the keys are stored as, not their text.
            await connector.removeRecords({ keys: [2, 3], path: PEOPLE_PATH });
            expect(await retrieveAll(connector)).toEqual([[4]]);

            await connector.removeRecords({ keys: [], path: PEOPLE_PATH });
            expect(await retrieveAll(connector)).toEqual([]);
        });

        it('removes every record of a loaded table, but refuses to remove some of them', async () => {
            const connector = await openStoreConnector();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([[[1], [2]]]));

            await expect(connector.removeRecords({ keys: [1], path: '/dpuse-store/dataView1' })).rejects.toThrow(
                "'/dpuse-store/dataView1' is a loaded table, so its records cannot be removed one at a time."
            );
            await connector.removeRecords({ keys: [], path: '/dpuse-store/dataView1' });

            expect(await connector.queryRecords(buildQueryOptions())).toEqual({ records: [], totalCount: 0 });
        });

        it('rejects an invalid path', async () => {
            await expect(createConnector().removeRecords({ keys: [], path: 'bad' })).rejects.toThrow("Encountered invalid object path 'bad'.");
        });
    });

    describe('openStore', () => {
        it('opens the store, which every tab can use at once', async () => {
            await expect(createConnector().openStore()).resolves.toEqual({ storeStateId: 'ready' });
        });

        it('says the store is unavailable where the browser gives no IndexedDB', async () => {
            vi.stubGlobal('indexedDB', undefined);

            await expect(createConnector().openStore()).resolves.toEqual({ storeStateId: 'unavailable' });
        });
    });

    describe('loadObjectRecords', () => {
        it("loads typed records into a table of the default store database named by the data view's id", async () => {
            const connector = await openStoreConnector();

            const result = await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([[[1], [2]], [[3]]]));

            const queried = await connector.queryRecords(buildQueryOptions());
            const tables = await connector.listNodes({ folderPath: '/dpuse-store' });
            expect(result).toEqual({ recordCount: 3 });
            expect(queried.records).toEqual([[1], [2], [3]]);
            expect(tables.connectionNodeConfigs.map((node) => node.id)).toEqual(['dataView1']); // A loaded data view is a table like any other.
        });

        it('stores the records packed, many to an entry, however the source hands them over', async () => {
            const connector = await openStoreConnector();

            const result = await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([numberRecords(0, 700), numberRecords(700, 1500), numberRecords(2200, 300)]));

            const entries = await connector.containers['dpuse-store']?.table('dataView1').toArray();
            expect(result).toEqual({ recordCount: 2500 });
            expect(entries?.map((entry: { firstRecordIndex: number; records: unknown[] }) => [entry.firstRecordIndex, entry.records.length])).toEqual([
                [0, 1000],
                [1000, 1000],
                [2000, 500]
            ]);
        });

        it('keeps a value only if it fits its column, and rejects a record with more values than there are columns', async () => {
            const connector = await openStoreConnector();

            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([[[1], ['two'], [null], []]]));

            expect(await connector.queryRecords(buildQueryOptions())).toEqual({ records: [[1], [null], [null], [null]], totalCount: 4 });
            await expect(connector.loadObjectRecords(buildLoadOptions(), yieldChunks([[[1, 2]]]))).rejects.toThrow('A record has 2 values, but the table has 1 columns.');
        });

        it('loads into a database named in the path', async () => {
            const connector = await openStoreConnector();

            await connector.loadObjectRecords(buildLoadOptions({ path: '/archive/dataView1' }), yieldChunks([[[7]]]));

            expect(await retrieveAll(connector, '/archive/dataView1')).toEqual([[7]]);
        });

        it('replaces a table of the same name, so it holds only the new records', async () => {
            const connector = await openStoreConnector();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([[[1], [2]]]));

            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([[[5]]]));

            const queried = await connector.queryRecords(buildQueryOptions());
            expect(queried).toEqual({ records: [[5]], totalCount: 1 });
        });

        it('passes on a failure in the source, leaving the new table for the app to drop', async () => {
            const connector = await openStoreConnector();
            const failingChunks = yieldChunks([[[8]]], new Error('Source failed.'));

            await expect(connector.loadObjectRecords(buildLoadOptions(), failingChunks)).rejects.toThrow('Source failed.');
            await connector.dropObject({ path: 'dataView1' });
            await expect(connector.queryRecords(buildQueryOptions())).rejects.toThrow("'dataView1' has not been loaded.");
        });

        it('refuses to load until the store is open', async () => {
            await expect(createConnector().loadObjectRecords(buildLoadOptions(), yieldChunks([]))).rejects.toThrow('The store is not open.');
        });
    });

    describe('queryRecords', () => {
        it('reads a page straight from the table, with the count of every record', async () => {
            const connector = await openStoreConnector();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([[[1], [2], [3], [4]]]));

            const result = await connector.queryRecords(buildQueryOptions({ limit: 2, offset: 1 }));

            expect(result).toEqual({ records: [[2], [3]], totalCount: 4 });
        });

        it('reads a page that runs from one entry of a loaded table into the next', async () => {
            const connector = await openStoreConnector();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([numberRecords(0, 2500)]));

            expect(await connector.queryRecords(buildQueryOptions({ limit: 4, offset: 998 }))).toEqual({ records: [[998], [999], [1000], [1001]], totalCount: 2500 });
            expect(await connector.queryRecords(buildQueryOptions({ limit: 10, offset: 2498 }))).toEqual({ records: [[2498], [2499]], totalCount: 2500 });
            expect(await connector.queryRecords(buildQueryOptions({ limit: 10, offset: 2500 }))).toEqual({ records: [], totalCount: 2500 });
        });

        it('still reads a table loaded before loads were packed, which has an entry for each record', async () => {
            const earlierDatabase = new Dexie('dpuse-store');
            earlierDatabase.version(1).stores({ dataView1: '++' });
            await earlierDatabase.table('dataView1').bulkAdd([{ c0: 1 }, { c0: 2 }, { c0: 2 }, { c0: 3 }]);
            earlierDatabase.close();
            const connector = await openStoreConnector();

            expect(await connector.queryRecords(buildQueryOptions({ limit: 2, offset: 1 }))).toEqual({ records: [[2], [2]], totalCount: 4 });
            expect(await connector.queryRecords(buildQueryOptions({ filters: [{ columnIndex: 0, operatorId: 'greaterThan', value: 1 }] }))).toEqual({
                records: [[2], [2], [3]],
                totalCount: 3
            });
        });

        it('filters, groups and sorts in memory for any other query', async () => {
            const connector = await openStoreConnector();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([[[1], [2], [2], [3]]]));

            const result = await connector.queryRecords(
                buildQueryOptions({
                    aggregates: [{ columnIndex: undefined, functionId: 'count' }],
                    filters: [{ columnIndex: 0, operatorId: 'greaterThan', value: 1 }],
                    groupColumnIndexes: [0],
                    sorts: [{ columnIndex: 1, directionId: 'descending' }]
                })
            );

            expect(result).toEqual({
                records: [
                    [2, 2],
                    [3, 1]
                ],
                totalCount: 2
            });
        });

        it('fails for a table that has not been loaded, and until the store is open', async () => {
            const connector = await openStoreConnector();

            await expect(connector.queryRecords(buildQueryOptions({ path: 'missing' }))).rejects.toThrow("'missing' has not been loaded.");
            await expect(createConnector().queryRecords(buildQueryOptions())).rejects.toThrow('The store is not open.');
        });
    });

    describe('closeStore', () => {
        it('closes every database and refuses store actions until the store opens again', async () => {
            const connector = await openStoreConnector();
            await connector.loadObjectRecords(buildLoadOptions(), yieldChunks([[[1]]]));

            await connector.closeStore();

            expect(connector.containers).toEqual({});
            await expect(connector.queryRecords(buildQueryOptions())).rejects.toThrow('The store is not open.');
            await connector.openStore();
            const queried = await connector.queryRecords(buildQueryOptions());
            expect(queried.records).toEqual([[1]]);
        });
    });
});

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────

// Type inference and the column auditor have their own tests, so here they only record what the connector hands them.
function createConnector(connectorUtilities: Partial<ConnectorUtilities> = {}): Connector {
    const connector = new Connector(connectorUtilities as ConnectorUtilities, []);
    connectors.push(connector);
    return connector;
}

async function openStoreConnector(): Promise<Connector> {
    const connector = createConnector();
    await connector.openStore();
    return connector;
}

async function createPeopleTable(connector: Connector): Promise<void> {
    await connector.createObject(buildCreateOptions({ keyColumnIndex: 0 }));
}

async function createRecordsTable(connector: Connector): Promise<void> {
    await connector.createObject(buildCreateOptions({ columnConfigs: RECORDS_COLUMN_CONFIGS, path: RECORDS_PATH }));
}

// Stores records whose one value is 0, 1 and so on, in that order.
async function fillRecordsTable(connector: Connector, count: number): Promise<void> {
    await connector.upsertRecords({ path: RECORDS_PATH, records: Array.from({ length: count }, (_, index) => [index]) });
}

// Records whose one value counts up from 'firstValue', so a wrong or missing record shows.
function numberRecords(firstValue: number, recordCount: number): StoreRecord[] {
    return Array.from({ length: recordCount }, (_, index) => [firstValue + index]);
}

// A people table with no key or indexes, unless the test asks for them.
function buildCreateOptions(overrides: Partial<CreateObjectOptions> = {}): CreateObjectOptions {
    return { columnConfigs: PEOPLE_COLUMN_CONFIGS, indexedColumnIndexes: [], keyColumnIndex: undefined, path: PEOPLE_PATH, ...overrides };
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

// A data view's load, named by its id alone, so it goes to the default store database.
function buildLoadOptions(overrides: Partial<LoadObjectRecordsOptions> = {}): LoadObjectRecordsOptions {
    return { columnConfigs: RECORDS_COLUMN_CONFIGS, path: 'dataView1', ...overrides };
}

// The query brings the columns the table was loaded with, as the app does.
function buildQueryOptions(overrides: Partial<QueryRecordsOptions> = {}): QueryRecordsOptions {
    return { aggregates: [], columnConfigs: RECORDS_COLUMN_CONFIGS, filters: [], groupColumnIndexes: [], limit: 100, offset: 0, path: 'dataView1', sorts: [], ...overrides };
}

function buildRetrieveOptions(overrides: Partial<RetrieveRecordsOptions> = {}): RetrieveRecordsOptions {
    return { chunkSize: undefined, dataFormatId: 'unknown', encodingId: undefined, parserId: undefined, path: PEOPLE_PATH, valueDelimiterId: undefined, ...overrides };
}

// Reads a retrieval through, keeping each chunk and the summary it ends with.
async function readRetrieval(connector: Connector, options: RetrieveRecordsOptions): Promise<{ chunks: RetrieveRecordsChunk[]; summary: RetrieveRecordsSummary }> {
    const retrieval = connector.retrieveRecords(options);
    const chunks: RetrieveRecordsChunk[] = [];
    let result = await retrieval.next();
    while (result.done !== true) {
        chunks.push(result.value);
        result = await retrieval.next();
    }
    return { chunks, summary: result.value };
}

async function retrieveAll(connector: Connector, path = PEOPLE_PATH): Promise<StoreRecord[]> {
    const { chunks } = await readRetrieval(connector, buildRetrieveOptions({ path }));
    return chunks.flatMap((chunk) => chunk.records as StoreRecord[]);
}

// A source's chunks, handed over a turn apart as a source reading a stream does, failing after the last when 'failure'
// is given.
async function* yieldChunks(chunks: StoreRecord[][], failure?: Error): AsyncGenerator<StoreRecord[]> {
    for (const chunk of chunks) {
        await Promise.resolve();
        yield chunk;
    }
    if (failure != null) throw failure;
}
