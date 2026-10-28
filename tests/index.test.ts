// ── External Dependencies & Registrations
import 'fake-indexeddb/auto'; // An in-memory IndexedDB for Node, loaded before Dexie so Dexie finds it.
import { Dexie } from 'dexie';
import type { RetrieveRecordsSummary } from '@dpuse/dpuse-shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

// ── Local Framework
import { Connector } from '@/index';

// ── Tests ────────────────────────────────────────────────────────────────────────────────────────────────────────────

const DATABASE_NAME = 'test';
const PEOPLE_PATH = `/${DATABASE_NAME}/people`;
const RECORDS_PATH = `/${DATABASE_NAME}/records`; // A data view's records, keyed by a hidden number that counts up, as an audit stores them.

// Each test's connectors, closed afterwards so their databases can be deleted.
const connectors: Connector[] = [];

function createConnector(): Connector {
    const connector = new Connector({} as never, []);
    connectors.push(connector);
    return connector;
}

async function createPeopleTable(connector: Connector): Promise<void> {
    await connector.createObject({ path: PEOPLE_PATH, structure: 'id' });
}

// Stores records whose 'c1' is 'firstValue', 'firstValue + 1' and so on, in that order.
async function fillRecordsTable(connector: Connector, count: number, firstValue = 0): Promise<void> {
    await connector.upsertRecords({ path: RECORDS_PATH, records: Array.from({ length: count }, (_, index) => ({ c1: firstValue + index })) });
}

async function retrieveRange(connector: Connector, offset: number, limit: number): Promise<{ totalCount: number | undefined; values: unknown[] }> {
    const values: unknown[] = [];
    let totalCount: number | undefined;
    await connector.retrieveRecords(
        { path: RECORDS_PATH, range: { limit, offset } } as never,
        (_typeId, records) => {
            values.push(...records.map((record) => record['c1']));
        },
        (summary) => {
            totalCount = summary.totalCount;
        }
    );
    return { totalCount, values };
}

async function retrieveAll(connector: Connector): Promise<Record<string, unknown>[]> {
    const retrieved: Record<string, unknown>[] = [];
    await connector.retrieveRecords(
        { path: PEOPLE_PATH } as never,
        (_typeId, records) => {
            retrieved.push(...records);
        },
        vi.fn()
    );
    return retrieved;
}

describe('Connector', () => {
    afterEach(async () => {
        const containers = connectors.splice(0).flatMap((connector) => Object.values(connector.containers));
        for (const container of containers) container.close();
        const databaseNames = await Dexie.getDatabaseNames();
        for (const name of databaseNames) await Dexie.delete(name);
    });

    it('constructs with the static config and no active operation', () => {
        const connector = createConnector();
        expect(connector.config.id).toBe('dpuse-connector-dexie-js');
        expect(connector.abortController).toBeUndefined();
        expect(connector.containers).toEqual({});
    });

    it('aborts a running operation and clears it, and does nothing when none is running', () => {
        const connector = createConnector();
        expect(() => {
            connector.abortOperation();
        }).not.toThrow();

        const abortController = new AbortController();
        connector.abortController = abortController;
        connector.abortOperation();
        expect(abortController.signal.aborted).toBe(true);
        expect(connector.abortController).toBeUndefined();
    });

    describe('objects', () => {
        it('creates tables, lists them, finds them and drops them', async () => {
            const connector = createConnector();
            await connector.createObject({ path: PEOPLE_PATH, structure: '++id,name' });
            await connector.createObject({ path: `/${DATABASE_NAME}/places`, structure: 'code' });

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

            expect(result.connectionNodeConfigs).toContainEqual({ folderPath: '', id: DATABASE_NAME, label: DATABASE_NAME, name: DATABASE_NAME, typeId: 'folder' });
            expect(result.isMore).toBe(false);
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
            await expect(connector.getRecord({ path: '/only-database', id: 1 } as never)).rejects.toThrow("Encountered invalid object path '/only-database'.");
            await expect(connector.findObject({ storeId: undefined, nodeId: 'people' })).rejects.toThrow("Encountered invalid container identifier 'undefined'.");
        });
    });

    describe('records', () => {
        it('upserts one or many records, gets one, and fails for one that is missing', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);

            await connector.upsertRecords({ path: PEOPLE_PATH, records: [{ id: 1, name: 'Ada' }] });
            await connector.upsertRecords({
                path: PEOPLE_PATH,
                records: [
                    { id: 2, name: 'Grace' },
                    { id: 1, name: 'Ada Lovelace' }
                ]
            });
            await connector.upsertRecords({ path: PEOPLE_PATH, records: [] });

            expect(await connector.getRecord({ path: PEOPLE_PATH, id: 1 } as never)).toEqual({ record: { id: 1, name: 'Ada Lovelace' } });
            await expect(connector.getRecord({ path: PEOPLE_PATH, id: 99 } as never)).rejects.toThrow('Not found.');
        });

        it('removes one record, several records, or all of them', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);
            await connector.upsertRecords({ path: PEOPLE_PATH, records: [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }] });

            await connector.removeRecords({ path: PEOPLE_PATH, keys: ['a'] });
            await connector.removeRecords({ path: PEOPLE_PATH, keys: ['b', 'c'] });
            expect(await retrieveAll(connector)).toEqual([{ id: 'd' }]);

            await connector.removeRecords({ path: PEOPLE_PATH, keys: [] });
            expect(await retrieveAll(connector)).toEqual([]);
        });

        it('retrieves every record as one chunk, then reports the count', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);
            await connector.upsertRecords({ path: PEOPLE_PATH, records: [{ id: 1 }, { id: 2 }] });
            const chunk = vi.fn();
            const complete = vi.fn<(result: RetrieveRecordsSummary) => void>();

            await connector.retrieveRecords({ path: PEOPLE_PATH } as never, chunk, complete);

            expect(chunk).toHaveBeenCalledWith('jsonRecordArray', [{ id: 1 }, { id: 2 }]);
            expect(complete).toHaveBeenCalledWith(expect.objectContaining({ recordCount: 2 }));
        });

        it("retrieves the records at a range of positions, wherever it lies, with the table's total", async () => {
            const connector = createConnector();
            await connector.createObject({ path: RECORDS_PATH, structure: '++' });
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
            await connector.createObject({ path: RECORDS_PATH, structure: '++' });
            await fillRecordsTable(connector, 10);
            await connector.removeRecords({ keys: [], path: RECORDS_PATH });
            await fillRecordsTable(connector, 10, 100);

            expect(await retrieveRange(connector, 5, 3)).toEqual({ totalCount: 10, values: [105, 106, 107] });
        });

        it('steps through the records when their numbers have a gap', async () => {
            const connector = createConnector();
            await connector.createObject({ path: RECORDS_PATH, structure: '++' });
            await fillRecordsTable(connector, 10);
            await connector.containers[DATABASE_NAME]?.table<Record<string, unknown>>('records')
                .filter((record) => record['c1'] === 2)
                .delete();

            expect(await retrieveRange(connector, 2, 2)).toEqual({ totalCount: 9, values: [3, 4] });
        });

        it('returns no records for a range past the end, still with the total', async () => {
            const connector = createConnector();
            await connector.createObject({ path: RECORDS_PATH, structure: '++' });
            await fillRecordsTable(connector, 10);

            expect(await retrieveRange(connector, 10, 5)).toEqual({ totalCount: 10, values: [] });
        });

        it('wraps a retrieval failure in a connector error', async () => {
            const connector = createConnector();

            await expect(connector.retrieveRecords({ path: 'bad' } as never, vi.fn(), vi.fn())).rejects.toThrow("Failed to access Dexie table with path 'bad'.");
            expect(connector.abortController).toBeUndefined();
        });

        it('previews a table with an unknown data format', async () => {
            const connector = createConnector();
            await createPeopleTable(connector);

            const preview = await connector.previewObject({ path: PEOPLE_PATH } as never);

            expect(preview.dataFormatId).toBe('unknown');
            expect(preview.columnConfigs).toEqual([]);
        });
    });
});
